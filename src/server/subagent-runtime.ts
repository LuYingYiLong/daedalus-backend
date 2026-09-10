import { createHash, randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { McpHost } from "../mcp/mcp-host.js";
import { parseJsonObjectFromLlm } from "../providers/llm-json.js";
import type { ProviderAgentResult } from "../providers/agent-types.js";
import { runProviderAgentStreaming } from "../providers/provider-agent.js";
import { subagentResultSchema } from "../protocol/schema.js";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import {
	listRecoverableSubagentGraphSnapshots,
	listSubagentGraphSnapshots,
	readSubagentGraphSnapshot,
	saveSubagentGraphSnapshot
} from "../session/subagent-graph-store.js";
import type { PendingAiContinuation } from "../session/pending-continuation.js";
import type { ActionReviewContext, ActionReviewContextSnapshot, ActionReviewMessage } from "../tools/command-review.js";
import { ReadOnlyToolApprovalGateway, type ApprovalGateway } from "../tools/approval-gateway.js";
import { createWorkspaceToolCatalog } from "../tools/tool-catalog.js";
import { getToolPolicy, type ToolRisk } from "../tools/tool-policy.js";
import {
	SUBAGENT_CANCEL_TOOL_NAME,
	SUBAGENT_MERGE_PREVIEW_TOOL_NAME,
	SUBAGENT_SPAWN_TOOL_NAME,
	SUBAGENT_STATUS_TOOL_NAME,
	SUBAGENT_WAIT_TOOL_NAME,
	type SubagentControlContext,
	type SubagentToolName
} from "../tools/subagent-tools.js";
import { hasGodotWorkspaceCapability } from "../workspace/capabilities.js";
import { registerSessionRuntimeWorkspace } from "../workspace/registry.js";
import { deleteManagedWorktree, restoreManagedWorktreeWorkspace } from "../workspace/worktree-manager.js";
import type { WorkspaceConfig, WorkspaceSourceFolder } from "../workspace/types.js";
import { createAgentLoopRecoveryController, createAgentLoopState } from "../workflow/agent-loop-state.js";
import {
	createSubagentGraph,
	createSubagentNode,
	type SubagentContextRef,
	type SubagentFailure,
	type SubagentGraphSnapshot,
	type SubagentNode,
	type SubagentResult,
	type SubagentRetryPolicy,
	type SubagentRole,
	type SubagentToolCapability,
	type SubagentToolScope,
	type SubagentWorkspaceMode,
	type SubagentWorktreeMetadata
} from "../workflow/subagent-graph.js";
import { appendSubagentNodes, SubagentGraphScheduler } from "../workflow/subagent-scheduler.js";
import type { ClientSession } from "./client-session.js";
import { createProviderChatOptions } from "./provider-chat-options.js";
import { ensureProviderConfigured } from "../application/provider-session-service.js";
import { createProviderRuntimeContext } from "./prompt-context.js";
import { composeSystemPrompt } from "../prompts/registry.js";
import {
	beginAgentRun,
	getAgentRun,
	recordAgentRunToolEvent,
	updateAgentRun
} from "./agent-run-controller.js";
import { createAgentToolEventForwarder } from "./workflow/tool-events.js";
import { cancelPendingApprovalsForRequest, pauseRunForApproval } from "./approval-continuation.js";
import { sendSessionEvent } from "./session-events.js";
import { createSubagentWorktree, applySubagentMerge, previewSubagentMerge, type SubagentMergePreview } from "./subagent-worktree.js";
import { getClientConnection } from "./client-connections.js";
import { runGit } from "./git-utils.js";
import { adaptiveSubagentResources } from "./subagent-resource-coordinator.js";

type SubagentRuntimeBinding = {
	scheduler: SubagentGraphScheduler;
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	sourceWorkspace: WorkspaceConfig | undefined;
	parentRunId: string;
	emitCreatedEvent: boolean;
	lastEventSnapshot: SubagentGraphSnapshot | null;
};

type SubagentNodeInput = {
	nodeId: string;
	name: string;
	role: SubagentRole;
	objective: string;
	dependsOn: string[];
	contextRefs: SubagentContextRef[];
	toolScope: SubagentToolScope;
	workspaceMode: SubagentWorkspaceMode;
	retryPolicy: SubagentRetryPolicy;
};

const runtimeByGraphId: Map<string, SubagentRuntimeBinding> = new Map();
const ROLE_VALUES: ReadonlySet<string> = new Set(["researcher", "planner", "implementer", "tester", "reviewer"]);
const WORKSPACE_MODE_VALUES: ReadonlySet<string> = new Set(["shared_read_only", "managed_worktree"]);
const CAPABILITY_VALUES: ReadonlySet<string> = new Set(["read", "verify", "propose", "write", "destructive", "execute"]);
const CONTEXT_KIND_VALUES: ReadonlySet<string> = new Set(["message", "context_block", "artifact", "source_folder"]);
const ROLE_CAPABILITIES: Readonly<Record<SubagentRole, ReadonlySet<SubagentToolCapability>>> = {
	researcher: new Set(["read", "verify"]),
	planner: new Set(["read"]),
	implementer: new Set(["read", "verify", "propose", "write", "destructive", "execute"]),
	tester: new Set(["read", "verify", "execute"]),
	reviewer: new Set(["read", "verify"])
};
const EXECUTION_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_terminal_run_command",
	"mcp_terminal_run_safe_preset",
	"mcp_terminal_run_write_preset",
	"mcp_terminal_get_job_status",
	"mcp_terminal_get_job_tail",
	"mcp_terminal_cancel_job"
]);

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string.`);
	}
	return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : requiredString(value, label);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	const values: string[] = value.map((item: unknown, index: number): string => requiredString(item, `${label}[${index}]`));
	if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate values.`);
	return values;
}

function optionalStringArray(value: unknown, label: string): string[] {
	return value === undefined ? [] : stringArray(value, label);
}

function parseRetryPolicy(value: unknown): SubagentRetryPolicy {
	if (value === undefined) return { mode: "transient_only", maxRetries: 1 };
	const record: Record<string, unknown> = asRecord(value, "retryPolicy");
	if (record.mode !== "transient_only") throw new Error("retryPolicy.mode must be transient_only.");
	if (record.maxRetries !== undefined && typeof record.maxRetries !== "number") throw new Error("retryPolicy.maxRetries must be a number.");
	const maxRetries: number = record.maxRetries === undefined ? 1 : record.maxRetries;
	if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) {
		throw new Error("retryPolicy.maxRetries must be an integer between 0 and 3.");
	}
	return { mode: "transient_only", maxRetries };
}

function parseContextRefs(value: unknown): SubagentContextRef[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("contextRefs must be an array.");
	return value.map((item: unknown, index: number): SubagentContextRef => {
		const record: Record<string, unknown> = asRecord(item, `contextRefs[${index}]`);
		const kind: string = requiredString(record.kind, `contextRefs[${index}].kind`);
		if (!CONTEXT_KIND_VALUES.has(kind)) throw new Error(`Unsupported context reference kind: ${kind}.`);
		return { kind: kind as SubagentContextRef["kind"], id: requiredString(record.id, `contextRefs[${index}].id`) };
	});
}

function parseToolScope(value: unknown): SubagentToolScope {
	const record: Record<string, unknown> = asRecord(value, "toolScope");
	const capabilities: string[] = stringArray(record.capabilities, "toolScope.capabilities");
	for (const capability of capabilities) {
		if (!CAPABILITY_VALUES.has(capability)) throw new Error(`Unsupported subagent capability: ${capability}.`);
	}
	return {
		capabilities: capabilities as SubagentToolCapability[],
		toolNames: stringArray(record.toolNames, "toolScope.toolNames"),
		sourceFolderIds: stringArray(record.sourceFolderIds, "toolScope.sourceFolderIds")
	};
}

function parseNodeInputs(args: Record<string, unknown>): SubagentNodeInput[] {
	if (!Array.isArray(args.nodes) || args.nodes.length === 0) throw new Error("nodes must contain at least one node.");
	return args.nodes.map((value: unknown, index: number): SubagentNodeInput => {
		const record: Record<string, unknown> = asRecord(value, `nodes[${index}]`);
		const role: string = requiredString(record.role, `nodes[${index}].role`);
		if (!ROLE_VALUES.has(role)) throw new Error(`Unsupported subagent role: ${role}.`);
		const workspaceMode: string = requiredString(record.workspaceMode, `nodes[${index}].workspaceMode`);
		if (!WORKSPACE_MODE_VALUES.has(workspaceMode)) throw new Error(`Unsupported workspace mode: ${workspaceMode}.`);
		return {
			nodeId: requiredString(record.nodeId, `nodes[${index}].nodeId`),
			name: requiredString(record.name, `nodes[${index}].name`),
			role: role as SubagentRole,
			objective: requiredString(record.objective, `nodes[${index}].objective`),
			dependsOn: optionalStringArray(record.dependsOn, `nodes[${index}].dependsOn`),
			contextRefs: parseContextRefs(record.contextRefs),
			toolScope: parseToolScope(record.toolScope),
			workspaceMode: workspaceMode as SubagentWorkspaceMode,
			retryPolicy: parseRetryPolicy(record.retryPolicy)
		};
	});
}

function assertSessionId(session: ClientSession): string {
	if (session.sessionId === undefined) throw new Error("Subagent graphs require an active persisted session.");
	return session.sessionId;
}

function assertGraphOwnership(snapshot: SubagentGraphSnapshot, session: ClientSession, parentRunId?: string): void {
	if (snapshot.graph.sessionId !== assertSessionId(session)) throw new Error("Subagent graph belongs to another session.");
	if (parentRunId !== undefined && snapshot.graph.rootRunId !== parentRunId) {
		throw new Error("Only the graph's parent Agent run may mutate this subagent graph.");
	}
}

function selectSourceFolders(workspace: WorkspaceConfig, sourceFolderIds: readonly string[]): WorkspaceSourceFolder[] {
	const requested: ReadonlySet<string> = new Set(sourceFolderIds.length > 0 ? sourceFolderIds : [workspace.primarySourceFolderId]);
	const selected: WorkspaceSourceFolder[] = workspace.sourceFolders.filter((source: WorkspaceSourceFolder): boolean => requested.has(source.id));
	if (selected.length !== requested.size) {
		const known: Set<string> = new Set(selected.map((source: WorkspaceSourceFolder): string => source.id));
		throw new Error(`Unknown source folder: ${[...requested].find((id: string): boolean => !known.has(id)) ?? "unknown"}.`);
	}
	return selected;
}

function createScopedWorkspace(workspace: WorkspaceConfig, sourceFolderIds: readonly string[], key: string): WorkspaceConfig {
	const sourceFolders: WorkspaceSourceFolder[] = selectSourceFolders(workspace, sourceFolderIds);
	const primary: WorkspaceSourceFolder = sourceFolders.find((source: WorkspaceSourceFolder): boolean => source.id === workspace.primarySourceFolderId)
		?? sourceFolders[0]!;
	const runtimeId: string = createHash("sha256").update(`${workspace.id}\n${key}`).digest("hex").slice(0, 32);
	return registerSessionRuntimeWorkspace({
		...structuredClone(workspace),
		id: `subagent-${runtimeId}`,
		name: `${workspace.name} (${key})`,
		rootPath: primary.path,
		sourceFolders,
		primarySourceFolderId: primary.id,
		permanentWorktree: undefined
	});
}

function contextItemId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["contextId", "attachmentId", "id"]) {
		if (typeof record[key] === "string" && record[key].length > 0) return record[key];
	}
	return undefined;
}

function findAdditionalContext(session: ClientSession, id: string): unknown | undefined {
	for (const message of session.messages) {
		for (const item of message.additionalContext ?? []) {
			if (contextItemId(item) === id) return item;
		}
	}
	return undefined;
}

function assertContextReferences(session: ClientSession, workspace: WorkspaceConfig | undefined, refs: readonly SubagentContextRef[]): void {
	for (const ref of refs) {
		if (ref.kind === "message" && !session.messages.some((message: ChatMessage): boolean => message.requestId === ref.id)) {
			throw new Error(`Unknown message context reference: ${ref.id}.`);
		}
		if (ref.kind === "source_folder" && !workspace?.sourceFolders.some((source: WorkspaceSourceFolder): boolean => source.id === ref.id)) {
			throw new Error(`Unknown source folder context reference: ${ref.id}.`);
		}
		if ((ref.kind === "context_block" || ref.kind === "artifact") && findAdditionalContext(session, ref.id) === undefined) {
			throw new Error(`Unknown ${ref.kind} context reference: ${ref.id}.`);
		}
	}
}

const SENSITIVE_CONTEXT_KEY_PATTERN: RegExp = /(?:api.?key|authorization|cookie|secret|token|headers?|env)/iu;

function sanitizeDelegatedContext(value: unknown, depth: number = 0): unknown {
	if (depth > 8) return "[nested context omitted]";
	if (typeof value === "string") return value.length <= 16_000 ? value : `${value.slice(0, 16_000)}\n[context value truncated]`;
	if (Array.isArray(value)) return value.map((item: unknown): unknown => sanitizeDelegatedContext(item, depth + 1));
	if (typeof value !== "object" || value === null) return value;
	const sanitized: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		sanitized[key] = SENSITIVE_CONTEXT_KEY_PATTERN.test(key)
			? "[REDACTED]"
			: sanitizeDelegatedContext(item, depth + 1);
	}
	return sanitized;
}

export function assertSubagentContextReferencesForTest(
	session: ClientSession,
	workspace: WorkspaceConfig | undefined,
	refs: readonly SubagentContextRef[]
): void {
	assertContextReferences(session, workspace, refs);
}

function buildContextSection(node: SubagentNode, snapshot: SubagentGraphSnapshot, session: ClientSession): string {
	const explicitContext: unknown[] = node.contextRefs.map((ref: SubagentContextRef): unknown => {
		if (ref.kind === "message") {
			const message: ChatMessage | undefined = session.messages.find((candidate: ChatMessage): boolean => candidate.requestId === ref.id);
			return { ref, message: message === undefined ? null : { role: message.role, content: sanitizeDelegatedContext(message.content) } };
		}
		if (ref.kind === "context_block" || ref.kind === "artifact") {
			return { ref, value: sanitizeDelegatedContext(findAdditionalContext(session, ref.id) ?? null) };
		}
		return { ref };
	});
	const dependencyResults = node.dependsOn.map((nodeId: string): unknown => {
		const dependency: SubagentNode | undefined = snapshot.nodes.find((candidate: SubagentNode): boolean => candidate.nodeId === nodeId);
		return { nodeId, role: dependency?.role ?? null, result: sanitizeDelegatedContext(dependency?.result ?? null) };
	});
	const serialized: string = JSON.stringify({ explicitContext, dependencyResults }, null, 2);
	return serialized.length <= 120_000
		? serialized
		: `${serialized.slice(0, 120_000)}\n[delegated context truncated]`;
}

async function readWorktreeMetadata(metadata: SubagentWorktreeMetadata["managedMetadata"]): Promise<SubagentWorktreeMetadata> {
	const sourceStates: SubagentWorktreeMetadata["sourceStates"] = [];
	for (const source of metadata.sources) {
		const headCommit: string = (await runGit(source.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
		const branch: string | null = (await runGit(source.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowedExitCodes: [0, 1] })).stdout.trim() || null;
		sourceStates.push({ sourceFolderId: source.sourceFolderId, headCommit, branch, detached: branch === null });
	}
	return {
		managedMetadata: metadata,
		sourceStates,
		mergeStatus: "not_requested",
		cleanupStatus: "not_requested"
	};
}

function createNodeSkeleton(
	graphId: string,
	input: SubagentNodeInput
): SubagentNode {
	return createSubagentNode({
		graphId,
		runId: `subrun-${randomUUID()}`,
		nodeId: input.nodeId,
		name: input.name,
		role: input.role,
		objective: input.objective,
		dependsOn: input.dependsOn,
		contextRefs: input.contextRefs,
		toolScope: input.toolScope,
		workspaceMode: input.workspaceMode,
		retryPolicy: input.retryPolicy,
		worktreeMetadata: null
	});
}

async function materializeNodeWorktree(
	node: SubagentNode,
	sourceWorkspace: WorkspaceConfig | undefined
): Promise<SubagentNode> {
	let worktreeMetadata: SubagentWorktreeMetadata | null = node.worktreeMetadata;
	if (node.workspaceMode === "managed_worktree") {
		if (sourceWorkspace === undefined) throw new Error("A managed-worktree subagent requires an active workspace.");
		const scopedSource: WorkspaceConfig = createScopedWorkspace(
			sourceWorkspace,
			node.toolScope.sourceFolderIds,
			`${node.graphId}-${node.nodeId}-source`
		);
		const created = await createSubagentWorktree({ graphId: node.graphId, nodeId: node.nodeId, workspace: scopedSource });
		try {
			worktreeMetadata = await readWorktreeMetadata(created.metadata);
		} catch (error: unknown) {
			await deleteManagedWorktree(created.metadata).catch((): void => undefined);
			throw error;
		}
	}
	return createSubagentNode({
		graphId: node.graphId,
		runId: node.runId,
		nodeId: node.nodeId,
		name: node.name,
		role: node.role,
		objective: node.objective,
		dependsOn: node.dependsOn,
		contextRefs: node.contextRefs,
		toolScope: node.toolScope,
		workspaceMode: node.workspaceMode,
		retryPolicy: node.retryPolicy,
		worktreeMetadata,
		now: node.createdAt
	});
}

async function cleanupUnpersistedWorktrees(nodes: readonly SubagentNode[]): Promise<void> {
	for (const node of [...nodes].reverse()) {
		if (node.worktreeMetadata === null) continue;
		await deleteManagedWorktree(node.worktreeMetadata.managedMetadata).catch((): void => undefined);
	}
}

function nodeWorkspace(node: SubagentNode, sourceWorkspace: WorkspaceConfig | undefined): WorkspaceConfig | undefined {
	if (sourceWorkspace === undefined) return undefined;
	if (node.workspaceMode === "managed_worktree") {
		if (node.worktreeMetadata === null) throw new Error(`Managed worktree metadata is missing for ${node.nodeId}.`);
		const restored: WorkspaceConfig | undefined = restoreManagedWorktreeWorkspace(node.worktreeMetadata.managedMetadata, sourceWorkspace);
		if (restored === undefined) throw new Error(`Managed worktree for ${node.nodeId} cannot be restored.`);
		return restored;
	}
	return createScopedWorkspace(sourceWorkspace, node.toolScope.sourceFolderIds, `${node.graphId}-${node.nodeId}-read`);
}

function toolMatchesCapabilities(
	toolName: string,
	workspaceId: string | undefined,
	capabilities: ReadonlySet<SubagentToolCapability>,
	workspaceMode: SubagentWorkspaceMode
): boolean {
	const policyRisk: ToolRisk | undefined = getToolPolicy(toolName, workspaceId)?.risk;
	if (workspaceMode === "shared_read_only" && (policyRisk === "write" || policyRisk === "destructive")) return false;
	if (policyRisk !== undefined && capabilities.has(policyRisk)) return true;
	if (!capabilities.has("execute") || !EXECUTION_TOOL_NAMES.has(toolName)) return false;
	return workspaceMode === "managed_worktree" || policyRisk === "read" || policyRisk === "verify";
}

export function filterSubagentToolNamesForTest(params: {
	availableToolNames: readonly string[];
	role: SubagentRole;
	toolScope: SubagentToolScope;
	workspaceMode: SubagentWorkspaceMode;
	workspaceId?: string | undefined;
}): string[] {
	const explicit: ReadonlySet<string> | null = params.toolScope.toolNames.length > 0
		? new Set(params.toolScope.toolNames)
		: null;
	const roleCapabilities: ReadonlySet<SubagentToolCapability> = ROLE_CAPABILITIES[params.role];
	const capabilities: ReadonlySet<SubagentToolCapability> = new Set(
		params.toolScope.capabilities.filter((capability: SubagentToolCapability): boolean => roleCapabilities.has(capability))
	);
	return params.availableToolNames.filter((toolName: string): boolean => (
		(explicit === null || explicit.has(toolName))
		&& !toolName.startsWith("daedalus_subagent_")
		&& toolMatchesCapabilities(toolName, params.workspaceId, capabilities, params.workspaceMode)
	));
}

function resolveNodeToolNames(node: SubagentNode, workspace: WorkspaceConfig | undefined, session: ClientSession, socket: WebSocket): string[] {
	const available: string[] = createWorkspaceToolCatalog({
		workspaceId: workspace?.id,
		hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(workspace),
		sessionId: session.sessionId,
		requestId: node.runId,
		clientType: getClientConnection(socket)?.clientType
	}).getEntries().map((entry): string => entry.id);
	return filterSubagentToolNamesForTest({
		availableToolNames: available,
		role: node.role,
		toolScope: node.toolScope,
		workspaceMode: node.workspaceMode,
		workspaceId: workspace?.id
	});
}

function createNodeGateway(node: SubagentNode, session: ClientSession, allowedToolNames: readonly string[]): ApprovalGateway {
	return node.role === "researcher" || node.role === "planner" || node.role === "reviewer"
		? new ReadOnlyToolApprovalGateway(session.approvalGateway, allowedToolNames)
		: session.approvalGateway;
}

async function collectChangedFiles(node: SubagentNode): Promise<string[]> {
	if (node.worktreeMetadata === null) return [];
	const changed: Set<string> = new Set();
	for (const source of node.worktreeMetadata.managedMetadata.sources) {
		const statusLines: string[] = (await runGit(source.worktreePath, ["status", "--porcelain=v1", "--untracked-files=normal"])).stdout
			.split(/\r?\n/u).filter(Boolean);
		for (const line of statusLines) changed.add(`${source.sourceFolderId}:${line.slice(3).replaceAll("\\", "/")}`);
		const committed: string[] = (await runGit(source.worktreePath, ["diff", "--name-only", `${source.baseCommit}..HEAD`])).stdout
			.split(/\r?\n/u).filter(Boolean);
		for (const file of committed) changed.add(`${source.sourceFolderId}:${file.replaceAll("\\", "/")}`);
	}
	return [...changed].sort();
}

async function refreshExecutionWorktreeState(binding: SubagentRuntimeBinding, node: SubagentNode): Promise<void> {
	if (node.worktreeMetadata === null) return;
	const refreshed: SubagentWorktreeMetadata = await readWorktreeMetadata(node.worktreeMetadata.managedMetadata);
	await updateNodeWorktreeMetadata(binding, node, {
		...node.worktreeMetadata,
		sourceStates: refreshed.sourceStates
	});
}

function normalizeChangedFiles(changedFiles: readonly string[]): string[] {
	return [...new Set(changedFiles.map((value: string): string => value.trim()).filter((value: string): boolean => (
		value.length > 0 && value.length <= 2_000
	)))].sort();
}

function sanitizeResultMarkdown(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value
		.slice(0, 20_000)
		.replace(/((?:authorization|x-api-key)\s*[:=]\s*)[^\r\n]+/giu, "$1[REDACTED]")
		.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|secret|password|database[_-]?url)\s*[:=]\s*)[^\s\n]+/giu, "$1[REDACTED]")
		.replace(/(?:\b[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp)\/)[^\s\n\r`]+/gu, "[REDACTED_PATH]");
}

function parseSubagentResult(text: string, actualChangedFiles: readonly string[]): SubagentResult {
	const normalizedActualChangedFiles: string[] = normalizeChangedFiles(actualChangedFiles);
	try {
		const parsed = subagentResultSchema.parse(parseJsonObjectFromLlm(text, "Subagent did not return a JSON result"));
		return {
			...parsed,
			detailsMarkdown: sanitizeResultMarkdown(parsed.detailsMarkdown),
			changedFiles: normalizeChangedFiles([...parsed.changedFiles, ...normalizedActualChangedFiles])
		};
	} catch {
		const summary: string = text.trim().slice(0, 20_000);
		return {
			status: "partial",
			summary: summary || "Subagent completed without a structured result.",
			findings: [],
			changedFiles: normalizedActualChangedFiles,
			tests: [],
			artifacts: [],
			needsParentDecision: true,
			recommendedNextAction: "Review the unstructured child output and retry if a strict result is required.",
			detailsMarkdown: sanitizeResultMarkdown(summary)
		};
	}
}

export function parseSubagentResultForTest(text: string, actualChangedFiles: readonly string[]): SubagentResult {
	return parseSubagentResult(text, actualChangedFiles);
}

function resultText(agentResult: ProviderAgentResult): string {
	if (agentResult.status === "completed") return agentResult.text;
	if (agentResult.status === "chat_answer") return agentResult.answer.answer;
	if (agentResult.status === "protocol_violation") throw new Error(agentResult.reason);
	if (agentResult.status === "execution_decision") return JSON.stringify(agentResult.decision);
	if (agentResult.status === "tool_budget_required") throw Object.assign(new Error(agentResult.reason), { code: "subagent_tool_budget_exhausted" });
	throw new Error("Subagent is waiting for approval.");
}

function reportedSubagentFailure(result: SubagentResult): SubagentFailure {
	return {
		code: "subagent_reported_failure",
		message: result.summary,
		retryable: true,
		failedAt: new Date().toISOString()
	};
}

function finishAgentRun(
	binding: SubagentRuntimeBinding,
	node: SubagentNode,
	status: "completed" | "failed" | "cancelled",
	message: string
): void {
	let current = getAgentRun(binding.session, node.runId);
	if (current === undefined || current.terminal !== null) return;
	if (status === "completed") {
		if (current.stage !== "finalizing") current = updateAgentRun(binding.socket, binding.session, node.runId, "finalizing");
		updateAgentRun(binding.socket, binding.session, node.runId, "completed", {
			terminal: { resultStatus: "completed", message, completedAt: new Date().toISOString() }
		});
		return;
	}
	updateAgentRun(binding.socket, binding.session, node.runId, status, {
		terminal: { resultStatus: status, message, completedAt: new Date().toISOString() }
	});
}

function createPendingContinuation(
	node: SubagentNode,
	params: AiChatParams,
	options: ReturnType<typeof createProviderChatOptions>,
	agentResult: Extract<ProviderAgentResult, { status: "approval_required" }>,
	agentLoopState: ReturnType<typeof createAgentLoopState>,
	allowedToolNames: readonly string[],
	workspaceId: string | undefined
): PendingAiContinuation {
	return {
		params,
		options,
		continuation: agentResult.continuation,
		allowedToolNames,
		userMessage: node.objective,
		requestId: node.runId,
		userCreatedAt: node.createdAt,
		stream: true,
		agentLoopState,
		subagent: { graphId: node.graphId, nodeId: node.nodeId, workspaceId }
	};
}

async function executeNode(
	binding: SubagentRuntimeBinding,
	node: SubagentNode,
	snapshot: SubagentGraphSnapshot,
	abortSignal: AbortSignal
): Promise<
	| { status: "completed"; result: SubagentResult }
	| { status: "failed"; result: SubagentResult; failure: SubagentFailure }
	| { status: "cancelled"; result: SubagentResult }
	| { status: "waiting_approval" }
> {
	const sessionId: string = assertSessionId(binding.session);
	const workspace: WorkspaceConfig | undefined = nodeWorkspace(node, binding.sourceWorkspace);
	if (workspace !== undefined) await binding.mcpHost.ensureWorkspace(workspace);
	const apiKey: string | undefined = await ensureProviderConfigured(binding.session);
	if (apiKey === undefined) throw Object.assign(new Error("No provider API key is configured for the subagent."), { code: "provider_not_configured" });
	const previousRun = getAgentRun(binding.session, node.runId);
	if (previousRun !== undefined && previousRun.stage !== "interrupted") {
		throw new Error(`Subagent run id is already active: ${node.runId}.`);
	}
	beginAgentRun({
		socket: binding.socket,
		session: binding.session,
		sessionId,
		requestId: node.runId,
		runId: node.runId,
		rootRequestId: binding.parentRunId,
		parentRunId: binding.parentRunId,
		subagentGraphId: node.graphId,
		subagentNodeId: node.nodeId,
		title: `${node.role}: ${node.objective}`,
		intent: node.role === "implementer" ? "mutate" : "inspect",
		scope: "bounded",
		lane: "agent_loop",
		retryOfRunId: node.retryOfRunId ?? previousRun?.runId
	});
	const agentLoopState = createAgentLoopState();
	updateAgentRun(binding.socket, binding.session, node.runId, "executing", { agentLoopState });
	const allowedToolNames: string[] = resolveNodeToolNames(node, workspace, binding.session, binding.socket);
	const options = createProviderChatOptions(binding.session, apiKey);
	const params: AiChatParams = {
		message: node.objective,
		mode: "agent",
		options: {
			stream: true,
			responseFormat: "json",
			executionPolicy: node.workspaceMode === "shared_read_only" ? "read_only" : "auto",
			outputTarget: node.workspaceMode === "managed_worktree" ? "workspace" : "chat",
			verificationPolicy: node.role === "tester" || node.role === "reviewer" ? "required" : "best_effort",
			toolBudget: "project_edit"
		}
	};
	const resultContract: string = [
		"You are an isolated Daedalus subagent. Work only on the stated objective and within the supplied workspace and tool allowlist.",
		`Name: ${node.name}`,
		`Role: ${node.role}`,
		`Objective: ${node.objective}`,
		"You do not have the parent conversation. The only delegated context is below:",
		buildContextSection(node, snapshot, binding.session),
		"Return one JSON object with exactly these fields:",
		'{"status":"completed|partial|failed|cancelled","summary":"string","findings":["string"],"changedFiles":["string"],"tests":[{"name":"string","status":"passed|failed|skipped","summary":"string|null"}],"artifacts":[{"kind":"string","id":"string","label":"string|null"}],"needsParentDecision":false,"recommendedNextAction":"string|null","detailsMarkdown":"string|null"}',
		"Do not include API keys, environment secrets, custom MCP headers, or other sensitive values."
	].join("\n\n");
	const systemPrompt: string = await composeSystemPrompt(undefined, resultContract, createProviderRuntimeContext(binding.session), "agent");
	const forward = createAgentToolEventForwarder(
		binding.socket,
		node.runId,
		binding.session,
		node.runId,
		`${node.runId}:child`,
		binding.parentRunId,
		binding.mcpHost,
		{ graphId: node.graphId, nodeId: node.nodeId, parentRunId: binding.parentRunId },
		{ persistFileEditBatches: true }
	);
	const onToolEvent = (event: Parameters<typeof recordAgentRunToolEvent>[3]): void => {
		recordAgentRunToolEvent(binding.socket, binding.session, node.runId, event, false, workspace?.id);
		if (event.type !== "ai.delta" && event.type !== "ai.thinking.delta" && event.type !== "ai.thinking.done") forward(event);
	};
	const actionReviewEvents: Record<string, unknown>[] = Array.from(binding.session.agentRunToolCalls.values())
		.flatMap((calls): Record<string, unknown>[] => Array.from(calls.entries()).map(([toolCallId, call]): Record<string, unknown> => ({
			type: "tool.call",
			toolCallId,
			toolName: call.toolName,
			risk: call.risk,
			args: call.args
		})))
		.slice(-128);
	const actionReviewContext: ActionReviewContext = {
		getSnapshot: (): ActionReviewContextSnapshot => ({
			messages: [
				...binding.session.messages
					.filter((message: ChatMessage): boolean => message.role === "user" || message.role === "assistant")
					.map((message: ChatMessage): ActionReviewMessage => ({
						role: message.role === "user" ? "user" : "assistant",
						content: message.content,
						...(message.requestId === undefined ? {} : { requestId: message.requestId }),
						...(message.createdAt === undefined ? {} : { createdAt: message.createdAt })
					})),
				{ role: "user", content: node.objective, requestId: node.runId }
			],
			toolEvents: [...actionReviewEvents],
			currentGoal: node.objective,
			contextCompleteness: binding.session.summaryMessage === undefined ? "complete" : "compressed"
		}),
		recordToolEvent: (event: Record<string, unknown>): void => {
			actionReviewEvents.push(event);
			if (actionReviewEvents.length > 128) actionReviewEvents.shift();
		}
	};
	try {
		const agentResult: ProviderAgentResult = await runProviderAgentStreaming(
			params,
			options,
			[],
			systemPrompt,
			binding.mcpHost,
			createNodeGateway(node, binding.session, allowedToolNames),
			allowedToolNames,
			onToolEvent,
			abortSignal,
			undefined,
			{
				workspaceId: workspace?.id,
				actionReviewContext,
				hasGodotWorkspaceCapability: hasGodotWorkspaceCapability(workspace),
				sessionId,
				requestId: node.runId,
				clientType: getClientConnection(binding.socket)?.clientType,
				agentLoopRecovery: createAgentLoopRecoveryController(agentLoopState),
				hookContext: { model: options.model ?? binding.session.modelProfile.model, approvalMode: binding.session.approvalGateway.getMode(), chatMode: "agent" }
			}
		);
		if (agentResult.status === "approval_required") {
			const pendingContinuation: PendingAiContinuation = createPendingContinuation(
				node, params, options, agentResult, agentLoopState, allowedToolNames, workspace?.id
			);
			await pauseRunForApproval({
				socket: binding.socket,
				requestId: node.runId,
				session: binding.session,
				mcpHost: binding.mcpHost,
				runId: node.runId,
				agentResult,
				pendingContinuation,
				persistRequestId: node.runId
			});
			emitApprovalEvent(binding, node, agentResult.approvalId, "requested");
			return { status: "waiting_approval" };
		}
		const changedFiles: string[] = await collectChangedFiles(node);
		await refreshExecutionWorktreeState(binding, node);
		const result: SubagentResult = parseSubagentResult(resultText(agentResult), changedFiles);
		if (result.status === "failed") {
			const failure: SubagentFailure = reportedSubagentFailure(result);
			finishAgentRun(binding, node, "failed", failure.message);
			return { status: "failed", result, failure };
		}
		if (result.status === "cancelled") {
			finishAgentRun(binding, node, "cancelled", result.summary);
			return { status: "cancelled", result };
		}
		finishAgentRun(binding, node, "completed", result.summary);
		return { status: "completed", result };
	} catch (error: unknown) {
		finishAgentRun(
			binding,
			node,
			abortSignal.aborted ? "cancelled" : "failed",
			error instanceof Error ? error.message : String(error)
		);
		throw error;
	}
}

function emitApprovalEvent(
	binding: SubagentRuntimeBinding,
	node: SubagentNode,
	approvalId: string,
	status: "requested" | "approved" | "rejected" | "cancelled"
): void {
	sendSessionEvent(binding.socket, node.runId, binding.session, "agent.subgraph.node.approval", {
		graphId: node.graphId,
		nodeId: node.nodeId,
		parentRunId: binding.parentRunId,
		runId: node.runId,
		revision: binding.scheduler.getSnapshot().graph.revision,
		approvalId,
		status
	}, binding.parentRunId);
}

function emitRetryEvent(binding: SubagentRuntimeBinding, params: {
	node: SubagentNode;
	previousRunId: string;
	automatic: boolean;
	reason: string;
	nextRetryAt: string | null;
}): void {
	sendSessionEvent(binding.socket, params.node.runId, binding.session, "agent.subgraph.node.retry", {
		graphId: params.node.graphId,
		nodeId: params.node.nodeId,
		parentRunId: binding.parentRunId,
		revision: binding.scheduler.getSnapshot().graph.revision,
		previousRunId: params.previousRunId,
		runId: params.node.runId,
		attempt: params.node.attempt,
		automatic: params.automatic,
		reason: params.reason,
		nextRetryAt: params.nextRetryAt
	}, binding.parentRunId, binding.session.sessionId);
}

function emitSnapshot(binding: SubagentRuntimeBinding, snapshot: SubagentGraphSnapshot): void {
	const previous: SubagentGraphSnapshot | null = binding.lastEventSnapshot;
	if (binding.emitCreatedEvent && previous === null) {
		sendSessionEvent(binding.socket, binding.parentRunId, binding.session, "agent.subgraph.created", {
			parentRunId: binding.parentRunId,
			graph: snapshot.graph,
			nodes: snapshot.nodes
		}, binding.parentRunId, snapshot.graph.sessionId);
		binding.emitCreatedEvent = false;
	}
	sendSessionEvent(binding.socket, binding.parentRunId, binding.session, "agent.subgraph.state", {
		parentRunId: binding.parentRunId,
		graph: snapshot.graph
	}, binding.parentRunId, snapshot.graph.sessionId);
	for (const node of snapshot.nodes) {
		const oldNode: SubagentNode | undefined = previous?.nodes.find((candidate: SubagentNode): boolean => candidate.nodeId === node.nodeId);
		if (oldNode !== undefined && JSON.stringify(oldNode) === JSON.stringify(node)) continue;
		sendSessionEvent(binding.socket, node.runId, binding.session, "agent.subgraph.node.state", {
			graphId: snapshot.graph.graphId,
			parentRunId: binding.parentRunId,
			revision: snapshot.graph.revision,
			node
		}, binding.parentRunId, snapshot.graph.sessionId);
		if (node.result !== null && JSON.stringify(oldNode?.result ?? null) !== JSON.stringify(node.result)) {
			sendSessionEvent(binding.socket, node.runId, binding.session, "agent.subgraph.node.result", {
				graphId: snapshot.graph.graphId,
				nodeId: node.nodeId,
				parentRunId: binding.parentRunId,
				runId: node.runId,
				revision: snapshot.graph.revision,
				result: node.result
			}, binding.parentRunId, snapshot.graph.sessionId);
		}
	}
	binding.lastEventSnapshot = structuredClone(snapshot);
}

function createBinding(params: {
	snapshot: SubagentGraphSnapshot;
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	sourceWorkspace?: WorkspaceConfig | undefined;
	emitCreatedEvent?: boolean | undefined;
}): SubagentRuntimeBinding {
	let binding!: SubagentRuntimeBinding;
	const scheduler = new SubagentGraphScheduler(params.snapshot, {
		persist: saveSubagentGraphSnapshot,
		execute: (node, snapshot, signal) => executeNode(binding, node, snapshot, signal),
		onSnapshot: (snapshot: SubagentGraphSnapshot): void => emitSnapshot(binding, snapshot),
		resources: adaptiveSubagentResources,
		onRetry: (params): void => emitRetryEvent(binding, params)
	});
	binding = {
		scheduler,
		socket: params.socket,
		session: params.session,
		mcpHost: params.mcpHost,
		sourceWorkspace: params.sourceWorkspace ?? params.session.activeWorkspace,
		parentRunId: params.snapshot.graph.rootRunId,
		emitCreatedEvent: params.emitCreatedEvent === true,
		lastEventSnapshot: null
	};
	runtimeByGraphId.set(params.snapshot.graph.graphId, binding);
	return binding;
}

async function requireBinding(params: {
	graphId: string;
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	parentRunId?: string | undefined;
}): Promise<SubagentRuntimeBinding> {
	const existing: SubagentRuntimeBinding | undefined = runtimeByGraphId.get(params.graphId);
	if (existing !== undefined && existing.session === params.session) {
		existing.socket = params.socket;
		existing.mcpHost = params.mcpHost;
		assertGraphOwnership(existing.scheduler.getSnapshot(), params.session, params.parentRunId);
		return existing;
	}
	const snapshot: SubagentGraphSnapshot | null = await readSubagentGraphSnapshot(params.graphId);
	if (snapshot === null) throw new Error(`Unknown subagent graph: ${params.graphId}.`);
	assertGraphOwnership(snapshot, params.session, params.parentRunId);
	return createBinding({ snapshot, socket: params.socket, session: params.session, mcpHost: params.mcpHost });
}

function filterSnapshot(snapshot: SubagentGraphSnapshot, nodeIds?: readonly string[], includeResults: boolean = true): SubagentGraphSnapshot {
	const requested: ReadonlySet<string> | null = nodeIds === undefined || nodeIds.length === 0 ? null : new Set(nodeIds);
	const nodes: SubagentNode[] = snapshot.nodes
		.filter((node: SubagentNode): boolean => requested === null || requested.has(node.nodeId))
		.map((node: SubagentNode): SubagentNode => includeResults ? node : { ...node, result: null });
	if (requested !== null && nodes.length !== requested.size) throw new Error("One or more requested subagent nodes do not exist.");
	return { graph: snapshot.graph, nodes };
}

function serializeParentSnapshot(
	binding: SubagentRuntimeBinding,
	snapshot: SubagentGraphSnapshot,
	nodeIds?: readonly string[],
	includeResults: boolean = true
): Record<string, unknown> {
	const filtered: SubagentGraphSnapshot = filterSnapshot(snapshot, nodeIds, includeResults);
	const nodeIdByRunId: ReadonlyMap<string, string> = new Map(
		filtered.nodes.map((node: SubagentNode): [string, string] => [node.runId, node.nodeId])
	);
	const pendingApprovals = binding.session.approvalGateway.listPending()
		.filter((approval): boolean => approval.requestId !== undefined && nodeIdByRunId.has(approval.requestId))
		.map((approval): Record<string, unknown> => ({
			approvalId: approval.approvalId,
			nodeId: nodeIdByRunId.get(approval.requestId!),
			runId: approval.requestId,
			toolName: approval.llmToolName,
			reason: approval.reason,
			createdAt: new Date(approval.createdAt).toISOString()
		}));
	return { ...filtered, pendingApprovals };
}

async function spawnNodes(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	parentRunId: string;
	args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	const inputs: SubagentNodeInput[] = parseNodeInputs(params.args);
	for (const input of inputs) {
		assertContextReferences(params.session, params.session.activeWorkspace, input.contextRefs);
		if (params.session.activeWorkspace === undefined) {
			if (input.toolScope.sourceFolderIds.length > 0) {
				throw new Error("A subagent source-folder scope requires an active workspace.");
			}
		} else {
			selectSourceFolders(params.session.activeWorkspace, input.toolScope.sourceFolderIds);
		}
		const allowedSourceIds: ReadonlySet<string> = new Set(
			input.toolScope.sourceFolderIds.length > 0
				? input.toolScope.sourceFolderIds
				: params.session.activeWorkspace === undefined ? [] : [params.session.activeWorkspace.primarySourceFolderId]
		);
		for (const ref of input.contextRefs) {
			if (ref.kind === "source_folder" && !allowedSourceIds.has(ref.id)) {
				throw new Error(`Source folder context ${ref.id} is outside the node tool scope.`);
			}
		}
	}
	const requestedGraphId: string | undefined = optionalString(params.args.graphId, "graphId");
	let existingBinding: SubagentRuntimeBinding | undefined;
	let initialSnapshot: SubagentGraphSnapshot;
	if (requestedGraphId === undefined) {
		initialSnapshot = {
			graph: createSubagentGraph({ sessionId: assertSessionId(params.session), rootRunId: params.parentRunId }),
			nodes: []
		};
	} else {
		existingBinding = await requireBinding({
			graphId: requestedGraphId,
			socket: params.socket,
			session: params.session,
			mcpHost: params.mcpHost,
			parentRunId: params.parentRunId
		});
		initialSnapshot = existingBinding.scheduler.getSnapshot();
	}
	const graphId: string = initialSnapshot.graph.graphId;
	const skeletons: SubagentNode[] = inputs.map((input: SubagentNodeInput): SubagentNode => createNodeSkeleton(graphId, input));
	// 先校验节点、依赖和环，再创建 worktree，避免失败时遗留磁盘资源。
	appendSubagentNodes(initialSnapshot, skeletons);
	const nodes: SubagentNode[] = [];
	try {
		for (const node of skeletons) {
			nodes.push(await materializeNodeWorktree(node, existingBinding?.sourceWorkspace ?? params.session.activeWorkspace));
		}
	} catch (error: unknown) {
		await cleanupUnpersistedWorktrees(nodes);
		throw error;
	}

	let snapshot: SubagentGraphSnapshot;
	if (requestedGraphId === undefined) {
		const persistedInitial: SubagentGraphSnapshot = { graph: initialSnapshot.graph, nodes };
		try {
			await saveSubagentGraphSnapshot(persistedInitial);
		} catch (error: unknown) {
			await cleanupUnpersistedWorktrees(nodes);
			throw error;
		}
		const binding: SubagentRuntimeBinding = createBinding({
			snapshot: persistedInitial,
			socket: params.socket,
			session: params.session,
			mcpHost: params.mcpHost,
			emitCreatedEvent: true
		});
		snapshot = await binding.scheduler.start();
	} else {
		const binding: SubagentRuntimeBinding = existingBinding!;
		try {
			snapshot = await binding.scheduler.append(nodes);
		} catch (error: unknown) {
			const persisted: SubagentGraphSnapshot | null = await readSubagentGraphSnapshot(graphId).catch((): null => null);
			const persistedNodeIds: ReadonlySet<string> = new Set(persisted?.nodes.map((node: SubagentNode): string => node.nodeId) ?? []);
			if (nodes.every((node: SubagentNode): boolean => !persistedNodeIds.has(node.nodeId))) {
				await cleanupUnpersistedWorktrees(nodes);
				runtimeByGraphId.delete(graphId);
			}
			throw error;
		}
	}
	return { graphId, revision: snapshot.graph.revision, graph: snapshot.graph, nodes: snapshot.nodes };
}

export function createSubagentControl(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	parentRunId: string;
}): SubagentControlContext {
	return {
		execute: async (toolName: SubagentToolName, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<Record<string, unknown>> => {
			if (toolName === SUBAGENT_SPAWN_TOOL_NAME) return spawnNodes({ ...params, args });
			const graphId: string = requiredString(args.graphId, "graphId");
			const binding: SubagentRuntimeBinding = await requireBinding({ graphId, ...params });
			if (toolName === SUBAGENT_STATUS_TOOL_NAME) {
				const nodeIds: string[] | undefined = args.nodeIds === undefined ? undefined : stringArray(args.nodeIds, "nodeIds");
				return serializeParentSnapshot(binding, binding.scheduler.getSnapshot(), nodeIds, args.includeResults !== false);
			}
			if (toolName === SUBAGENT_WAIT_TOOL_NAME) {
				const nodeIds: string[] | undefined = args.nodeIds === undefined ? undefined : stringArray(args.nodeIds, "nodeIds");
				const afterRevision: number | undefined = typeof args.afterRevision === "number" ? args.afterRevision : undefined;
				const timeoutMs: number = typeof args.timeoutMs === "number" ? Math.max(0, Math.min(60_000, args.timeoutMs)) : 30_000;
				const snapshot: SubagentGraphSnapshot = afterRevision === undefined
					? await binding.scheduler.wait(nodeIds, abortSignal)
					: await binding.scheduler.waitForChange(afterRevision, timeoutMs, abortSignal);
				return serializeParentSnapshot(binding, snapshot, nodeIds);
			}
			if (toolName === SUBAGENT_CANCEL_TOOL_NAME) {
				const nodeIds: string[] | undefined = args.nodeIds === undefined ? undefined : stringArray(args.nodeIds, "nodeIds");
				const snapshot: SubagentGraphSnapshot = await cancelBindingNodes(binding, nodeIds);
				return snapshot as unknown as Record<string, unknown>;
			}
			if (toolName === SUBAGENT_MERGE_PREVIEW_TOOL_NAME) {
				return await previewSubagentNodeMerge({ ...params, graphId, nodeId: requiredString(args.nodeId, "nodeId") });
			}
			throw new Error(`Unsupported subagent tool: ${toolName}.`);
		}
	};
}

export async function getSubagentGraph(params: {
	socket: WebSocket; session: ClientSession; mcpHost: McpHost; graphId: string;
}): Promise<SubagentGraphSnapshot> {
	const binding = await requireBinding(params);
	return binding.scheduler.getSnapshot();
}

export async function listSubagentGraphs(params: {
	socket: WebSocket; session: ClientSession; mcpHost: McpHost; sessionId: string;
	status?: SubagentGraphSnapshot["graph"]["status"] | undefined; limit?: number | undefined; cursor?: string | undefined;
}): Promise<{ graphs: SubagentGraphSnapshot[]; nextCursor: string | null }> {
	if (params.sessionId !== assertSessionId(params.session)) throw new Error("Cannot list subagent graphs from another session.");
	const snapshots: SubagentGraphSnapshot[] = (await listSubagentGraphSnapshots(params.sessionId))
		.filter((snapshot: SubagentGraphSnapshot): boolean => params.status === undefined || snapshot.graph.status === params.status);
	return paginateSubagentGraphsForTest(snapshots, params.limit, params.cursor);
}

export function paginateSubagentGraphsForTest(
	snapshots: readonly SubagentGraphSnapshot[],
	requestedLimit?: number,
	cursor?: string
): { graphs: SubagentGraphSnapshot[]; nextCursor: string | null } {
	let start: number = 0;
	if (cursor !== undefined) {
		const cursorIndex: number = snapshots.findIndex((snapshot): boolean => snapshot.graph.graphId === cursor);
		if (cursorIndex < 0) throw new Error("Invalid or expired subagent graph cursor.");
		start = cursorIndex + 1;
	}
	const finiteLimit: number = requestedLimit !== undefined && Number.isFinite(requestedLimit)
		? Math.trunc(requestedLimit)
		: 50;
	const limit: number = Math.max(1, Math.min(200, finiteLimit));
	const graphs: SubagentGraphSnapshot[] = snapshots.slice(start, start + limit).map((snapshot): SubagentGraphSnapshot => structuredClone(snapshot));
	return { graphs, nextCursor: start + limit < snapshots.length ? graphs.at(-1)?.graph.graphId ?? null : null };
}

export function assertSubagentGraphOwnershipForTest(
	snapshot: SubagentGraphSnapshot,
	session: ClientSession,
	parentRunId?: string
): void {
	assertGraphOwnership(snapshot, session, parentRunId);
}

async function cancelBindingNodes(
	binding: SubagentRuntimeBinding,
	nodeIds?: readonly string[]
): Promise<SubagentGraphSnapshot> {
	const current: SubagentGraphSnapshot = binding.scheduler.getSnapshot();
	const requested: ReadonlySet<string> | null = nodeIds === undefined ? null : new Set(nodeIds);
	const targets: SubagentNode[] = current.nodes.filter((node: SubagentNode): boolean => (
		requested === null || requested.has(node.nodeId)
	));
	if (requested !== null && targets.length !== requested.size) {
		throw new Error("One or more requested subagent nodes do not exist.");
	}

	const detachedApprovalIdsByRunId: Map<string, string[]> = new Map();
	for (const node of targets) {
		const approvalIds: string[] = binding.session.approvalGateway.listPending()
			.filter((approval): boolean => approval.requestId === node.runId)
			.map((approval): string => approval.approvalId);
		for (const approvalId of approvalIds) {
			binding.session.approvalGateway.removePending(approvalId);
			binding.session.pendingAiContinuations.delete(approvalId);
		}
		detachedApprovalIdsByRunId.set(node.runId, approvalIds);
	}

	let next: SubagentGraphSnapshot;
	if (nodeIds === undefined) {
		next = await binding.scheduler.cancel();
	} else {
		next = current;
		for (const nodeId of nodeIds) next = await binding.scheduler.cancel(nodeId);
	}
	for (const node of targets) {
		const persistedApprovalIds: string[] = await cancelPendingApprovalsForRequest(binding.session, node.runId);
		const approvalIds: ReadonlySet<string> = new Set([
			...(detachedApprovalIdsByRunId.get(node.runId) ?? []),
			...persistedApprovalIds
		]);
		for (const approvalId of approvalIds) emitApprovalEvent(binding, node, approvalId, "cancelled");
	}
	return next;
}

export async function cancelSubagentGraph(params: {
	socket: WebSocket; session: ClientSession; mcpHost: McpHost; graphId: string; nodeId?: string | undefined; reason?: string | undefined;
}): Promise<SubagentGraphSnapshot> {
	const binding = await requireBinding(params);
	return cancelBindingNodes(binding, params.nodeId === undefined ? undefined : [params.nodeId]);
}

export async function retrySubagentNode(params: {
	socket: WebSocket; session: ClientSession; mcpHost: McpHost; graphId: string; nodeId: string;
}): Promise<SubagentGraphSnapshot> {
	const binding = await requireBinding(params);
	return binding.scheduler.retry(params.nodeId, `subrun-${randomUUID()}`);
}

export async function previewSubagentNodeMerge(params: {
	socket: WebSocket; session: ClientSession; mcpHost: McpHost; graphId: string; nodeId: string;
}): Promise<Record<string, unknown>> {
	const binding = await requireBinding(params);
	const node: SubagentNode | undefined = binding.scheduler.getSnapshot().nodes.find((candidate): boolean => candidate.nodeId === params.nodeId);
	if (node === undefined) throw new Error(`Unknown subagent node: ${params.nodeId}.`);
	if (node.worktreeMetadata === null || binding.sourceWorkspace === undefined) throw new Error("Subagent node has no managed worktree.");
	const preview: SubagentMergePreview = await previewSubagentMerge({
		graphId: params.graphId,
		nodeId: params.nodeId,
		metadata: node.worktreeMetadata.managedMetadata,
		sourceWorkspace: binding.sourceWorkspace
	});
	const refreshed: SubagentWorktreeMetadata = await readWorktreeMetadata(node.worktreeMetadata.managedMetadata);
	await updateNodeWorktreeMetadata(binding, node, {
		...node.worktreeMetadata,
		sourceStates: refreshed.sourceStates,
		mergeStatus: preview.allowed ? "previewed" : "conflict"
	});
	sendSessionEvent(binding.socket, node.runId, binding.session, "agent.subgraph.merge.state", {
		graphId: params.graphId, nodeId: node.nodeId, parentRunId: binding.parentRunId, runId: node.runId,
		revision: binding.scheduler.getSnapshot().graph.revision,
		status: preview.allowed ? "preview_ready" : "conflicted", fingerprint: preview.fingerprint,
		message: preview.allowed ? "Merge preview is ready." : "Merge preview found a conflict or incompatible target state."
	}, binding.parentRunId);
	return preview as unknown as Record<string, unknown>;
}

export async function applySubagentNodeMerge(params: {
	socket: WebSocket; session: ClientSession; mcpHost: McpHost; graphId: string; nodeId: string; fingerprint: string;
}): Promise<Record<string, unknown>> {
	const binding = await requireBinding(params);
	const node: SubagentNode | undefined = binding.scheduler.getSnapshot().nodes.find((candidate): boolean => candidate.nodeId === params.nodeId);
	if (node === undefined) throw new Error(`Unknown subagent node: ${params.nodeId}.`);
	if (node.status !== "completed") throw new Error("Only a completed subagent node can be merged.");
	if (node.worktreeMetadata === null || binding.sourceWorkspace === undefined) throw new Error("Subagent node has no managed worktree.");
	await updateNodeWorktreeMetadata(binding, node, { ...node.worktreeMetadata, mergeStatus: "pending" });
	sendSessionEvent(binding.socket, node.runId, binding.session, "agent.subgraph.merge.state", {
		graphId: params.graphId, nodeId: node.nodeId, parentRunId: binding.parentRunId, runId: node.runId,
		revision: binding.scheduler.getSnapshot().graph.revision, status: "merging", fingerprint: params.fingerprint
	}, binding.parentRunId);
	try {
		const applied = await applySubagentMerge({
			graphId: params.graphId,
			nodeId: params.nodeId,
			metadata: node.worktreeMetadata.managedMetadata,
			sourceWorkspace: binding.sourceWorkspace,
			fingerprint: params.fingerprint
		});
		const metadata: SubagentWorktreeMetadata = {
			...node.worktreeMetadata,
			managedMetadata: applied.metadata,
			mergeStatus: "merged"
		};
		await updateNodeWorktreeMetadata(binding, node, metadata);
		sendSessionEvent(binding.socket, node.runId, binding.session, "agent.subgraph.merge.state", {
			graphId: params.graphId, nodeId: node.nodeId, parentRunId: binding.parentRunId, runId: node.runId,
			revision: binding.scheduler.getSnapshot().graph.revision, status: "merged", fingerprint: params.fingerprint
		}, binding.parentRunId);
		return { merged: true, metadata, preview: applied.preview };
	} catch (error: unknown) {
		const errorCode: string | undefined = typeof (error as { code?: unknown }).code === "string"
			? (error as { code: string }).code
			: undefined;
		const conflicted: boolean = errorCode === "subagent_merge_blocked";
		await updateNodeWorktreeMetadata(binding, node, {
			...node.worktreeMetadata,
			mergeStatus: conflicted ? "conflict" : "failed"
		});
		sendSessionEvent(binding.socket, node.runId, binding.session, "agent.subgraph.merge.state", {
			graphId: params.graphId, nodeId: node.nodeId, parentRunId: binding.parentRunId, runId: node.runId,
			revision: binding.scheduler.getSnapshot().graph.revision,
			status: conflicted ? "conflicted" : "failed",
			fingerprint: params.fingerprint,
			message: error instanceof Error ? error.message : String(error)
		}, binding.parentRunId);
		throw error;
	}
}

async function updateNodeWorktreeMetadata(
	binding: SubagentRuntimeBinding,
	node: SubagentNode,
	metadata: SubagentWorktreeMetadata
): Promise<void> {
	const scheduler = binding.scheduler as SubagentGraphScheduler & {
		updateWorktreeMetadata?: (nodeId: string, metadata: SubagentWorktreeMetadata) => Promise<SubagentGraphSnapshot>;
	};
	if (scheduler.updateWorktreeMetadata === undefined) {
		throw new Error("Subagent scheduler does not support worktree lifecycle updates.");
	}
	await scheduler.updateWorktreeMetadata(node.nodeId, metadata);
}

export async function handleSubagentContinuationResult(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	pendingContinuation: PendingAiContinuation;
	agentResult: ProviderAgentResult;
	approvalId: string;
	status: "approved" | "rejected";
}): Promise<void> {
	const correlation = params.pendingContinuation.subagent;
	if (correlation === undefined) throw new Error("Subagent continuation correlation is missing.");
	const binding = await requireBinding({ graphId: correlation.graphId, socket: params.socket, session: params.session, mcpHost: params.mcpHost });
	const node: SubagentNode | undefined = binding.scheduler.getSnapshot().nodes.find((candidate): boolean => candidate.nodeId === correlation.nodeId);
	if (node === undefined) throw new Error(`Unknown subagent node: ${correlation.nodeId}.`);
	emitApprovalEvent(binding, node, params.approvalId, params.status);
	if (params.agentResult.status === "approval_required") {
		const next: PendingAiContinuation = {
			...params.pendingContinuation,
			continuation: params.agentResult.continuation,
			subagent: correlation
		};
		await pauseRunForApproval({
			socket: params.socket,
			requestId: node.runId,
			session: params.session,
			mcpHost: params.mcpHost,
			runId: node.runId,
			agentResult: params.agentResult,
			pendingContinuation: next,
			persistRequestId: node.runId
		});
		emitApprovalEvent(binding, node, params.agentResult.approvalId, "requested");
		return;
	}
	try {
		const changedFiles: string[] = await collectChangedFiles(node);
		await refreshExecutionWorktreeState(binding, node);
		const result: SubagentResult = parseSubagentResult(resultText(params.agentResult), changedFiles);
		if (result.status === "failed") {
			const failure: SubagentFailure = reportedSubagentFailure(result);
			finishAgentRun(binding, node, "failed", failure.message);
			await binding.scheduler.fail(node.nodeId, failure, result);
		} else if (result.status === "cancelled") {
			finishAgentRun(binding, node, "cancelled", result.summary);
			await binding.scheduler.cancelWithResult(node.nodeId, result);
		} else {
			finishAgentRun(binding, node, "completed", result.summary);
			await binding.scheduler.complete(node.nodeId, result);
		}
	} catch (error: unknown) {
		finishAgentRun(binding, node, "failed", error instanceof Error ? error.message : String(error));
		await binding.scheduler.fail(node.nodeId, {
			code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "subagent_continuation_failed",
			message: error instanceof Error ? error.message : String(error),
			retryable: true,
			failedAt: new Date().toISOString()
		});
		throw error;
	}
}

export async function resumeSubagentGraphs(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
}): Promise<SubagentGraphSnapshot[]> {
	const sessionId: string = assertSessionId(params.session);
	const snapshots: SubagentGraphSnapshot[] = await listRecoverableSubagentGraphSnapshots(sessionId);
	const resumed: SubagentGraphSnapshot[] = [];
	for (const snapshot of snapshots) {
		const binding = createBinding({ snapshot, ...params });
		resumed.push(await binding.scheduler.start());
	}
	return resumed;
}

export async function cancelSubagentGraphsForRootRun(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	rootRunId: string;
}): Promise<void> {
	const snapshots: SubagentGraphSnapshot[] = await listSubagentGraphSnapshots(assertSessionId(params.session));
	for (const snapshot of snapshots) {
		if (snapshot.graph.rootRunId !== params.rootRunId) continue;
		if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(snapshot.graph.status)) continue;
		const binding = await requireBinding({ graphId: snapshot.graph.graphId, ...params });
		await cancelBindingNodes(binding);
	}
}
