import { createHash, randomUUID } from "node:crypto";

const AUTHORIZATION_TTL_MS: number = 60_000;
const consumedAuthorizationIds: Set<string> = new Set();

export type TerminalCommandAuthorization = {
	id: string;
	source: "model" | "policy" | "user";
	requestId: string;
	toolCallId: string;
	workspaceId: string | null;
	commandFingerprint: string;
	expiresAt: number;
};

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const record: Record<string, unknown> = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key: string): string => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function createTerminalCommandFingerprint(args: Record<string, unknown>, workspaceId?: string | undefined): string {
	return createHash("sha256").update(stableJson({
		workspaceId: workspaceId ?? null,
		commandLine: args.commandLine ?? null,
		cwd: args.cwd ?? null,
		env: args.env ?? null,
		executionMode: args.executionMode ?? "wait",
		timeoutMs: args.timeoutMs ?? null,
		wakeAfterMs: args.wakeAfterMs ?? null
	})).digest("hex");
}

export function createTerminalCommandAuthorization(params: {
	source: TerminalCommandAuthorization["source"];
	requestId: string;
	toolCallId: string;
	workspaceId?: string | undefined;
	args: Record<string, unknown>;
}): TerminalCommandAuthorization {
	return {
		id: `terminal-authorization-${randomUUID()}`,
		source: params.source,
		requestId: params.requestId,
		toolCallId: params.toolCallId,
		workspaceId: params.workspaceId ?? null,
		commandFingerprint: createTerminalCommandFingerprint(params.args, params.workspaceId),
		expiresAt: Date.now() + AUTHORIZATION_TTL_MS
	};
}

export function consumeTerminalCommandAuthorization(
	authorization: TerminalCommandAuthorization | undefined,
	args: Record<string, unknown>,
	workspaceId?: string | undefined
): { allowed: true; source: TerminalCommandAuthorization["source"] } | { allowed: false; reason: string } {
	if (authorization === undefined) {
		return { allowed: false, reason: "No approved one-shot command authorization was provided." };
	}
	if (authorization.expiresAt < Date.now()) {
		return { allowed: false, reason: "The one-shot command authorization expired." };
	}
	if (consumedAuthorizationIds.has(authorization.id)) {
		return { allowed: false, reason: "The one-shot command authorization was already consumed." };
	}
	if (authorization.workspaceId !== (workspaceId ?? null)) {
		return { allowed: false, reason: "The command authorization workspace does not match." };
	}
	if (authorization.commandFingerprint !== createTerminalCommandFingerprint(args, workspaceId)) {
		return { allowed: false, reason: "The command changed after it was authorized." };
	}
	consumedAuthorizationIds.add(authorization.id);
	return { allowed: true, source: authorization.source };
}
