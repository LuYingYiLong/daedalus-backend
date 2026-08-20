import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getToolExecutionLedgerPath } from "../app-paths.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { MAX_TOOL_RESULT_CHARS } from "./llm-tool-budget.js";
import { resolveToolMapping } from "./tool-mapping.js";
import { getToolPolicy } from "./tool-policy.js";
import { captureFileEditBatchDraft, type FileEditBatchDraft } from "./file-edit-snapshots.js";
import { logger } from "../logger.js";
import type { ImageGenerationResult } from "../providers/image-generation.js";
import type { ProviderToolImageReference } from "../providers/tool-image-reference.js";
import { stripApprovalReasonArg } from "./approval-reason.js";
import type { TerminalCommandAuthorization } from "../mcp/terminal/authorization.js";
import type { McpProgressNotification } from "../mcp/terminal/progress.js";
import { createSourceScopedWorkspace, findWorkspace } from "../workspace/registry.js";

const TOOL_EXECUTION_DEDUP_TTL_MS: number = 30 * 60 * 1000;
const MAX_COMPLETED_TOOL_EXECUTIONS: number = 500;

type ToolResultContent = {
	content: Array<{ type: string; text?: string }>;
};

type ToolExecutionRecord = {
	fingerprint: string;
	scope: string;
	llmToolName: string;
	serverId: string;
	toolName: string;
	argsHash: string;
	content: string;
	rawContentLength: number;
	truncated: boolean;
	createdAt: string;
	expiresAt: string;
};

export type IdempotentToolExecutionResult = {
	content: string;
	rawContentLength: number;
	truncated: boolean;
	reused: boolean;
	fingerprint?: string | undefined;
	fileEditDraft?: FileEditBatchDraft | undefined;
	imageGeneration?: ImageGenerationResult | undefined;
	imageReferences?: ProviderToolImageReference[] | undefined;
};

type ToolExecutionIdentity = {
	fingerprint: string;
	scope: string;
	serverId: string;
	toolName: string;
	argsHash: string;
};

const completedToolExecutions: Map<string, ToolExecutionRecord> = new Map();
const inFlightToolExecutions: Map<string, Promise<IdempotentToolExecutionResult>> = new Map();

let ledgerLoadPromise: Promise<void> | null = null;
let ledgerWriteQueue: Promise<void> = Promise.resolve();

const GODOT_PROJECT_MUTATION_TOOLS: ReadonlySet<string> = new Set([
	"mcp_image_import_to_workspace",
	"mcp_image_replace_workspace_asset",
	"mcp_workspace_create_text_file",
	"mcp_workspace_overwrite_text_file",
	"mcp_workspace_replace_text_in_file",
	"mcp_workspace_replace_line_in_file",
	"mcp_workspace_download_file",
	"mcp_workspace_delete_file",
	"mcp_godot_set_project_setting",
	"mcp_godot_unset_project_setting",
	"mcp_godot_set_input_action",
	"mcp_godot_unset_input_action",
	"mcp_godot_set_autoload",
	"mcp_godot_unset_autoload",
	"mcp_godot_create_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_delete_file",
	"mcp_godot_create_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch"
]);

const GODOT_PROJECT_SETTINGS_MUTATION_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_set_project_setting",
	"mcp_godot_unset_project_setting",
	"mcp_godot_set_input_action",
	"mcp_godot_unset_input_action",
	"mcp_godot_set_autoload",
	"mcp_godot_unset_autoload"
]);

function normalizeForStableJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item: unknown): unknown => normalizeForStableJson(item));
	}

	if (value !== null && typeof value === "object") {
		const record: Record<string, unknown> = value as Record<string, unknown>;
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			normalized[key] = normalizeForStableJson(record[key]);
		}
		return normalized;
	}

	if (value === undefined) {
		return null;
	}

	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(normalizeForStableJson(value));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function trimToolResult(text: string): string {
	if (text.length <= MAX_TOOL_RESULT_CHARS) {
		return text;
	}

	return text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[结果已截断，原始长度 ${text.length} 字符]`;
}

function extractTextContent(result: ToolResultContent): string {
	const firstContent = result.content[0];
	if (firstContent !== undefined && firstContent.text !== undefined) {
		return firstContent.text;
	}

	return JSON.stringify(result);
}

function isRecordExpired(record: ToolExecutionRecord, now: number = Date.now()): boolean {
	return Date.parse(record.expiresAt) <= now;
}

function isToolExecutionRecord(value: unknown): value is ToolExecutionRecord {
	if (value === null || typeof value !== "object") {
		return false;
	}

	const record: Partial<ToolExecutionRecord> = value as Partial<ToolExecutionRecord>;
	return typeof record.fingerprint === "string"
		&& typeof record.scope === "string"
		&& typeof record.llmToolName === "string"
		&& typeof record.serverId === "string"
		&& typeof record.toolName === "string"
		&& typeof record.argsHash === "string"
		&& typeof record.content === "string"
		&& typeof record.rawContentLength === "number"
		&& typeof record.truncated === "boolean"
		&& typeof record.createdAt === "string"
		&& typeof record.expiresAt === "string";
}

async function loadLedger(): Promise<void> {
	try {
		const raw: string = await readFile(getToolExecutionLedgerPath(), "utf8");
		const now: number = Date.now();
		for (const line of raw.split("\n")) {
			const trimmed: string = line.trim();
			if (trimmed.length === 0) {
				continue;
			}

			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (isToolExecutionRecord(parsed) && !isRecordExpired(parsed, now)) {
					completedToolExecutions.set(parsed.fingerprint, parsed);
				}
			} catch {
				// 忽略损坏的 ledger 行，避免单条记录影响后端启动。
			}
		}
		pruneCompletedToolExecutions(now);
	} catch {
		// Ledger 不存在时按空记录处理。
	}
}

async function ensureLedgerLoaded(): Promise<void> {
	if (ledgerLoadPromise === null) {
		ledgerLoadPromise = loadLedger();
	}

	await ledgerLoadPromise;
}

function pruneCompletedToolExecutions(now: number = Date.now()): void {
	for (const [fingerprint, record] of completedToolExecutions.entries()) {
		if (isRecordExpired(record, now)) {
			completedToolExecutions.delete(fingerprint);
		}
	}

	while (completedToolExecutions.size > MAX_COMPLETED_TOOL_EXECUTIONS) {
		const oldestFingerprint: string | undefined = completedToolExecutions.keys().next().value;
		if (oldestFingerprint === undefined) {
			break;
		}
		completedToolExecutions.delete(oldestFingerprint);
	}
}

function enqueueLedgerWrite(record: ToolExecutionRecord): Promise<void> {
	ledgerWriteQueue = ledgerWriteQueue.then(async (): Promise<void> => {
		const ledgerPath: string = getToolExecutionLedgerPath();
		await mkdir(dirname(ledgerPath), { recursive: true });
		await writeFile(ledgerPath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
	}, async (): Promise<void> => {
		const ledgerPath: string = getToolExecutionLedgerPath();
		await mkdir(dirname(ledgerPath), { recursive: true });
		await writeFile(ledgerPath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
	});

	return ledgerWriteQueue;
}

export function shouldDedupeLlmToolExecution(llmToolName: string, workspaceId?: string | undefined): boolean {
	if (llmToolName === "mcp_terminal_run_command" || llmToolName === "mcp_terminal_cancel_job") {
		return false;
	}
	const policy = getToolPolicy(llmToolName, workspaceId);
	return policy?.risk === "write" || policy?.risk === "destructive";
}

export function getLlmToolExecutionIdentity(
	llmToolName: string,
	args: Record<string, unknown>,
	scope: string = "workspace:none",
	workspaceId?: string | undefined
): ToolExecutionIdentity | undefined {
	if (!shouldDedupeLlmToolExecution(llmToolName, workspaceId)) {
		return undefined;
	}

	const mapping = resolveToolMapping(llmToolName, workspaceId);
	const executionArgs: Record<string, unknown> = stripApprovalReasonArg(args);
	const argsHash: string = sha256(stableJson(executionArgs));
	const fingerprintHash: string = sha256(`${scope}\n${mapping.serverId}\n${mapping.toolName}\n${argsHash}`);
	return {
		fingerprint: `${mapping.serverId}:${mapping.toolName}:${fingerprintHash}`,
		scope,
		serverId: mapping.serverId,
		toolName: mapping.toolName,
		argsHash
	};
}

function getMcpExecutionScope(mcpHost: McpHost, workspaceId?: string | undefined): string {
	return workspaceId ?? mcpHost.getActiveWorkspaceId() ?? "workspace:none";
}

function addRefreshPath(paths: Set<string>, value: unknown): void {
	if (typeof value !== "string") {
		return;
	}

	const trimmed: string = value.trim();
	if (trimmed.length === 0) {
		return;
	}

	paths.add(trimmed);
}

export function collectGodotRefreshPaths(llmToolName: string, args: Record<string, unknown>): string[] {
	const paths: Set<string> = new Set();
	if (GODOT_PROJECT_SETTINGS_MUTATION_TOOLS.has(llmToolName)) {
		paths.add("project.godot");
	}

	addRefreshPath(paths, args.relativePath);
	addRefreshPath(paths, args.scenePath);
	addRefreshPath(paths, args.scriptPath);
	addRefreshPath(paths, args.resourcePath);
	addRefreshPath(paths, args.path);

	const operations: unknown = args.operations;
	if (Array.isArray(operations)) {
		for (const operation of operations) {
			if (operation === null || typeof operation !== "object") {
				continue;
			}

			const operationRecord: Record<string, unknown> = operation as Record<string, unknown>;
			addRefreshPath(paths, operationRecord.scenePath);
			addRefreshPath(paths, operationRecord.scriptPath);
			addRefreshPath(paths, operationRecord.resourcePath);
			addRefreshPath(paths, operationRecord.path);
		}
	}

	return [...paths];
}

export type GodotEditorFilesystemRefreshOutcome = {
	status: "not_applicable" | "confirmed" | "editor_unavailable" | "failed";
	changedPaths: string[];
	editorCount: number;
};

export async function refreshEditorFilesystemAfterGodotMutation(
	mcpHost: McpHost,
	llmToolName: string,
	args: Record<string, unknown>,
	workspaceId?: string | undefined
): Promise<GodotEditorFilesystemRefreshOutcome> {
	if (!GODOT_PROJECT_MUTATION_TOOLS.has(llmToolName)) {
		return { status: "not_applicable", changedPaths: [], editorCount: 0 };
	}

	const changedPaths: string[] = collectGodotRefreshPaths(llmToolName, args);
	const workspace = workspaceId === undefined ? undefined : findWorkspace(workspaceId);
	const sourceFolderId: string | undefined = typeof args.sourceFolderId === "string" ? args.sourceFolderId : undefined;
	const editorWorkspaceId: string | undefined = workspace === undefined
		? workspaceId
		: createSourceScopedWorkspace(workspace, sourceFolderId).id;
	try {
		const results: unknown[] | null = await mcpHost.getEditorBridge().refreshFilesystem(changedPaths, editorWorkspaceId);
		if (results === null) {
			logger.info("godot_editor", "filesystem_refresh_skipped", {
				llmToolName,
				changedPaths,
				reason: "editor_unavailable"
			});
			return { status: "editor_unavailable", changedPaths, editorCount: 0 };
		}

		logger.info("godot_editor", "filesystem_refresh_confirmed", {
			llmToolName,
			changedPaths,
			editorCount: results.length
		});
		return { status: "confirmed", changedPaths, editorCount: results.length };
	} catch (error: unknown) {
		logger.warn("godot_editor", "filesystem_refresh_failed", {
			llmToolName,
			changedPaths,
			error: error instanceof Error ? error.message : String(error)
		});
		return { status: "failed", changedPaths, editorCount: 0 };
	}
}

/**
 * 编辑器刷新是写入后的同步通知，不应阻塞工具本身的成功结果。
 * Godot 编辑器断连或未响应时，磁盘写入已经完成，Studio 仍应立即收到
 * tool.result；刷新失败只记录为环境日志，下一次编辑器上下文更新会重新同步。
 */
export function scheduleEditorFilesystemRefreshAfterGodotMutation(
	mcpHost: McpHost,
	llmToolName: string,
	args: Record<string, unknown>,
	workspaceId?: string | undefined
): void {
	void refreshEditorFilesystemAfterGodotMutation(mcpHost, llmToolName, args, workspaceId).catch((error: unknown): void => {
		logger.warn("godot_editor", "filesystem_refresh_background_failed", {
			llmToolName,
			error: error instanceof Error ? error.message : String(error)
		});
	});
}

async function executeMappedTool(
	mcpHost: McpHost,
	serverId: string,
	toolName: string,
	args: Record<string, unknown>,
	fingerprint?: string | undefined,
	workspaceId?: string | undefined,
	editorInstanceId?: string | undefined,
	commandAuthorization?: TerminalCommandAuthorization | undefined,
	preserveFullResultForEnrichment: boolean = false,
	abortSignal?: AbortSignal | undefined,
	onProgress?: ((progress: McpProgressNotification) => void) | undefined,
	sessionId?: string | undefined
): Promise<IdempotentToolExecutionResult> {
	const result = await mcpHost.callTool(
		serverId,
		toolName,
		args,
		workspaceId,
		editorInstanceId,
		commandAuthorization,
		abortSignal,
		onProgress,
		sessionId
	) as ToolResultContent;
	const textResult: string = extractTextContent(result);
	const truncated: boolean = textResult.length > MAX_TOOL_RESULT_CHARS;
	return {
		content: preserveFullResultForEnrichment ? textResult : trimToolResult(textResult),
		rawContentLength: textResult.length,
		truncated,
		reused: false,
		fingerprint
	};
}

async function executeImageGenerationTool(
	args: Record<string, unknown>,
	sessionId?: string | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<IdempotentToolExecutionResult> {
	if (sessionId === undefined || sessionId.length === 0) {
		throw new Error("Image generation requires an active session.");
	}
	const { generateImage, parseImageGenerationToolArgs } = await import("../providers/image-generation.js");
	const { getGeneratedImageArtifactLocalPath } = await import("../session/session-attachments.js");
	const imageGeneration: ImageGenerationResult = await generateImage(parseImageGenerationToolArgs(args, sessionId), abortSignal);
	const artifactsForToolResult = imageGeneration.artifacts.map((artifact) => {
		const absolutePath: string = getGeneratedImageArtifactLocalPath(artifact);
		return {
			...artifact,
			absolutePath,
			localPath: absolutePath,
			markdownImage: `![generated image](<${absolutePath.replaceAll("\\", "/")}>)`
		};
	});
	const content: string = JSON.stringify({
		ok: true,
		type: "image_generation",
		status: imageGeneration.status,
		provider: imageGeneration.provider,
		model: imageGeneration.model,
		prompt: imageGeneration.prompt,
		usageHint: "Use mcp_image_propose_import_to_workspace and mcp_image_import_to_workspace to place this image in the active project. Use mcp_image_replace_workspace_asset only when replacing an existing asset with user approval. For chat display, use artifacts[n].absolutePath or artifacts[n].markdownImage.",
		artifacts: artifactsForToolResult
	});
	return {
		content: trimToolResult(content),
		rawContentLength: content.length,
		truncated: content.length > MAX_TOOL_RESULT_CHARS,
		reused: false,
		imageGeneration
	};
}

async function executeImageWorkspaceImportTool(
	llmToolName: string,
	args: Record<string, unknown>,
	workspaceId?: string | undefined,
	sessionId?: string | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<IdempotentToolExecutionResult> {
	if (workspaceId === undefined || sessionId === undefined) {
		throw new Error("Image workspace import requires an active workspace and session.");
	}
	const imageId: unknown = args.imageId;
	const relativePath: unknown = args.relativePath;
	if (typeof imageId !== "string" || typeof relativePath !== "string") {
		throw new Error("Image workspace import requires imageId and relativePath.");
	}
	const { executeImageWorkspaceImport } = await import("./image-workspace-import.js");
	const mode = llmToolName === "mcp_image_propose_import_to_workspace"
		? "propose"
		: llmToolName === "mcp_image_replace_workspace_asset"
			? "replace"
			: "create";
	const imported = await executeImageWorkspaceImport({
		mode,
		imageId,
		relativePath,
		sessionId,
		workspaceId,
		sourceFolderId: typeof args.sourceFolderId === "string" ? args.sourceFolderId : undefined,
		abortSignal
	});
	const content: string = JSON.stringify(imported);
	return {
		content: trimToolResult(content),
		rawContentLength: content.length,
		truncated: content.length > MAX_TOOL_RESULT_CHARS,
		reused: false
	};
}

async function executeWebSearchTool(args: Record<string, unknown>, abortSignal?: AbortSignal | undefined): Promise<IdempotentToolExecutionResult> {
	const { executeWebSearch, parseWebSearchToolArgs } = await import("../providers/web-search.js");
	const webSearch = await executeWebSearch(parseWebSearchToolArgs(args), abortSignal);
	const content: string = JSON.stringify({
		...webSearch,
		summary: `${webSearch.query}: ${webSearch.results.length} result${webSearch.results.length === 1 ? "" : "s"}`
	});
	return {
		content: trimToolResult(content),
		rawContentLength: content.length,
		truncated: content.length > MAX_TOOL_RESULT_CHARS,
		reused: false
	};
}

async function executeImageInspectTool(
	args: Record<string, unknown>,
	workspaceId?: string | undefined,
	sessionId?: string | undefined
): Promise<IdempotentToolExecutionResult> {
	const { resolveImageInspection } = await import("../providers/tool-image-reference.js");
	const inspection = await resolveImageInspection(args, { workspaceId, sessionId });
	const content: string = JSON.stringify({
		ok: true,
		image: {
			title: inspection.reference.title,
			mimeType: inspection.reference.mimeType,
			byteSize: inspection.reference.byteSize,
			width: inspection.reference.width ?? null,
			height: inspection.reference.height ?? null,
			sha256: inspection.reference.sha256
		},
		route: "pending",
		artifactRefs: [inspection.artifactRef]
	});
	return {
		content,
		rawContentLength: content.length,
		truncated: false,
		reused: false,
		imageReferences: [inspection.reference]
	};
}

export async function executeLlmToolWithIdempotency(
	mcpHost: McpHost,
	llmToolName: string,
	args: Record<string, unknown>,
	workspaceId?: string | undefined,
	editorInstanceId?: string | undefined,
	sessionId?: string | undefined,
	abortSignal?: AbortSignal | undefined,
	commandAuthorization?: TerminalCommandAuthorization | undefined,
	preserveFullResultForEnrichment: boolean = false,
	onProgress?: ((progress: McpProgressNotification) => void) | undefined
): Promise<IdempotentToolExecutionResult> {
	if (llmToolName === "mcp_image_generate") {
		return executeImageGenerationTool(args, sessionId, abortSignal);
	}
	if (llmToolName === "mcp_image_inspect") {
		return executeImageInspectTool(args, workspaceId, sessionId);
	}
	if (
		llmToolName === "mcp_image_propose_import_to_workspace"
		|| llmToolName === "mcp_image_import_to_workspace"
		|| llmToolName === "mcp_image_replace_workspace_asset"
	) {
		const executeImport = (): Promise<IdempotentToolExecutionResult> => executeImageWorkspaceImportTool(
			llmToolName,
			args,
			workspaceId,
			sessionId,
			abortSignal
		);
		const result: IdempotentToolExecutionResult = llmToolName === "mcp_image_propose_import_to_workspace"
			? await executeImport()
			: await captureFileEditBatchDraft(mcpHost, llmToolName, args, executeImport);
		scheduleEditorFilesystemRefreshAfterGodotMutation(mcpHost, llmToolName, args, workspaceId);
		return result;
	}
	if (llmToolName === "mcp_web_search") {
		return executeWebSearchTool(args, abortSignal);
	}

	const identity: ToolExecutionIdentity | undefined = getLlmToolExecutionIdentity(llmToolName, args, getMcpExecutionScope(mcpHost, workspaceId), workspaceId);
	if (identity === undefined) {
		const mapping = resolveToolMapping(llmToolName, workspaceId);
		const result: IdempotentToolExecutionResult = await captureFileEditBatchDraft(
			mcpHost,
			llmToolName,
			args,
			(): Promise<IdempotentToolExecutionResult> => executeMappedTool(
				mcpHost,
				mapping.serverId,
				mapping.toolName,
				args,
				undefined,
				workspaceId,
				editorInstanceId,
				commandAuthorization,
				preserveFullResultForEnrichment,
				abortSignal,
				onProgress,
				sessionId
			)
		);
		scheduleEditorFilesystemRefreshAfterGodotMutation(mcpHost, llmToolName, args, workspaceId);
		return result;
	}

	await ensureLedgerLoaded();
	pruneCompletedToolExecutions();

	const existingRecord: ToolExecutionRecord | undefined = completedToolExecutions.get(identity.fingerprint);
	if (existingRecord !== undefined && !isRecordExpired(existingRecord)) {
		scheduleEditorFilesystemRefreshAfterGodotMutation(mcpHost, llmToolName, args, workspaceId);
		return {
			content: existingRecord.content,
			rawContentLength: existingRecord.rawContentLength,
			truncated: existingRecord.truncated,
			reused: true,
			fingerprint: identity.fingerprint
		};
	}

	const existingInFlight: Promise<IdempotentToolExecutionResult> | undefined = inFlightToolExecutions.get(identity.fingerprint);
	if (existingInFlight !== undefined) {
		const result: IdempotentToolExecutionResult = await existingInFlight;
		return { ...result, reused: true };
	}

	const executionPromise: Promise<IdempotentToolExecutionResult> = (async (): Promise<IdempotentToolExecutionResult> => {
		const result: IdempotentToolExecutionResult = await captureFileEditBatchDraft(
			mcpHost,
			llmToolName,
			args,
			(): Promise<IdempotentToolExecutionResult> => executeMappedTool(
				mcpHost,
				identity.serverId,
				identity.toolName,
				args,
				identity.fingerprint,
				workspaceId,
				editorInstanceId,
				undefined,
				preserveFullResultForEnrichment,
				abortSignal,
				onProgress,
			sessionId
			)
		);
		scheduleEditorFilesystemRefreshAfterGodotMutation(mcpHost, llmToolName, args, workspaceId);
		const createdAt: string = new Date().toISOString();
		const record: ToolExecutionRecord = {
			fingerprint: identity.fingerprint,
			scope: identity.scope,
			llmToolName,
			serverId: identity.serverId,
			toolName: identity.toolName,
			argsHash: identity.argsHash,
			content: result.content,
			rawContentLength: result.rawContentLength,
			truncated: result.truncated,
			createdAt,
			expiresAt: new Date(Date.now() + TOOL_EXECUTION_DEDUP_TTL_MS).toISOString()
		};
		completedToolExecutions.set(identity.fingerprint, record);
		pruneCompletedToolExecutions();
		await enqueueLedgerWrite(record);
		return result;
	})();

	inFlightToolExecutions.set(identity.fingerprint, executionPromise);
	try {
		return await executionPromise;
	} finally {
		inFlightToolExecutions.delete(identity.fingerprint);
	}
}
