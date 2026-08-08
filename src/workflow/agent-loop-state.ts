import { createHash } from "node:crypto";
import { cloneToolFailure, type ToolFailure } from "../tools/tool-failure.js";

export const AGENT_LOOP_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_AGENT_LOOP_RECOVERY_ATTEMPTS = 3 as const;

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
	updatedAt: string;
};

export type AgentLoopState = {
	schemaVersion: typeof AGENT_LOOP_STATE_SCHEMA_VERSION;
	recoveryEntries: AgentLoopRecoveryEntry[];
};

export type AgentLoopRecoveryController = {
	state: AgentLoopState;
	beforeCall(toolName: string, args: Record<string, unknown>): ToolFailure | undefined;
	recordFailure(toolName: string, args: Record<string, unknown>, failure: ToolFailure): ToolFailure;
	recordSuccess(toolName: string, args: Record<string, unknown>): AgentLoopRecoveryStatus | undefined;
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
	return { schemaVersion: AGENT_LOOP_STATE_SCHEMA_VERSION, recoveryEntries: [] };
}

export function cloneAgentLoopState(state: AgentLoopState): AgentLoopState {
	return {
		schemaVersion: AGENT_LOOP_STATE_SCHEMA_VERSION,
		recoveryEntries: state.recoveryEntries.map((entry): AgentLoopRecoveryEntry => ({ ...entry }))
	};
}

export function isAgentLoopState(value: unknown): value is AgentLoopState {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === AGENT_LOOP_STATE_SCHEMA_VERSION
		&& Array.isArray(record.recoveryEntries)
		&& record.recoveryEntries.every((entry: unknown): boolean => {
			if (entry === null || typeof entry !== "object") return false;
			const item = entry as Record<string, unknown>;
			return typeof item.recoveryKey === "string"
				&& typeof item.toolName === "string"
				&& typeof item.attempts === "number"
				&& (item.status === "unresolved" || item.status === "recovered" || item.status === "exhausted")
				&& typeof item.updatedAt === "string";
		});
}

export function createAgentLoopRecoveryController(state: AgentLoopState): AgentLoopRecoveryController {
	const findEntry = (recoveryKey: string): AgentLoopRecoveryEntry | undefined => (
		state.recoveryEntries.find((entry): boolean => entry.recoveryKey === recoveryKey)
	);
	return {
		state,
		beforeCall(toolName: string, args: Record<string, unknown>): ToolFailure | undefined {
			const recoveryKey: string = createAgentLoopRecoveryKey(toolName, args);
			const entry: AgentLoopRecoveryEntry | undefined = findEntry(recoveryKey);
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
		}
	};
}
