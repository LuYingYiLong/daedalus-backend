import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getHookDataRoot, getHookOutputsRoot } from "../app-paths.js";
import { runCommandInvocationWait } from "../mcp/terminal/process-runner.js";
import { createSandboxInvocation } from "../mcp/terminal/sandbox-runner.js";
import type { TerminalCommandResult } from "../mcp/terminal/types.js";
import { logger } from "../logger.js";
import type { WorkspaceSourceFolder } from "../workspace/types.js";
import { listHookConfigSources, readHookConfigDocument } from "./config-store.js";
import type {
	HookCommandHandler,
	HookConfigDocument,
	HookConfigSource,
	HookDecision,
	HookHandlerSummary,
	HookPermissionMode,
	HookRunRecord,
	HookRunRequest,
	HookRuntimeEvent
} from "./types.js";
import { runPluginHooks } from "../plugins/runtime/hook-adapter.js";

const MAX_RUN_RECORDS: number = 100;
const DEFAULT_CONTEXT_TOKEN_LIMIT: number = 2500;
const MAX_BACKGROUND_PER_SESSION: number = 8;
const MAX_VISIBLE_OUTPUT_CHARS: number = 12_000;
const SECRET_PATTERN: RegExp = /((?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|bearer|cookie)\s*[:=]\s*)([^\s,;]+)/giu;

type ParsedHookOutput = {
	blocked: boolean;
	reason?: string | undefined;
	continueTurn?: boolean | undefined;
	updatedInput?: Record<string, unknown> | undefined;
	additionalContext?: string | undefined;
	systemMessage?: string | undefined;
	approved?: boolean | undefined;
};

type MatchedHook = {
	source: HookConfigSource;
	document: HookConfigDocument;
	summary: HookHandlerSummary;
	handler: HookCommandHandler;
	executionRoot: string;
	cwd: string;
	readOnlyPaths: string[];
};

type AsyncTask = {
	run: () => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function redactHookText(value: string): string {
	return value.replace(SECRET_PATTERN, "$1[redacted]");
}

function clip(value: string, limit: number = MAX_VISIBLE_OUTPUT_CHARS): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function resolvePermissionMode(request: HookRunRequest): HookPermissionMode {
	if (request.chatMode === "plan") return "plan";
	if (request.approvalMode === "full-trust") return "bypassPermissions";
	if (request.approvalMode === "auto-safe") return "acceptEdits";
	return "default";
}

function matcherMatches(pattern: string, value: string): boolean {
	if (pattern === "" || pattern === "*") return true;
	return new RegExp(pattern, "u").test(value);
}

function selectTargetSource(request: HookRunRequest): WorkspaceSourceFolder | undefined {
	const workspace = request.workspace;
	if (workspace === undefined) return undefined;
	return workspace.sourceFolders.find((source: WorkspaceSourceFolder): boolean => source.id === request.targetSourceFolderId)
		?? workspace.sourceFolders.find((source: WorkspaceSourceFolder): boolean => source.id === workspace.primarySourceFolderId)
		?? workspace.sourceFolders[0];
}

function isToolEvent(event: HookRunRequest["event"]): boolean {
	return event === "PreToolUse" || event === "PermissionRequest" || event === "PostToolUse";
}

function parseHookOutput(event: HookRunRequest["event"], stdout: string, stderr: string, exitCode: number | null): ParsedHookOutput {
	const trimmed: string = stdout.trim();
	if (exitCode === 2) {
		return { blocked: true, reason: stderr.trim() || "Hook blocked the operation." };
	}
	if (trimmed.length === 0) return { blocked: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed) as unknown;
	} catch {
		if (event === "SessionStart" || event === "UserPromptSubmit") {
			return { blocked: false, additionalContext: trimmed };
		}
		throw new Error(`${event} hook returned invalid JSON.`);
	}
	const record: Record<string, unknown> | null = asRecord(parsed);
	if (record === null) throw new Error(`${event} hook output must be a JSON object.`);
	const specific: Record<string, unknown> | null = asRecord(record.hookSpecificOutput);
	const decision: string | undefined = asString(record.decision);
	const permissionDecision: string | undefined = asString(specific?.permissionDecision);
	const permissionDecisionReason: string | undefined = asString(specific?.permissionDecisionReason);
	const permissionRequestDecision: Record<string, unknown> | null = asRecord(specific?.decision);
	const behavior: string | undefined = asString(permissionRequestDecision?.behavior);
	const reason: string | undefined = permissionDecisionReason
		?? asString(record.reason)
		?? asString(record.stopReason)
		?? asString(permissionRequestDecision?.message);
	const continueValue: unknown = record.continue;
	return {
		blocked: permissionDecision === "deny" || decision === "block" || behavior === "deny" || continueValue === false,
		reason,
		continueTurn: decision === "block" && (event === "Stop") ? true : continueValue === false ? false : undefined,
		updatedInput: permissionDecision === "allow" ? asRecord(specific?.updatedInput) ?? undefined : undefined,
		additionalContext: asString(specific?.additionalContext),
		systemMessage: asString(record.systemMessage),
		approved: behavior === "allow" ? true : undefined
	};
}

async function spillAdditionalContext(params: {
	sessionId: string;
	limitTokens: number;
	value: string;
}): Promise<string> {
	const safeValue: string = redactHookText(params.value);
	if (params.limitTokens === 0 || safeValue.length <= params.limitTokens * 4) return safeValue;
	const directory: string = join(getHookOutputsRoot(), params.sessionId.replaceAll(/[^A-Za-z0-9._-]/gu, "_"));
	await mkdir(directory, { recursive: true });
	const path: string = join(directory, `${randomUUID()}.txt`);
	await writeFile(path, safeValue, "utf8");
	const previewChars: number = Math.max(400, params.limitTokens * 2);
	return `${safeValue.slice(0, previewChars)}\n\n[Hook output spilled to ${path}]\n\n${safeValue.slice(-previewChars)}`;
}

function createRunRecord(params: {
	request: HookRunRequest;
	hook: MatchedHook;
	startedAtMs: number;
	result: TerminalCommandResult;
	parsed?: ParsedHookOutput | undefined;
	error?: unknown;
}): HookRunRecord {
	const status: HookRunRecord["status"] = params.result.status === "timed_out"
		? "timed_out"
		: params.result.status === "cancelled"
			? "cancelled"
			: params.error !== undefined || !params.result.ok
				? "failed"
				: params.parsed?.blocked === true
					? "blocked"
					: "completed";
	return {
		id: randomUUID(),
		sessionId: params.request.sessionId,
		turnId: params.request.turnId,
		event: params.request.event,
		sourceId: params.hook.source.id,
		fingerprint: params.hook.summary.fingerprint,
		status,
		startedAt: new Date(params.startedAtMs).toISOString(),
		durationMs: Math.max(0, Date.now() - params.startedAtMs),
		exitCode: params.result.exitCode,
		async: params.hook.handler.async === true,
		message: params.error instanceof Error ? params.error.message : params.parsed?.reason,
		stderr: params.result.stderr.length > 0 ? clip(redactHookText(params.result.stderr)) : undefined
	};
}

export class HookRuntime {
	private readonly records: HookRunRecord[] = [];
	private readonly backgroundActive: Map<string, number> = new Map();
	private readonly backgroundQueue: Map<string, AsyncTask[]> = new Map();
	private readonly backgroundControllers: Map<string, Set<AbortController>> = new Map();
	private readonly pendingContext: Map<string, string[]> = new Map();

	listRuns(limit: number = MAX_RUN_RECORDS): HookRunRecord[] {
		return this.records.slice(0, Math.max(1, Math.min(MAX_RUN_RECORDS, limit))).map((record: HookRunRecord): HookRunRecord => structuredClone(record));
	}

	consumeAdditionalContext(sessionId: string): string {
		const values: string[] = this.pendingContext.get(sessionId) ?? [];
		this.pendingContext.delete(sessionId);
		return values.join("\n\n");
	}

	cancelBackground(sessionId: string): void {
		for (const controller of this.backgroundControllers.get(sessionId) ?? []) controller.abort();
		this.backgroundControllers.delete(sessionId);
		this.backgroundQueue.delete(sessionId);
		this.pendingContext.delete(sessionId);
	}

	private addRecord(record: HookRunRecord, onEvent?: ((event: HookRuntimeEvent) => void) | undefined): void {
		this.records.unshift(record);
		if (this.records.length > MAX_RUN_RECORDS) this.records.length = MAX_RUN_RECORDS;
		onEvent?.({ record });
		logger.info("hooks", "command_finished", {
			event: record.event,
			sourceId: record.sourceId,
			status: record.status,
			durationMs: record.durationMs,
			exitCode: record.exitCode
		});
	}

	private async collectMatchedHooks(request: HookRunRequest): Promise<MatchedHook[]> {
		const allSources: HookConfigSource[] = listHookConfigSources(request.workspace);
		const targetSource: WorkspaceSourceFolder | undefined = selectTargetSource(request);
		const sources: HookConfigSource[] = isToolEvent(request.event)
			? allSources.filter((source: HookConfigSource): boolean => source.scope === "global" || source.sourceFolderId === targetSource?.id)
			: allSources;
		const result: MatchedHook[] = [];
		for (const source of sources) {
			const document: HookConfigDocument = await readHookConfigDocument(source);
			if (!document.exists || !document.valid) continue;
			const executionRoot: string = source.scope === "global"
				? targetSource?.path ?? getHookDataRoot()
				: source.rootPath;
			await mkdir(executionRoot, { recursive: true });
			const readOnlyPaths: string[] = [
				...(request.workspace?.sourceFolders.filter((folder: WorkspaceSourceFolder): boolean => folder.path !== executionRoot).map((folder: WorkspaceSourceFolder): string => folder.path) ?? []),
				...(source.scope === "global" ? [source.path] : [])
			];
			for (const summary of document.handlers) {
				if (summary.event !== request.event || summary.trust !== "trusted") continue;
				if (!matcherMatches(summary.matcher, request.matcherValue ?? "")) continue;
				const config = JSON.parse(document.content) as { hooks: Record<string, Array<{ hooks: HookCommandHandler[] }>> };
				const handler: HookCommandHandler | undefined = config.hooks[summary.event]?.[summary.index]?.hooks[summary.handlerIndex];
				if (handler === undefined) continue;
				result.push({ source, document, summary, handler, executionRoot, cwd: executionRoot, readOnlyPaths });
			}
		}
		return result;
	}

	private createInput(request: HookRunRequest, hook: MatchedHook): Record<string, unknown> {
		return {
			session_id: request.sessionId,
			...(request.turnId === undefined ? {} : { turn_id: request.turnId }),
			transcript_path: null,
			cwd: hook.cwd,
			hook_event_name: request.event,
			model: request.model,
			permission_mode: resolvePermissionMode(request),
			daedalus_approval_mode: request.approvalMode,
			...(request.workspace === undefined ? {} : { workspace_id: request.workspace.id }),
			...(hook.source.sourceFolderId === undefined ? {} : { source_folder_id: hook.source.sourceFolderId }),
			...request.input
		};
	}

	private async executeHook(
		request: HookRunRequest,
		hook: MatchedHook,
		onEvent?: ((event: HookRuntimeEvent) => void) | undefined,
		backgroundSignal?: AbortSignal | undefined
	): Promise<ParsedHookOutput> {
		const startedAtMs: number = Date.now();
		onEvent?.({ statusMessage: hook.handler.statusMessage });
		const commandLine: string = process.platform === "win32" ? hook.handler.commandWindows ?? hook.handler.command : hook.handler.command;
		const sandbox = createSandboxInvocation({
			command: { kind: "shell", commandLine },
			cwd: hook.cwd,
			workspaceRoot: hook.executionRoot,
			readOnlyPaths: hook.readOnlyPaths,
			env: {
				DAEDALUS_HOOK_SOURCE: hook.source.id,
				DAEDALUS_HOOK_DATA: getHookDataRoot()
			}
		});
		if (!sandbox.available) {
			const error: Error = new Error(sandbox.error);
			const failedResult: TerminalCommandResult = {
				preset: "hook",
				ok: false,
				status: "spawn_error",
				exitCode: null,
				command: [commandLine],
				commandLine,
				cwd: hook.cwd,
				stdout: "",
				stderr: error.message,
				durationMs: 0,
				truncated: false
			};
			this.addRecord(createRunRecord({ request, hook, startedAtMs, result: failedResult, error }), onEvent);
			if ((hook.handler.failurePolicy ?? "continue") === "block") return { blocked: true, reason: error.message };
			return { blocked: false, systemMessage: error.message };
		}
		const timeoutSeconds: number = request.event === "SessionEnd"
			? Math.min(3, hook.handler.timeout ?? 1)
			: hook.handler.timeout ?? 600;
		const combinedController: AbortController = new AbortController();
		const abort = (): void => combinedController.abort();
		request.abortSignal?.addEventListener("abort", abort, { once: true });
		backgroundSignal?.addEventListener("abort", abort, { once: true });
		let result: TerminalCommandResult;
		try {
			result = await runCommandInvocationWait({
				presetName: "hook",
				invocation: {
					command: sandbox.command,
					args: sandbox.args,
					commandLine,
					env: sandbox.env,
					sandboxMode: sandbox.sandboxMode,
					workspaceId: request.workspace?.id,
					workspaceRoot: hook.executionRoot
				},
				cwd: hook.cwd,
				timeoutMs: timeoutSeconds * 1000,
				stdinText: `${JSON.stringify(this.createInput(request, hook))}\n`,
				killProcessTree: true,
				signal: combinedController.signal
			});
		} finally {
			request.abortSignal?.removeEventListener("abort", abort);
			backgroundSignal?.removeEventListener("abort", abort);
		}
		try {
			const parsed: ParsedHookOutput = parseHookOutput(request.event, result.stdout, result.stderr, result.exitCode);
			if (request.event === "PermissionRequest" && hook.source.scope === "source" && parsed.approved === true) {
				parsed.approved = undefined;
				parsed.systemMessage = "A source-folder PermissionRequest hook attempted to approve an operation; only trusted global hooks may approve ordinary requests.";
			}
			if (parsed.additionalContext !== undefined) {
				parsed.additionalContext = await spillAdditionalContext({
					sessionId: request.sessionId,
					limitTokens: hook.handler.additionalContextLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT,
					value: parsed.additionalContext
				});
			}
			if (!result.ok && result.exitCode !== 2) {
				throw new Error(result.stderr.trim() || `Hook exited with code ${result.exitCode ?? "unknown"}.`);
			}
			this.addRecord(createRunRecord({ request, hook, startedAtMs, result, parsed }), onEvent);
			return parsed;
		} catch (error: unknown) {
			this.addRecord(createRunRecord({ request, hook, startedAtMs, result, error }), onEvent);
			if ((hook.handler.failurePolicy ?? "continue") === "block") {
				return { blocked: true, reason: error instanceof Error ? error.message : String(error) };
			}
			return { blocked: false, systemMessage: error instanceof Error ? error.message : String(error) };
		}
	}

	private scheduleBackground(request: HookRunRequest, hook: MatchedHook, onEvent?: ((event: HookRuntimeEvent) => void) | undefined): void {
		const sessionId: string = request.sessionId;
		const task: AsyncTask = {
			run: async (): Promise<void> => {
				const controller: AbortController = new AbortController();
				const controllers: Set<AbortController> = this.backgroundControllers.get(sessionId) ?? new Set();
				controllers.add(controller);
				this.backgroundControllers.set(sessionId, controllers);
				try {
					const output: ParsedHookOutput = await this.executeHook(request, hook, onEvent, controller.signal);
					if (output.blocked || output.updatedInput !== undefined || output.approved === true) {
						onEvent?.({ systemMessage: "An asynchronous Hook returned a control decision. Async Hooks cannot block, approve, or rewrite operations, so the decision was ignored." });
						logger.warn("hooks", "async_control_ignored", {
							event: request.event,
							sourceId: hook.source.id,
							fingerprint: hook.summary.fingerprint
						});
					}
					if (output.additionalContext !== undefined) {
						const contexts: string[] = this.pendingContext.get(sessionId) ?? [];
						contexts.push(output.additionalContext);
						this.pendingContext.set(sessionId, contexts);
					}
					if (output.systemMessage !== undefined) onEvent?.({ systemMessage: output.systemMessage });
				} finally {
					controllers.delete(controller);
					this.backgroundActive.set(sessionId, Math.max(0, (this.backgroundActive.get(sessionId) ?? 1) - 1));
					this.drainBackground(sessionId);
				}
			}
		};
		const active: number = this.backgroundActive.get(sessionId) ?? 0;
		if (active < MAX_BACKGROUND_PER_SESSION) {
			this.backgroundActive.set(sessionId, active + 1);
			void task.run();
			return;
		}
		const queue: AsyncTask[] = this.backgroundQueue.get(sessionId) ?? [];
		queue.push(task);
		this.backgroundQueue.set(sessionId, queue);
	}

	private drainBackground(sessionId: string): void {
		const queue: AsyncTask[] = this.backgroundQueue.get(sessionId) ?? [];
		const active: number = this.backgroundActive.get(sessionId) ?? 0;
		if (active >= MAX_BACKGROUND_PER_SESSION || queue.length === 0) return;
		const task: AsyncTask = queue.shift()!;
		if (queue.length === 0) this.backgroundQueue.delete(sessionId);
		this.backgroundActive.set(sessionId, active + 1);
		void task.run();
	}

	async run(request: HookRunRequest, onEvent?: ((event: HookRuntimeEvent) => void) | undefined): Promise<HookDecision> {
		const pluginDecision = await runPluginHooks(request, onEvent);
		const matched: MatchedHook[] = await this.collectMatchedHooks(request);
		const synchronous: MatchedHook[] = [];
		for (const hook of matched) {
			if (hook.handler.async === true && request.event !== "SessionEnd") this.scheduleBackground(request, hook, onEvent);
			else synchronous.push(hook);
		}
		const outputs: ParsedHookOutput[] = await Promise.all(synchronous.map(
			async (hook: MatchedHook): Promise<ParsedHookOutput> => await this.executeHook(request, hook, onEvent)
		));
		const blocked: ParsedHookOutput | undefined = outputs.find((output: ParsedHookOutput): boolean => output.blocked);
		const updatedInputs: Record<string, unknown>[] = outputs.flatMap((output: ParsedHookOutput): Record<string, unknown>[] => output.updatedInput === undefined ? [] : [output.updatedInput]);
		let updatedInput: Record<string, unknown> | undefined;
		if (updatedInputs.length > 0) {
			const serialized: Set<string> = new Set(updatedInputs.map((value: Record<string, unknown>): string => JSON.stringify(value)));
			if (serialized.size > 1) {
				return { blocked: true, reason: "Multiple PreToolUse hooks returned conflicting updatedInput values.", systemMessages: [] };
			}
			updatedInput = updatedInputs[0];
		}
		const additionalContext: string = outputs.flatMap((output: ParsedHookOutput): string[] => output.additionalContext === undefined ? [] : [output.additionalContext]).join("\n\n");
		const systemMessages: string[] = outputs.flatMap((output: ParsedHookOutput): string[] => output.systemMessage === undefined ? [] : [output.systemMessage]);
		const approved: boolean = outputs.some((output: ParsedHookOutput): boolean => output.approved === true);
		if (request.event === "SessionEnd") this.cancelBackground(request.sessionId);
		const commandDecision: HookDecision = {
			blocked: blocked !== undefined,
			reason: blocked?.reason,
			continueTurn: blocked?.continueTurn,
			updatedInput,
			additionalContext: additionalContext.length > 0 ? additionalContext : undefined,
			systemMessages,
			approved: approved ? true : undefined
		};
		return {
			blocked: pluginDecision.blocked || commandDecision.blocked,
			reason: pluginDecision.reason ?? commandDecision.reason,
			continueTurn: pluginDecision.continueTurn ?? commandDecision.continueTurn,
			updatedInput: pluginDecision.updatedInput ?? commandDecision.updatedInput,
			additionalContext: [pluginDecision.additionalContext, commandDecision.additionalContext].filter((value): value is string => value !== undefined && value.length > 0).join("\n\n") || undefined,
			systemMessages: [...pluginDecision.systemMessages, ...commandDecision.systemMessages],
			approved: commandDecision.approved
		};
	}
}

export const hookRuntime: HookRuntime = new HookRuntime();
