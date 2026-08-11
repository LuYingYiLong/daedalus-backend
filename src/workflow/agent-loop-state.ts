import { createHash } from "node:crypto";
import { cloneToolFailure, type ToolFailure } from "../tools/tool-failure.js";

export const AGENT_LOOP_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_AGENT_LOOP_RECOVERY_ATTEMPTS = 3 as const;
export const AGENT_LOOP_NO_PROGRESS_WARNING_CALLS = 12 as const;
export const AGENT_LOOP_NO_PROGRESS_EXHAUSTED_CALLS = 18 as const;
export const AGENT_LOOP_MAX_TOOL_CALLS = 512 as const;

export type AgentLoopRecoveryStatus = {
	recoveryKey: string;
	attempt: number;
	maxAttempts: number;
	status: "failed" | "recovered" | "exhausted";
};

export type AgentLoopRecoveryEntry = {
	recoveryKey: string;
	toolName: string;
	attempts: number;
	status: "unresolved" | "recovered" | "exhausted";
	lastFailureCode?: string | undefined;
	lastFailureArgsFingerprint?: string | undefined;
	updatedAt: string;
};

export type AgentLoopProgressState = {
	totalToolCalls: number;
	consecutiveNoProgressCalls: number;
	observedResultKeys: string[];
};

export type AgentLoopState = {
	schemaVersion: typeof AGENT_LOOP_STATE_SCHEMA_VERSION;
	recoveryEntries: AgentLoopRecoveryEntry[];
	/** Optional for persisted v1 continuations created before progress tracking. */
	progress?: AgentLoopProgressState | undefined;
};

export type AgentLoopRecoveryController = {
	state: AgentLoopState;
	beforeCall(toolName: string, args: Record<string, unknown>): ToolFailure | undefined;
	recordFailure(toolName: string, args: Record<string, unknown>, failure: ToolFailure): ToolFailure;
	recordSuccess(toolName: string, args: Record<string, unknown>): AgentLoopRecoveryStatus | undefined;
	recordProgress(toolName: string, args: Record<string, unknown>, resultContent: string): ToolFailure | undefined;
};

const TARGET_ARGUMENT_KEYS: readonly string[] = [
	"sourceFolderId",
	"relativePath",
	"resourcePath",
	"scenePath",
	"scriptPath",
	"path",
	"presetName",
	"setting",
	"actionName",
	"nodePath",
	"signalName"
];

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]): number => left.localeCompare(right))
			.map(([key, item]): string => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function collectStructuredTarget(args: Record<string, unknown>): Record<string, unknown> {
	const target: Record<string, unknown> = {};
	for (const key of TARGET_ARGUMENT_KEYS) {
		const value: unknown = args[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			target[key] = value;
		}
	}
	// Free terminal commands do not have a file reference. Their exact command
	// fingerprint is the safe operation boundary; it is never compared by text.
	if (Object.keys(target).length === 0 && typeof args.commandLine === "string") {
		target.commandLine = args.commandLine;
		target.cwd = typeof args.cwd === "string" ? args.cwd : ".";
	}
	return target;
}

export function createAgentLoopRecoveryKey(toolName: string, args: Record<string, unknown>): string {
	const target: Record<string, unknown> = collectStructuredTarget(args);
	const identity: string = stableJson({
		toolName,
		target: Object.keys(target).length > 0 ? target : args
	});
	return createHash("sha256").update(identity).digest("hex");
}

export function createAgentLoopState(): AgentLoopState {
	return {
		schemaVersion: AGENT_LOOP_STATE_SCHEMA_VERSION,
		recoveryEntries: [],
		progress: {
			totalToolCalls: 0,
			consecutiveNoProgressCalls: 0,
			observedResultKeys: []
		}
	};
}

export function cloneAgentLoopState(state: AgentLoopState): AgentLoopState {
	return {
		schemaVersion: AGENT_LOOP_STATE_SCHEMA_VERSION,
		recoveryEntries: state.recoveryEntries.map((entry): AgentLoopRecoveryEntry => ({ ...entry })),
		progress: state.progress === undefined
			? undefined
			: {
				totalToolCalls: state.progress.totalToolCalls,
				consecutiveNoProgressCalls: state.progress.consecutiveNoProgressCalls,
				observedResultKeys: [...state.progress.observedResultKeys]
			}
	};
}

function isProgressState(value: unknown): value is AgentLoopProgressState {
	if (value === undefined) return true;
	if (value === null || typeof value !== "object") return false;
	const progress = value as Record<string, unknown>;
	return Number.isInteger(progress.totalToolCalls)
		&& (progress.totalToolCalls as number) >= 0
		&& Number.isInteger(progress.consecutiveNoProgressCalls)
		&& (progress.consecutiveNoProgressCalls as number) >= 0
		&& Array.isArray(progress.observedResultKeys)
		&& progress.observedResultKeys.every((key: unknown): boolean => typeof key === "string");
}

export function isAgentLoopState(value: unknown): value is AgentLoopState {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === AGENT_LOOP_STATE_SCHEMA_VERSION
		&& Array.isArray(record.recoveryEntries)
		&& isProgressState(record.progress)
		&& record.recoveryEntries.every((entry: unknown): boolean => {
			if (entry === null || typeof entry !== "object") return false;
			const item = entry as Record<string, unknown>;
			return typeof item.recoveryKey === "string"
				&& typeof item.toolName === "string"
				&& typeof item.attempts === "number"
				&& (item.status === "unresolved" || item.status === "recovered" || item.status === "exhausted")
				&& (item.lastFailureArgsFingerprint === undefined || typeof item.lastFailureArgsFingerprint === "string")
				&& typeof item.updatedAt === "string";
		});
}

export function createAgentLoopRecoveryController(state: AgentLoopState): AgentLoopRecoveryController {
	const getProgress = (): AgentLoopProgressState => {
		state.progress ??= {
			totalToolCalls: 0,
			consecutiveNoProgressCalls: 0,
			observedResultKeys: []
		};
		return state.progress;
	};
	const recordToolCall = (): ToolFailure | undefined => {
		const progress: AgentLoopProgressState = getProgress();
		progress.totalToolCalls += 1;
		if (progress.totalToolCalls > AGENT_LOOP_MAX_TOOL_CALLS) {
			return {
				code: "agent_loop_safety_limit_reached",
				category: "protocol",
				message: "The autonomous Agent Loop reached its background safety limit. Stop requesting tools and summarize the completed work and remaining steps.",
				retryable: false,
				artifactRefs: [],
				details: {
					progress: {
						totalToolCalls: progress.totalToolCalls,
						maxToolCalls: AGENT_LOOP_MAX_TOOL_CALLS
					}
				}
			};
		}
		return undefined;
	};
	const recordResult = (recoveryKey: string, resultContent: string): ToolFailure | undefined => {
		const progress: AgentLoopProgressState = getProgress();
		const resultHash: string = createHash("sha256").update(resultContent).digest("hex");
		const progressKey: string = `${recoveryKey}:${resultHash}`;
		if (!progress.observedResultKeys.includes(progressKey)) {
			progress.observedResultKeys.push(progressKey);
			progress.consecutiveNoProgressCalls = 0;
			return undefined;
		}

		progress.consecutiveNoProgressCalls += 1;
		if (progress.consecutiveNoProgressCalls < AGENT_LOOP_NO_PROGRESS_WARNING_CALLS) {
			return undefined;
		}
		const exhausted: boolean = progress.consecutiveNoProgressCalls >= AGENT_LOOP_NO_PROGRESS_EXHAUSTED_CALLS;
		return {
			code: exhausted ? "agent_loop_no_progress_exhausted" : "agent_loop_no_progress_detected",
			category: "protocol",
			message: exhausted
				? "Repeated tool operations are no longer adding structured progress. Stop repeating them; choose a new target or summarize the current result."
				: "This operation repeats previously observed work without adding a new structured target. Change the approach or gather different evidence before retrying.",
			retryable: !exhausted,
			artifactRefs: [],
			details: {
				progress: {
					consecutiveNoProgressCalls: progress.consecutiveNoProgressCalls,
					warningAt: AGENT_LOOP_NO_PROGRESS_WARNING_CALLS,
					exhaustedAt: AGENT_LOOP_NO_PROGRESS_EXHAUSTED_CALLS
				}
			}
		};
	};
	const findEntry = (recoveryKey: string): AgentLoopRecoveryEntry | undefined => (
		state.recoveryEntries.find((entry): boolean => entry.recoveryKey === recoveryKey)
	);
	return {
		state,
		beforeCall(toolName: string, args: Record<string, unknown>): ToolFailure | undefined {
			const recoveryKey: string = createAgentLoopRecoveryKey(toolName, args);
			const safetyLimitFailure: ToolFailure | undefined = recordToolCall();
			if (safetyLimitFailure !== undefined) return safetyLimitFailure;
			const entry: AgentLoopRecoveryEntry | undefined = findEntry(recoveryKey);
			if (
				entry?.status === "unresolved"
				&& entry.lastFailureCode === "invalid_arguments"
				&& entry.lastFailureArgsFingerprint === stableJson(args)
			) {
				entry.status = "exhausted";
				entry.updatedAt = new Date().toISOString();
				return {
					code: "retry_exhausted",
					category: "protocol",
					message: "The previous tool arguments were rejected and have not changed. Do not repeat this call; correct the structured arguments or choose another safe approach.",
					retryable: false,
					artifactRefs: [],
					details: {
						recovery: {
							recoveryKey,
							attempt: entry.attempts,
							maxAttempts: MAX_AGENT_LOOP_RECOVERY_ATTEMPTS,
							status: "exhausted"
						} satisfies AgentLoopRecoveryStatus
					}
				};
			}
			if (entry === undefined || entry.attempts < MAX_AGENT_LOOP_RECOVERY_ATTEMPTS || entry.status === "recovered") {
				return undefined;
			}
			entry.status = "exhausted";
			entry.updatedAt = new Date().toISOString();
			return {
				code: "retry_exhausted",
				category: "protocol",
				message: "This exact tool operation reached the autonomous recovery limit. Use a materially different safe approach or explain the limitation.",
				retryable: false,
				artifactRefs: [],
				details: {
					recovery: {
						recoveryKey,
						attempt: entry.attempts,
						maxAttempts: MAX_AGENT_LOOP_RECOVERY_ATTEMPTS,
						status: "exhausted"
					} satisfies AgentLoopRecoveryStatus
				}
			};
		},
		recordFailure(toolName: string, args: Record<string, unknown>, failure: ToolFailure): ToolFailure {
			if (!failure.retryable || failure.category === "policy" || failure.code === "retry_exhausted") {
				return cloneToolFailure(failure);
			}
			const recoveryKey: string = createAgentLoopRecoveryKey(toolName, args);
			let entry: AgentLoopRecoveryEntry | undefined = findEntry(recoveryKey);
			if (entry === undefined) {
				entry = {
					recoveryKey,
					toolName,
					attempts: 0,
					status: "unresolved",
					updatedAt: new Date().toISOString()
				};
				state.recoveryEntries.push(entry);
			}
			entry.attempts += 1;
			entry.status = entry.attempts >= MAX_AGENT_LOOP_RECOVERY_ATTEMPTS ? "exhausted" : "unresolved";
			entry.lastFailureCode = failure.code;
			entry.lastFailureArgsFingerprint = failure.code === "invalid_arguments" ? stableJson(args) : undefined;
			entry.updatedAt = new Date().toISOString();
			return {
				...cloneToolFailure(failure),
				details: {
					...(failure.details ?? {}),
					recovery: {
						recoveryKey,
						attempt: entry.attempts,
						maxAttempts: MAX_AGENT_LOOP_RECOVERY_ATTEMPTS,
						status: entry.status === "exhausted" ? "exhausted" : "failed"
					} satisfies AgentLoopRecoveryStatus
				}
			};
		},
		recordSuccess(toolName: string, args: Record<string, unknown>): AgentLoopRecoveryStatus | undefined {
			const recoveryKey: string = createAgentLoopRecoveryKey(toolName, args);
			const entry: AgentLoopRecoveryEntry | undefined = findEntry(recoveryKey);
			if (entry === undefined || entry.status === "recovered") return undefined;
			entry.status = "recovered";
			entry.updatedAt = new Date().toISOString();
			return {
				recoveryKey,
				attempt: entry.attempts,
				maxAttempts: MAX_AGENT_LOOP_RECOVERY_ATTEMPTS,
				status: "recovered"
			};
		},
		recordProgress(toolName: string, args: Record<string, unknown>, resultContent: string): ToolFailure | undefined {
			return recordResult(createAgentLoopRecoveryKey(toolName, args), resultContent);
		}
	};
}
