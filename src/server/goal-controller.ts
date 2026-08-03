import type WebSocket from "ws";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import type { McpHost } from "../mcp/mcp-host.js";
import { chatWithProvider, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { parseJsonObjectFromLlm } from "../providers/llm-json.js";
import { normalizeConfiguredProviderBaseUrl } from "../providers/provider-base-url.js";
import { loadProviderConfigWithSecret } from "../providers/provider-config-store.js";
import { getProviderAdapterFamily, getProviderDefaultModel, getProviderEndpointTypeForModel } from "../providers/provider-registry.js";
import { resolveProviderTaskModelOptions } from "../providers/task-model-routing.js";
import type { AiChatParams, ClientRequest } from "../protocol/types.js";
import {
	linkAgentGoalRun,
	listAgentGoalRunIds,
	dismissAgentGoalState,
	readAgentGoalState,
	readCurrentAgentGoal,
	readLatestAgentGoal,
	saveAgentGoalState
} from "../session/agent-goal-store.js";
import { readAgentRunState, saveAgentRunState } from "../session/agent-run-store.js";
import { resolveModelProfile } from "../tokens/model-profiles.js";
import { getGoalCheckpointsRoot } from "../app-paths.js";
import { createFallbackWorkflowRoute } from "../workflow/router.js";
import { createGodotRuntimeStatus } from "./godot-runtime-status.js";
import { listUsageMetricsLogs } from "../usage/metrics-store.js";
import type { UsageMetricsLog } from "../usage/metrics-types.js";
import { waitForGoalCheckpointWrites } from "./goal-checkpoints.js";
import {
	cloneAgentGoalState,
	createAgentGoalState,
	hasAgentGoalBudget,
	isAgentGoalTerminal,
	transitionAgentGoalState,
	type AgentGoalPauseReason,
	type AgentGoalState,
	type GoalEvaluation,
	type GoalReadinessCheck,
	type GoalReadinessReport
} from "../workflow/agent-goal-state.js";
import type { AgentRunState, ExecutionEvidence } from "../workflow/agent-run-state.js";
import type { ApprovalMode } from "../tools/tool-policy.js";
import type { ClientSession } from "./client-session.js";
import { bindGoalRun, registerGoalRunListener, releaseGoalRunBinding } from "./goal-run-observer.js";
import { enqueueSessionEventWrite, sendStudioPersistentSessionEvent } from "./session-events.js";

type ChatRunner = (socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost) => Promise<void>;

type GoalRuntime = {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	runChat: ChatRunner;
	initialParams: AiChatParams;
	lastRunId: string | null;
	cycleStartedAt: number | null;
	evaluationInFlight: boolean;
	processedTerminalRunIds: Set<string>;
	lastProgressFingerprint: string | null;
	cycleInFlight: boolean;
	continuationRequested: boolean;
	continuationScheduled: boolean;
};

const evaluationSchema = z.object({
	disposition: z.enum(["achieved", "continue", "blocked"]),
	summary: z.string().trim().min(1).max(4000),
	evidenceToolCallIds: z.array(z.string().trim().min(1).max(240)).max(64).default([]),
	unmetCriteria: z.array(z.string().trim().min(1).max(1000)).max(32).default([]),
	nextAction: z.string().trim().min(1).max(2000).nullable().default(null)
}).strict();

const runtimes = new Map<string, GoalRuntime>();
const latestGoalStates = new Map<string, AgentGoalState>();
// 终态事件可能在面板关闭后才到达；进程内墓碑配合 dismissed_at 防止面板复活。
const dismissedGoalIds = new Set<string>();

export function emitAgentGoalState(socket: WebSocket, session: ClientSession, state: AgentGoalState): void {
	if (dismissedGoalIds.has(state.goalId)) return;
	const snapshot: AgentGoalState = cloneAgentGoalState(state);
	latestGoalStates.set(state.goalId, snapshot);
	if (isAgentGoalTerminal(state.stage)) runtimes.delete(state.goalId);
	enqueueSessionEventWrite(session, async (): Promise<void> => saveAgentGoalState(snapshot));
	sendStudioPersistentSessionEvent(
		socket,
		session,
		state.sessionId,
		state.rootRequestId,
		"agent.goal.state",
		snapshot as unknown as Record<string, unknown>
	);
}

export async function getCurrentAgentGoal(sessionId: string): Promise<AgentGoalState | null> {
	const inMemory = [...latestGoalStates.values()].find((state: AgentGoalState): boolean => state.sessionId === sessionId && !isAgentGoalTerminal(state.stage));
	if (inMemory !== undefined) return cloneAgentGoalState(inMemory);
	return readCurrentAgentGoal(sessionId);
}

export function createAgentGoalTelemetrySnapshot(
	state: AgentGoalState,
	runIds: readonly string[],
	logs: readonly Pick<UsageMetricsLog, "requestId" | "runId" | "realTotalTokens" | "usageSource">[],
	activeElapsedMilliseconds: number = 0,
	tokenStrategy: "add" | "max" = "add"
): AgentGoalState {
	const linkedIds = new Set(runIds);
	const linkedLogs = logs.filter((log): boolean => (
		linkedIds.has(log.requestId) || (log.runId !== undefined && linkedIds.has(log.runId))
	));
	const measuredTokens: number = linkedLogs.reduce(
		(sum: number, log): number => sum + Math.max(0, log.realTotalTokens),
		0
	);
	const snapshot = cloneAgentGoalState(state);
	snapshot.usage = {
		...snapshot.usage,
		tokens: tokenStrategy === "add"
			? snapshot.usage.tokens + measuredTokens
			: Math.max(snapshot.usage.tokens, measuredTokens),
		activeMilliseconds: snapshot.usage.activeMilliseconds + Math.max(0, activeElapsedMilliseconds),
		estimatedTokens: snapshot.usage.estimatedTokens || linkedLogs.some((log): boolean => log.usageSource !== "provider")
	};
	return snapshot;
}

export async function getCurrentAgentGoalTelemetry(sessionId: string): Promise<AgentGoalState | null> {
	const currentState = await getCurrentAgentGoal(sessionId);
	const state = currentState ?? await getLatestAgentGoal(sessionId);
	if (state === null) return null;
	const isActiveRun = currentState !== null && state.activeRunId !== null;
	const runIds: string[] = isActiveRun
		? [state.activeRunId!]
		: await listAgentGoalRunIds(state.goalId);
	if (runIds.length === 0) return cloneAgentGoalState(state);

	// Active Goal calls are the newest usage rows. Keep telemetry bounded so opening
	// the Popover never turns into an unbounded scan of a long-lived session.
	const logs: UsageMetricsLog[] = (await listUsageMetricsLogs({ sessionId, limit: 500 })).logs;

	const runtime = runtimes.get(state.goalId);
	const activeElapsedMilliseconds: number = runtime?.cycleStartedAt === null || runtime?.cycleStartedAt === undefined
		? 0
		: Math.max(0, Date.now() - runtime.cycleStartedAt);
	return createAgentGoalTelemetrySnapshot(
		state,
		runIds,
		logs,
		activeElapsedMilliseconds,
		isActiveRun ? "add" : "max"
	);
}

export async function getLatestAgentGoal(sessionId: string): Promise<AgentGoalState | null> {
	const states = [...latestGoalStates.values()]
		.filter((state: AgentGoalState): boolean => (
			state.sessionId === sessionId && !dismissedGoalIds.has(state.goalId)
		))
		.sort((left: AgentGoalState, right: AgentGoalState): number => right.updatedAt.localeCompare(left.updatedAt));
	return states[0] === undefined ? readLatestAgentGoal(sessionId) : cloneAgentGoalState(states[0]);
}

export async function pauseAgentGoalAfterDisconnect(sessionId: string): Promise<void> {
	const inMemory = [...latestGoalStates.values()].find((state: AgentGoalState): boolean => (
		state.sessionId === sessionId && !isAgentGoalTerminal(state.stage)
	));
	const current = inMemory ?? await readCurrentAgentGoal(sessionId);
	if (current === null || current.stage === "paused" || isAgentGoalTerminal(current.stage)) return;
	const runtime = runtimes.get(current.goalId);
	const activeElapsed = runtime?.cycleStartedAt === null || runtime?.cycleStartedAt === undefined
		? 0
		: Math.max(0, Date.now() - runtime.cycleStartedAt);
	const next = transitionAgentGoalState(current, "paused", {
		pauseReason: "client_disconnected",
		activeRunId: null,
		usage: {
			...current.usage,
			activeMilliseconds: current.usage.activeMilliseconds + activeElapsed
		}
	});
	latestGoalStates.set(next.goalId, cloneAgentGoalState(next));
	runtimes.delete(next.goalId);
	await saveAgentGoalState(next);
}

export async function refreshAgentGoalCheckpoint(
	goalId: string,
	checkpoint: AgentGoalState["checkpoint"]
): Promise<void> {
	const state = latestGoalStates.get(goalId) ?? await readAgentGoalState(goalId);
	if (state === null || isAgentGoalTerminal(state.stage)) return;
	const next = transitionAgentGoalState(state, state.stage, { checkpoint });
	const runtime = runtimes.get(goalId);
	if (runtime !== undefined) emitAgentGoalState(runtime.socket, runtime.session, next);
	else {
		latestGoalStates.set(goalId, cloneAgentGoalState(next));
		await saveAgentGoalState(next);
	}
}

async function readMutableGoal(goalId: string): Promise<AgentGoalState> {
	const state: AgentGoalState | null = latestGoalStates.get(goalId) ?? await readAgentGoalState(goalId);
	if (state === null) throw Object.assign(new Error(`Unknown goal: ${goalId}.`), { code: "goal_not_found" });
	if (isAgentGoalTerminal(state.stage)) {
		throw Object.assign(new Error(`Goal ${goalId} is already ${state.stage}.`), { code: "goal_already_terminal" });
	}
	return state;
}

async function readLatestGoalState(goalId: string): Promise<AgentGoalState | null> {
	return latestGoalStates.get(goalId) ?? readAgentGoalState(goalId);
}

function createCurrentOptions(state: AgentGoalState, apiKey: string, baseUrl?: string | undefined): ProviderChatOptions {
	const endpointType = getProviderEndpointTypeForModel(state.modelSnapshot.provider, state.modelSnapshot.model);
	return {
		provider: state.modelSnapshot.provider,
		apiKey,
		model: state.modelSnapshot.model,
		baseUrl: normalizeConfiguredProviderBaseUrl(baseUrl),
		endpointType,
		adapterFamily: getProviderAdapterFamily(state.modelSnapshot.provider, endpointType),
		modelProfile: resolveModelProfile(state.modelSnapshot.provider, state.modelSnapshot.model)
	};
}

async function checkReadiness(state: AgentGoalState, runtime: GoalRuntime): Promise<GoalReadinessReport> {
	const checks: GoalReadinessCheck[] = [];
	const fallbackRoute = createFallbackWorkflowRoute({ message: state.condition, mode: "agent" });
	const mutationGoal: boolean = fallbackRoute.intent === "mutate";
	const currentWorkspaceId = runtime.session.activeWorkspace?.id ?? null;
	const config = await loadProviderConfigWithSecret(state.modelSnapshot.provider);
	checks.push(config?.apiKey
		? { id: "provider", status: "passed", message: "Goal provider and API key are available." }
		: { id: "provider", status: "blocked", message: "The Goal provider API key is unavailable.", action: "configure_provider" });
	checks.push(currentWorkspaceId !== state.modelSnapshot.workspaceId
		? {
			id: "workspace",
			status: "blocked",
			message: "The active Workspace no longer matches the Workspace captured when this Goal was created.",
			action: "restore_workspace"
		}
		: runtime.session.activeWorkspace !== undefined
		? { id: "workspace", status: "passed", message: "The session workspace is available." }
		: mutationGoal
			? { id: "workspace", status: "blocked", message: "This Goal appears to modify project state but the session has no workspace.", action: "select_workspace" }
			: { id: "workspace", status: "warning", message: "No workspace is bound; project tools are unavailable." });
	try {
		await mkdir(getGoalCheckpointsRoot(), { recursive: true });
		checks.push({ id: "storage", status: "passed", message: "Goal state and checkpoint storage are writable." });
	} catch (error: unknown) {
		checks.push({
			id: "storage",
			status: "blocked",
			message: error instanceof Error ? error.message : "Goal checkpoint storage is not writable.",
			action: "repair_storage"
		});
	}
	if (mutationGoal) {
		checks.push({
			id: "rollback_coverage",
			status: "warning",
			message: "Complete rollback is guaranteed only for writes with explicit workspace file targets; shell and dynamic MCP writes require approval and disable complete rollback."
		});
	}
	const customMcpFailures = runtime.mcpHost.getCustomServerStatusesForWorkspace(runtime.session.activeWorkspace?.id)
		.filter((status): boolean => status.status === "error");
	if (customMcpFailures.length > 0) {
		checks.push({
			id: "custom_mcp",
			status: "warning",
			message: `${customMcpFailures.length} custom MCP server(s) are unavailable.`
		});
	}
	if (runtime.session.activeWorkspace?.kind === "godot") {
		const runtimeStatus = createGodotRuntimeStatus(runtime.session, runtime.mcpHost);
		const warnings = Array.isArray(runtimeStatus.warnings) ? runtimeStatus.warnings : [];
		if (warnings.length > 0) {
			checks.push({
				id: "godot_bridges",
				status: "warning",
				message: "The Godot Editor or diagnostics bridge is not fully available; headless and static tools may still work."
			});
		}
	}
	checks.push({
		id: "token_usage",
		status: "warning",
		message: "This provider path does not expose complete per-subtask token usage; Goal usage includes a local estimate."
	});
	try {
		if (config?.apiKey) {
			await resolveProviderTaskModelOptions("goalEvaluator", createCurrentOptions(state, config.apiKey, config.baseUrl));
		}
		checks.push({ id: "evaluator", status: "passed", message: "The Goal evaluator model is available or can fall back to the Goal model." });
	} catch (error: unknown) {
		checks.push({
			id: "evaluator",
			status: "blocked",
			message: error instanceof Error ? error.message : "The Goal evaluator model is unavailable.",
			action: "configure_goal_evaluator"
		});
	}
	try {
		const priorRuns = state.usage.cycles > 0 ? await readGoalRuns(state.goalId) : [];
		const contextMessage = priorRuns.length > 0 ? createContinuationPrompt(state, priorRuns) : state.condition;
		const { createContextEstimateResult } = await import("./session-rpc-handlers.js");
		const estimate = await createContextEstimateResult(runtime.session, runtime.mcpHost, {
			provider: state.modelSnapshot.provider,
			model: state.modelSnapshot.model,
			message: contextMessage,
			mode: "goal",
			additionalContext: priorRuns.length > 0 ? [] : runtime.initialParams.additionalContext
		});
		const usedTokens = typeof estimate.usedTokens === "number" ? estimate.usedTokens : 0;
		const contextWindowTokens = typeof estimate.contextWindowTokens === "number" ? estimate.contextWindowTokens : 0;
		checks.push(contextWindowTokens > 0 && usedTokens > contextWindowTokens
			? {
				id: "context",
				status: "blocked",
				message: `Goal context requires ${usedTokens.toLocaleString()} tokens after bounded history selection, exceeding the ${contextWindowTokens.toLocaleString()} token model window.`,
				action: "reduce_context"
			}
			: {
				id: "context",
				status: "passed",
				message: `Goal context fits the selected model window (${usedTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()} tokens).`
			});
	} catch (error: unknown) {
		checks.push({
			id: "context",
			status: "warning",
			message: error instanceof Error ? `Goal context could not be preflighted: ${error.message}` : "Goal context could not be preflighted."
		});
	}
	return {
		ready: !checks.some((check: GoalReadinessCheck): boolean => check.status === "blocked"),
		checks,
		checkedAt: new Date().toISOString()
	};
}

export async function createAgentGoal(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	runChat: ChatRunner;
	requestId: string;
	chatParams: AiChatParams;
}): Promise<AgentGoalState> {
	const sessionId = params.session.sessionId;
	if (sessionId === undefined) {
		throw Object.assign(new Error("A persisted session is required for Goal mode."), { code: "goal_session_required" });
	}
	if (await getCurrentAgentGoal(sessionId) !== null) {
		throw Object.assign(new Error("This session already has an active Goal."), { code: "goal_already_active" });
	}
	const state = createAgentGoalState({
		sessionId,
		rootRequestId: params.requestId,
		title: params.chatParams.message,
		condition: params.chatParams.message,
		modelSnapshot: {
			provider: params.session.activeProvider,
			model: params.session.providerModel ?? params.chatParams.model ?? getProviderDefaultModel(params.session.activeProvider),
			reasoningEffort: params.chatParams.options?.reasoningEffort ?? null,
			approvalMode: params.session.approvalGateway.getMode(),
			workspaceId: params.session.activeWorkspace?.id ?? null
		}
	});
	await saveAgentGoalState(state);
	latestGoalStates.set(state.goalId, cloneAgentGoalState(state));
	runtimes.set(state.goalId, {
		socket: params.socket,
		session: params.session,
		mcpHost: params.mcpHost,
		runChat: params.runChat,
		initialParams: { ...params.chatParams, mode: "agent" },
		lastRunId: null,
		cycleStartedAt: null,
		evaluationInFlight: false,
		processedTerminalRunIds: new Set(),
		lastProgressFingerprint: null,
		cycleInFlight: false,
		continuationRequested: false,
		continuationScheduled: false
	});
	emitAgentGoalState(params.socket, params.session, state);
	return state;
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

async function readGoalRunUsage(run: AgentRunState): Promise<{ tokens: number; estimated: boolean }> {
	try {
		const result = await listUsageMetricsLogs({ sessionId: run.sessionId, limit: 500 });
		const logs = result.logs.filter((log): boolean => log.requestId === run.requestId || log.runId === run.runId);
		if (logs.length > 0) {
			return {
				tokens: logs.reduce((sum, log): number => sum + log.realTotalTokens, 0),
				estimated: logs.some((log): boolean => log.usageSource !== "provider")
			};
		}
	} catch {
		// Fall through to a bounded local estimate.
	}
	return {
		tokens: estimateTokens(run.title + JSON.stringify(run.checkpoint.evidence)),
		estimated: true
	};
}

function createContinuationPrompt(state: AgentGoalState, previousRuns: AgentRunState[]): string {
	const journal = previousRuns.flatMap((run: AgentRunState): ExecutionEvidence[] => run.checkpoint.evidence)
		.slice(-32)
		.map((evidence: ExecutionEvidence) => ({
			toolCallId: evidence.toolCallId,
			toolName: evidence.toolName,
			status: evidence.status,
			validationStatus: evidence.validationStatus,
			artifacts: evidence.artifactRefs.slice(0, 12),
			summary: evidence.summary?.slice(0, 800)
		}));
	return [
		"Continue the active Goal from its safe checkpoint.",
		`Goal: ${state.condition}`,
		`Previous evaluation: ${state.evaluation?.summary ?? "No evaluation yet."}`,
		`Unmet criteria: ${state.evaluation?.unmetCriteria.join("; ") || "not yet established"}`,
		`Next action: ${state.evaluation?.nextAction ?? "Inspect the current state and make the smallest useful progress."}`,
		`Bounded execution journal: ${JSON.stringify(journal).slice(0, 16_000)}`,
		`Successful write fingerprints: ${[...new Set(previousRuns.flatMap((run: AgentRunState): string[] => run.checkpoint.successfulWriteFingerprints))].slice(-32).join(", ") || "none"}`,
		"Do not repeat an already successful equivalent write. Verify changes after the final relevant write."
	].join("\n\n");
}

async function readGoalRuns(goalId: string, currentRun?: AgentRunState): Promise<AgentRunState[]> {
	const runIds = await listAgentGoalRunIds(goalId);
	const runs = (await Promise.all(runIds.map((runId: string): Promise<AgentRunState | null> => readAgentRunState(runId))))
		.filter((run: AgentRunState | null): run is AgentRunState => run !== null);
	if (currentRun !== undefined && !runs.some((run: AgentRunState): boolean => run.runId === currentRun.runId)) {
		runs.push(currentRun);
	}
	return runs.sort((left: AgentRunState, right: AgentRunState): number => (
		(left.goalCycle ?? 0) - (right.goalCycle ?? 0) || left.createdAt.localeCompare(right.createdAt)
	));
}

async function handleGoalCoordinatorFailure(goalId: string, error: unknown): Promise<void> {
	const runtime = runtimes.get(goalId);
	const latestState = await readLatestGoalState(goalId);
	if (runtime === undefined || latestState === null || isAgentGoalTerminal(latestState.stage)) return;
	const paused = transitionAgentGoalState(latestState, "paused", {
		pauseReason: "readiness_blocked",
		activeRunId: null,
		evaluation: {
			disposition: "blocked",
			summary: error instanceof Error ? error.message : String(error),
			evidenceToolCallIds: [],
			unmetCriteria: ["The next Goal cycle could not be started safely."],
			nextAction: null
		}
	});
	emitAgentGoalState(runtime.socket, runtime.session, paused);
}

function scheduleGoalContinuation(goalId: string, runtime: GoalRuntime): void {
	if (runtime.continuationScheduled || runtime.cycleInFlight) return;
	runtime.continuationScheduled = true;
	queueMicrotask((): void => {
		runtime.continuationScheduled = false;
		if (runtimes.get(goalId) !== runtime || !runtime.continuationRequested || runtime.cycleInFlight) return;
		runtime.continuationRequested = false;
		runtime.cycleInFlight = true;
		void runNextGoalCycle(goalId)
			.catch((error: unknown): Promise<void> => handleGoalCoordinatorFailure(goalId, error))
			.finally((): void => {
				runtime.cycleInFlight = false;
				if (runtimes.get(goalId) === runtime && runtime.continuationRequested) {
					scheduleGoalContinuation(goalId, runtime);
				}
			});
	});
}

export function continueAgentGoal(goalId: string): void {
	const runtime = runtimes.get(goalId);
	if (runtime === undefined) return;
	runtime.continuationRequested = true;
	scheduleGoalContinuation(goalId, runtime);
}

async function runNextGoalCycle(goalId: string): Promise<void> {
	const runtime = runtimes.get(goalId);
	if (runtime === undefined) return;
	let state = await readMutableGoal(goalId);
	if (state.stage !== "readiness" && state.stage !== "evaluating") return;
	if (runtime.session.queuedMessages.some((message): boolean => message.status === "pending" || message.status === "sending")) {
		state = transitionAgentGoalState(state, "paused", {
			pauseReason: "user_interruption",
			activeRunId: null
		});
		emitAgentGoalState(runtime.socket, runtime.session, state);
		return;
	}
	const readiness = await checkReadiness(state, runtime);
	if (!readiness.ready) {
		state = transitionAgentGoalState(state, "paused", { readiness, pauseReason: "readiness_blocked", activeRunId: null });
		emitAgentGoalState(runtime.socket, runtime.session, state);
		return;
	}
	if (!hasAgentGoalBudget(state)) {
		state = transitionAgentGoalState(state, "paused", { readiness, pauseReason: "budget_exhausted", activeRunId: null });
		emitAgentGoalState(runtime.socket, runtime.session, state);
		return;
	}

	const cycle = state.usage.cycles + 1;
	const requestId = cycle === 1 && runtime.lastRunId === null
		? state.rootRequestId
		: `${goalId}:cycle:${cycle}`;
	state = transitionAgentGoalState(state, "running", {
		readiness,
		pauseReason: null,
		activeRunId: requestId,
		cycle,
		usage: { ...state.usage, cycles: cycle }
	});
	runtime.cycleStartedAt = Date.now();
	emitAgentGoalState(runtime.socket, runtime.session, state);
	bindGoalRun(requestId, {
		goalId,
		cycle,
		rootRequestId: state.rootRequestId,
		approvalMode: state.modelSnapshot.approvalMode as ApprovalMode
	});
	const previousRuns = runtime.lastRunId === null ? [] : await readGoalRuns(goalId);
	const childParams: AiChatParams = cycle === 1 && runtime.lastRunId === null
		? { ...runtime.initialParams, mode: "agent" }
		: {
			...runtime.initialParams,
			message: createContinuationPrompt(state, previousRuns),
			mode: "agent",
			retryOfRunId: runtime.lastRunId ?? undefined,
			additionalContext: undefined
		};
	const childRequest: ClientRequest = { type: "request", id: requestId, method: "ai.chat", params: childParams };
	try {
		await runtime.runChat(runtime.socket, childRequest, runtime.session, runtime.mcpHost);
	} catch (error: unknown) {
		const latest = await readMutableGoal(goalId);
		const failed = transitionAgentGoalState(latest, "failed", {
			activeRunId: null,
			evaluation: {
				disposition: "blocked",
				summary: error instanceof Error ? error.message : String(error),
				evidenceToolCallIds: [],
				unmetCriteria: ["The Goal run failed before evaluation."],
				nextAction: null
			}
		});
		emitAgentGoalState(runtime.socket, runtime.session, failed);
	}
}

export function enforceGoalEvaluationGates(evaluation: GoalEvaluation, runs: AgentRunState[]): GoalEvaluation {
	const currentRun = runs.at(-1);
	if (currentRun === undefined) {
		return {
			disposition: "blocked",
			summary: "Goal evaluation has no linked AgentRun evidence.",
			evidenceToolCallIds: [],
			unmetCriteria: ["At least one completed AgentRun is required."],
			nextAction: null
		};
	}
	const successfulEvidence = runs.flatMap((run: AgentRunState): ExecutionEvidence[] => run.checkpoint.evidence)
		.filter((item: ExecutionEvidence): boolean => item.status === "succeeded");
	const evidenceIds = new Set(successfulEvidence.map((item: ExecutionEvidence): string => item.toolCallId));
	const hasActualWrite = successfulEvidence.some((item: ExecutionEvidence): boolean => item.risk === "write" || item.risk === "destructive");
	const hasWriteOrNoChange = hasActualWrite || runs.some((run: AgentRunState): boolean => run.executionDecision?.disposition === "no_change");
	const validationEvidence = successfulEvidence.filter((item: ExecutionEvidence): boolean => item.risk === "verify" || item.validationStatus === "passed");
	const lastWriteMs = Math.max(0, ...runs.map((run: AgentRunState): number => (
		run.checkpoint.lastWriteAt === undefined ? 0 : Date.parse(run.checkpoint.lastWriteAt)
	)));
	const hasPostWriteValidation = runs.some((run: AgentRunState): boolean => run.verificationStatus === "verified")
		&& validationEvidence.some((item: ExecutionEvidence): boolean => Date.parse(item.observedAt) >= lastWriteMs);
	const mutationIntent = runs.some((run: AgentRunState): boolean => run.intent === "mutate");
	let parsed = structuredClone(evaluation);
	const referencesUnknownEvidence = parsed.evidenceToolCallIds.some((id: string): boolean => !evidenceIds.has(id));
	if (referencesUnknownEvidence) {
		parsed = {
			disposition: "blocked",
			summary: "Goal evaluator referenced evidence that is not present in this Goal.",
			evidenceToolCallIds: [],
			unmetCriteria: ["A valid evidence-bound completion evaluation is required."],
			nextAction: null
		};
	}
	if (parsed.disposition === "achieved" && mutationIntent && !hasWriteOrNoChange) {
		parsed = { ...parsed, disposition: "continue", unmetCriteria: [...parsed.unmetCriteria, "No successful write or valid no-change decision exists."], nextAction: "Complete or prove the requested mutation." };
	}
	if (parsed.disposition === "achieved" && mutationIntent && hasActualWrite && !hasPostWriteValidation) {
		parsed = { ...parsed, disposition: "continue", unmetCriteria: [...parsed.unmetCriteria, "No matching verification ran after the final write."], nextAction: "Run a matching verification after the final change." };
	}
	if (parsed.disposition === "achieved" && (currentRun.stage !== "completed" || currentRun.verificationStatus === "failed")) {
		parsed = { ...parsed, disposition: "blocked", unmetCriteria: [...parsed.unmetCriteria, "The latest linked AgentRun did not complete successfully."], nextAction: null };
	}
	const latestRunCanContinue = currentRun.stage === "completed"
		&& currentRun.verificationStatus !== "failed"
		&& currentRun.executionDecision?.disposition !== "blocked"
		&& !referencesUnknownEvidence;
	if (parsed.disposition === "blocked" && latestRunCanContinue) {
		parsed = {
			...parsed,
			disposition: "continue",
			summary: "The evaluator blocker conflicts with the authoritative completed AgentRun state; continue from the latest safe checkpoint.",
			unmetCriteria: parsed.unmetCriteria.length > 0
				? parsed.unmetCriteria
				: ["The Goal has not yet been proven complete by the available evidence."],
			nextAction: parsed.nextAction ?? "Inspect the remaining Goal criteria and continue useful work from the latest evidence."
		};
	}
	return parsed;
}

async function evaluateGoal(state: AgentGoalState, runs: AgentRunState[]): Promise<{ evaluation: GoalEvaluation; estimatedTokens: number }> {
	const currentRun = runs.at(-1);
	if (currentRun === undefined) throw new Error("Goal evaluator requires at least one AgentRun.");
	const successfulEvidence = runs.flatMap((run: AgentRunState): ExecutionEvidence[] => run.checkpoint.evidence)
		.filter((item: ExecutionEvidence): boolean => item.status === "succeeded");
	const promptEvidence = successfulEvidence.slice(-128);

	const config = await loadProviderConfigWithSecret(state.modelSnapshot.provider);
	if (config?.apiKey === undefined) throw new Error("Goal provider API key is unavailable during evaluation.");
	const currentOptions = createCurrentOptions(state, config.apiKey, config.baseUrl);
	const evaluator = await resolveProviderTaskModelOptions("goalEvaluator", currentOptions);
	const prompt = [
		"Evaluate whether the Goal is actually complete. Return only the requested JSON object.",
		"Do not award completion based on an assistant claim. Use only the supplied successful evidence.",
		"The latest linked AgentRun facts below are authoritative. Historical evaluator hints must never override its terminal or verification state.",
		`Goal and completion condition:\n${state.condition}`,
		`Latest linked AgentRun facts:\n${JSON.stringify({
			runId: currentRun.runId,
			goalCycle: currentRun.goalCycle,
			stage: currentRun.stage,
			terminalStatus: currentRun.terminal?.resultStatus ?? null,
			verificationStatus: currentRun.verificationStatus,
			executionDecision: currentRun.executionDecision?.disposition ?? null
		})}`,
		`Goal run intents: ${runs.map((run: AgentRunState): string => run.intent).join(", ")}`,
		`Goal verification statuses: ${runs.map((run: AgentRunState): string => run.verificationStatus ?? "unknown").join(", ")}`,
		`Successful evidence across Goal runs:\n${JSON.stringify(promptEvidence)}`,
		`Historical evaluator hints (non-authoritative):\n${JSON.stringify(state.evaluation === null ? null : {
			unmetCriteria: state.evaluation.unmetCriteria,
			nextAction: state.evaluation.nextAction
		})}`,
		"Schema: {disposition:'achieved'|'continue'|'blocked',summary:string,evidenceToolCallIds:string[],unmetCriteria:string[],nextAction:string|null}"
	].join("\n\n");
	let parsed: GoalEvaluation | null = null;
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const text = await chatWithProvider({
				message: prompt,
				mode: "ask",
				options: { responseFormat: "json", maxTokens: 1800 }
			}, { ...evaluator.options, reasoningMode: "disabled" }, [], "You are Daedalus Goal Evaluator. Be conservative and evidence-bound.");
			parsed = evaluationSchema.parse(parseJsonObjectFromLlm(text, "Goal evaluator did not return valid JSON"));
			break;
		} catch (error: unknown) {
			lastError = error;
		}
	}
	if (parsed === null) throw (lastError instanceof Error ? lastError : new Error("Goal evaluator failed."));
	parsed = enforceGoalEvaluationGates(parsed, runs);
	return { evaluation: parsed, estimatedTokens: estimateTokens(prompt) + estimateTokens(JSON.stringify(parsed)) };
}

function createProgressFingerprint(runs: AgentRunState[], evaluation: GoalEvaluation): string {
	const successfulEvidence = [...new Set(runs.flatMap((run: AgentRunState): ExecutionEvidence[] => run.checkpoint.evidence)
		.filter((item: ExecutionEvidence): boolean => item.status === "succeeded")
		.map((item: ExecutionEvidence) => JSON.stringify({
			toolName: item.toolName,
			risk: item.risk,
			validationStatus: item.validationStatus,
			artifacts: [...item.artifactRefs].sort(),
			summary: item.summary ?? ""
		})))].sort();
	return JSON.stringify({
		evidence: successfulEvidence,
		writes: [...new Set(runs.flatMap((run: AgentRunState): string[] => run.checkpoint.successfulWriteFingerprints))].sort(),
		unmet: [...evaluation.unmetCriteria].sort(),
		next: evaluation.nextAction
	});
}

export type GoalTerminalRunDisposition = "evaluate" | "fail" | "pause";

export type GoalPostEvaluationAction =
	| "achieve"
	| "continue"
	| "pause_blocked"
	| "pause_budget_exhausted"
	| "pause_no_progress";

export function resolveGoalPostEvaluationAction(
	state: AgentGoalState,
	evaluation: GoalEvaluation,
	noProgress: boolean
): GoalPostEvaluationAction {
	if (evaluation.disposition === "achieved") return "achieve";
	if (evaluation.disposition === "blocked") return "pause_blocked";
	if (noProgress) return "pause_no_progress";
	return hasAgentGoalBudget(state) ? "continue" : "pause_budget_exhausted";
}

export function resolveGoalTerminalRunDisposition(
	goalStage: AgentGoalState["stage"],
	runStage: AgentRunState["stage"]
): GoalTerminalRunDisposition {
	if (runStage === "failed") return "fail";
	if (goalStage === "pausing" && (runStage === "completed" || runStage === "cancelled")) return "pause";
	if (runStage === "cancelled") return "fail";
	return "evaluate";
}

async function handleTerminalRun(socket: WebSocket, session: ClientSession, run: AgentRunState): Promise<void> {
	const goalId = run.goalId;
	if (goalId === undefined) return;
	const runtime = runtimes.get(goalId);
	if (runtime === undefined || runtime.processedTerminalRunIds.has(run.runId)) return;
	runtime.processedTerminalRunIds.add(run.runId);
	runtime.lastRunId = run.runId;
	let checkpointFailure: string | null = null;
	try {
		await waitForGoalCheckpointWrites(run.requestId);
	} catch (error: unknown) {
		checkpointFailure = error instanceof Error ? error.message : String(error);
	}
	releaseGoalRunBinding(run.requestId);
	let state = await readMutableGoal(goalId);
	if (checkpointFailure !== null) {
		state = transitionAgentGoalState(state, state.stage, {
			checkpoint: {
				...state.checkpoint,
				status: "unavailable",
				unavailableReasons: [...new Set([...state.checkpoint.unavailableReasons, `checkpoint_capture_failed:${checkpointFailure}`])]
			}
		});
		emitAgentGoalState(socket, session, state);
	}
	const elapsed = runtime.cycleStartedAt === null ? 0 : Math.max(0, Date.now() - runtime.cycleStartedAt);
	runtime.cycleStartedAt = null;
	const runUsage = await readGoalRunUsage(run);
	const usageAfterRun: AgentGoalState["usage"] = {
		...state.usage,
		tokens: state.usage.tokens + runUsage.tokens,
		activeMilliseconds: state.usage.activeMilliseconds + elapsed,
		estimatedTokens: state.usage.estimatedTokens || runUsage.estimated
	};
	const terminalDisposition = resolveGoalTerminalRunDisposition(state.stage, run.stage);
	if (terminalDisposition === "pause") {
		const paused = transitionAgentGoalState(state, "paused", {
			pauseReason: "user_interruption",
			activeRunId: null,
			usage: usageAfterRun
		});
		emitAgentGoalState(socket, session, paused);
		return;
	}
	if (terminalDisposition === "fail") {
		const failed = transitionAgentGoalState(state, "failed", {
			pauseReason: null,
			activeRunId: null,
			usage: usageAfterRun,
			evaluation: {
				disposition: "blocked",
				summary: run.terminal?.message ?? "The linked AgentRun failed.",
				evidenceToolCallIds: [],
				unmetCriteria: ["The execution run must complete successfully."],
				nextAction: null
			}
		});
		emitAgentGoalState(socket, session, failed);
		return;
	}
	if (state.stage === "awaiting_approval" || state.stage === "awaiting_tool_budget") {
		state = transitionAgentGoalState(state, "running", { activeRunId: run.runId });
	}
	state = transitionAgentGoalState(state, "evaluating", {
		activeRunId: null,
		usage: usageAfterRun
	});
	emitAgentGoalState(socket, session, state);
	runtime.evaluationInFlight = true;
	try {
		const evaluationStartedAt = Date.now();
		const goalRuns = await readGoalRuns(goalId, run);
		const result = await evaluateGoal(state, goalRuns);
		runtime.evaluationInFlight = false;
		const evaluationElapsed = Math.max(0, Date.now() - evaluationStartedAt);
		const progressFingerprint = createProgressFingerprint(goalRuns, result.evaluation);
		const noProgress = runtime.lastProgressFingerprint === progressFingerprint;
		runtime.lastProgressFingerprint = progressFingerprint;
		const latestState = await readLatestGoalState(goalId);
		if (latestState === null || isAgentGoalTerminal(latestState.stage)) return;
		const wasInterrupted = latestState.stage === "paused" || latestState.stage === "pausing";
		const nextStage = latestState.stage === "pausing" ? "paused" : latestState.stage;
		state = transitionAgentGoalState(latestState, nextStage, {
			evaluation: result.evaluation,
			usage: {
				...latestState.usage,
				tokens: latestState.usage.tokens + result.estimatedTokens,
				activeMilliseconds: latestState.usage.activeMilliseconds + evaluationElapsed,
				estimatedTokens: true
			}
		});
		emitAgentGoalState(socket, session, state);
		if (wasInterrupted) return;
		const postEvaluationAction = resolveGoalPostEvaluationAction(state, result.evaluation, noProgress);
		if (postEvaluationAction === "achieve") {
			const achieved = transitionAgentGoalState(state, "achieved");
			emitAgentGoalState(socket, session, achieved);
			return;
		}
		if (postEvaluationAction !== "continue") {
			const paused = transitionAgentGoalState(state, "paused", {
				pauseReason: postEvaluationAction === "pause_no_progress"
					? "no_progress"
					: postEvaluationAction === "pause_budget_exhausted"
						? "budget_exhausted"
						: "readiness_blocked"
			});
			emitAgentGoalState(socket, session, paused);
			return;
		}
		continueAgentGoal(goalId);
	} catch (error: unknown) {
		runtime.evaluationInFlight = false;
		const latestState = await readLatestGoalState(goalId);
		if (latestState === null || isAgentGoalTerminal(latestState.stage)) return;
		const paused = transitionAgentGoalState(latestState, "paused", {
			pauseReason: "readiness_blocked",
			evaluation: { disposition: "blocked", summary: error instanceof Error ? error.message : String(error), evidenceToolCallIds: [], unmetCriteria: ["Goal evaluation could not be completed."], nextAction: null }
		});
		emitAgentGoalState(socket, session, paused);
	}
}

function observeGoalRun(socket: WebSocket, session: ClientSession, run: AgentRunState): void {
	if (run.goalId === undefined) return;
	if (run.stage === "awaiting_approval" || run.stage === "awaiting_tool_budget") {
		const goalStage = run.stage;
		void readMutableGoal(run.goalId).then((state: AgentGoalState): void => {
			if (state.stage === "running") {
				const runtime = runtimes.get(run.goalId!);
				const activeElapsed = runtime?.cycleStartedAt === null || runtime?.cycleStartedAt === undefined
					? 0
					: Math.max(0, Date.now() - runtime.cycleStartedAt);
				if (runtime !== undefined) runtime.cycleStartedAt = null;
				const next = transitionAgentGoalState(state, goalStage, {
					activeRunId: run.runId,
					usage: {
						...state.usage,
						activeMilliseconds: state.usage.activeMilliseconds + activeElapsed
					}
				});
				emitAgentGoalState(socket, session, next);
			}
		});
		return;
	}
	if (run.stage === "executing" || run.stage === "verifying") {
		void readMutableGoal(run.goalId).then((state: AgentGoalState): void => {
			if (state.stage === "awaiting_approval" || state.stage === "awaiting_tool_budget") {
				const runtime = runtimes.get(run.goalId!);
				if (runtime !== undefined) runtime.cycleStartedAt = Date.now();
				const next = transitionAgentGoalState(state, "running", { activeRunId: run.runId });
				emitAgentGoalState(socket, session, next);
			}
		});
		return;
	}
	if (run.stage === "completed" || run.stage === "failed" || run.stage === "cancelled") {
		void handleTerminalRun(socket, session, run);
	}
}

registerGoalRunListener(observeGoalRun);

export async function attachGoalRun(run: AgentRunState): Promise<void> {
	if (run.goalId !== undefined && run.goalCycle !== undefined) {
		// agent_goal_runs has a foreign key to agent_runs; persist the run before linking it.
		await saveAgentRunState(run);
		await linkAgentGoalRun(run.goalId, run.runId, run.goalCycle);
	}
}

export async function pauseAgentGoal(
	socket: WebSocket,
	session: ClientSession,
	goalId: string,
	reason: AgentGoalPauseReason = "user_interruption"
): Promise<AgentGoalState> {
	const current = await readMutableGoal(goalId);
	const runtime = runtimes.get(goalId);
	const nextStage = current.activeRunId === null && runtime?.evaluationInFlight !== true ? "paused" : "pausing";
	const next = transitionAgentGoalState(current, nextStage, { pauseReason: reason });
	emitAgentGoalState(socket, session, next);
	return next;
}

export async function resumeAgentGoal(params: {
	socket: WebSocket;
	session: ClientSession;
	mcpHost: McpHost;
	runChat: ChatRunner;
	goalId: string;
}): Promise<AgentGoalState> {
	const current = await readMutableGoal(params.goalId);
	if (current.stage !== "paused") throw Object.assign(new Error(`Goal ${params.goalId} is not paused.`), { code: "goal_not_paused" });
	if (!hasAgentGoalBudget(current)) {
		throw Object.assign(new Error("Goal budget is exhausted. Add enough cycle, token, and active-time budget before resuming."), {
			code: "goal_budget_exhausted"
		});
	}
	const runIds = await listAgentGoalRunIds(params.goalId);
	const previousRuns = await readGoalRuns(params.goalId);
	runtimes.set(params.goalId, {
		socket: params.socket,
		session: params.session,
		mcpHost: params.mcpHost,
		runChat: params.runChat,
		initialParams: {
			message: current.condition,
			mode: "agent",
			provider: current.modelSnapshot.provider,
			model: current.modelSnapshot.model,
			options: { reasoningEffort: current.modelSnapshot.reasoningEffort ?? undefined }
		},
		lastRunId: runIds.at(-1) ?? null,
		cycleStartedAt: null,
		evaluationInFlight: false,
		processedTerminalRunIds: new Set(runIds),
		lastProgressFingerprint: previousRuns.length === 0 || current.evaluation === null
			? null
			: createProgressFingerprint(previousRuns, current.evaluation),
		cycleInFlight: false,
		continuationRequested: false,
		continuationScheduled: false
	});
	const next = transitionAgentGoalState(current, "readiness", { pauseReason: null });
	emitAgentGoalState(params.socket, params.session, next);
	continueAgentGoal(params.goalId);
	return next;
}

export async function cancelAgentGoal(socket: WebSocket, session: ClientSession, goalId: string): Promise<AgentGoalState> {
	const current = await readMutableGoal(goalId);
	if (current.activeRunId !== null) session.activeAbortControllers.get(current.activeRunId)?.abort();
	const next = transitionAgentGoalState(current, "cancelled", { pauseReason: null, activeRunId: null });
	runtimes.delete(goalId);
	emitAgentGoalState(socket, session, next);
	return next;
}

export async function dismissAgentGoal(goalId: string): Promise<{ goalId: string; dismissed: true }> {
	const state: AgentGoalState | null = latestGoalStates.get(goalId) ?? await readAgentGoalState(goalId);
	if (state === null) throw Object.assign(new Error(`Unknown goal: ${goalId}.`), { code: "goal_not_found" });
	if (!isAgentGoalTerminal(state.stage)) {
		throw Object.assign(new Error("Only a completed, failed, or cancelled Goal can be closed."), { code: "goal_not_terminal" });
	}
	if (!await dismissAgentGoalState(goalId)) {
		throw Object.assign(new Error(`Goal ${goalId} could not be closed.`), { code: "goal_dismiss_failed" });
	}
	dismissedGoalIds.add(goalId);
	latestGoalStates.delete(goalId);
	return { goalId, dismissed: true };
}

export async function extendAgentGoalBudget(
	socket: WebSocket,
	session: ClientSession,
	goalId: string,
	increments: { additionalCycles: number; additionalTokens: number; additionalActiveMinutes: number }
): Promise<AgentGoalState> {
	const current = await readMutableGoal(goalId);
	const next = transitionAgentGoalState(current, current.stage, {
		budget: {
			maxCycles: current.budget.maxCycles + increments.additionalCycles,
			maxTokens: current.budget.maxTokens + increments.additionalTokens,
			maxActiveMinutes: current.budget.maxActiveMinutes + increments.additionalActiveMinutes
		}
	});
	emitAgentGoalState(socket, session, next);
	return next;
}

export async function seedGoalRunState(requestId: string, session: ClientSession): Promise<{ goalId: string; cycle: number; rootRequestId: string } | null> {
	const binding = (await import("./goal-run-observer.js")).getGoalRunBinding(requestId);
	if (binding === undefined) return null;
	const existing = session.agentRuns.get(requestId) ?? await readAgentRunState(requestId);
	if (existing !== null && existing !== undefined) await attachGoalRun(existing);
	return binding;
}
