import { createHash, randomUUID } from "node:crypto";
import type {
	CrossSandboxAuthorizationScope,
	CrossSandboxExecutionBoundary,
	ExternalAccessTarget,
} from "../../tools/cross-sandbox-access.js";

const AUTHORIZATION_TTL_MS: number = 60_000;
const consumedAuthorizationIds: Set<string> = new Set();

export type TerminalCommandAuthorization = {
	id: string;
	source: "model" | "policy" | "user";
	requestId: string;
	toolCallId: string;
	toolName?: string | undefined;
	workspaceId: string | null;
	commandFingerprint: string;
	crossSandbox?: CrossSandboxAuthorizationScope | undefined;
	expiresAt: number;
};

export type AuthorizedProcessInvocation = {
	boundary: CrossSandboxExecutionBoundary;
	commandLine: string;
	cwd: string;
	externalTargets: readonly ExternalAccessTarget[];
	networkAccess: boolean;
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

export function createTerminalCommandFingerprint(
	args: Record<string, unknown>,
	workspaceId?: string | undefined,
	toolName?: string | undefined
): string {
	const publicArgs: Record<string, unknown> = Object.fromEntries(
		Object.entries(args).filter(([key]: [string, unknown]): boolean => !key.startsWith("__daedalus"))
	);
	return createHash("sha256").update(stableJson({
		toolName: toolName ?? null,
		workspaceId: workspaceId ?? null,
		args: publicArgs
	})).digest("hex");
}

export function createTerminalCommandAuthorization(params: {
	source: TerminalCommandAuthorization["source"];
	requestId: string;
	toolCallId: string;
	toolName?: string | undefined;
	workspaceId?: string | undefined;
	args: Record<string, unknown>;
	crossSandbox?: CrossSandboxAuthorizationScope | undefined;
}): TerminalCommandAuthorization {
	return {
		id: `terminal-authorization-${randomUUID()}`,
		source: params.source,
		requestId: params.requestId,
		toolCallId: params.toolCallId,
		toolName: params.toolName,
		workspaceId: params.workspaceId ?? null,
		commandFingerprint: createTerminalCommandFingerprint(params.args, params.workspaceId, params.toolName),
		crossSandbox: params.crossSandbox,
		expiresAt: Date.now() + AUTHORIZATION_TTL_MS
	};
}

export function consumeTerminalCommandAuthorization(
	authorization: TerminalCommandAuthorization | undefined,
	args: Record<string, unknown>,
	workspaceId?: string | undefined,
	invocation?: AuthorizedProcessInvocation | undefined
): { allowed: true; source: TerminalCommandAuthorization["source"] } | { allowed: false; reason: string } {
	if (authorization === undefined) {
		return { allowed: false, reason: "No approved one-shot command authorization was provided." };
	}
	if (authorization.expiresAt < Date.now()) {
		return { allowed: false, reason: "The one-shot command authorization expired." };
	}
	if (authorization.workspaceId !== (workspaceId ?? null)) {
		return { allowed: false, reason: "The command authorization workspace does not match." };
	}
	if (authorization.commandFingerprint !== createTerminalCommandFingerprint(args, workspaceId, authorization.toolName)) {
		return { allowed: false, reason: "The command changed after it was authorized." };
	}
	let consumptionId: string = authorization.id;
	if (invocation !== undefined) {
		const scope: CrossSandboxAuthorizationScope | undefined = authorization.crossSandbox;
		if (scope === undefined) {
			return { allowed: false, reason: "The command authorization does not include cross-sandbox access." };
		}
		if (scope.boundary !== invocation.boundary) {
			return { allowed: false, reason: "The execution boundary changed after it was authorized." };
		}
		if (scope.networkAccess !== invocation.networkAccess) {
			return { allowed: false, reason: "The network access requirement changed after it was authorized." };
		}
		if (stableJson(scope.targets) !== stableJson(invocation.externalTargets)) {
			return { allowed: false, reason: "The external access targets changed after they were authorized." };
		}
		const invocationFingerprint: string = createHash("sha256").update(stableJson(invocation)).digest("hex");
		consumptionId = `${authorization.id}:${invocationFingerprint}`;
	}
	if (consumedAuthorizationIds.has(consumptionId)) {
		return { allowed: false, reason: "The one-shot command authorization was already consumed." };
	}
	consumedAuthorizationIds.add(consumptionId);
	return { allowed: true, source: authorization.source };
}

export function getAuthorizedExternalAccessTargets(
	authorization: TerminalCommandAuthorization | undefined
): readonly ExternalAccessTarget[] {
	return authorization?.crossSandbox?.targets ?? [];
}
