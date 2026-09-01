import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type WebSocket from "ws";
import type { ServerEvent } from "../../../protocol/types.js";
import type { ProviderToolImageReference } from "../../../providers/tool-image-reference.js";
import { assertSupportedImageSignature } from "../../../protocol/image-file-signature.js";
import { getCurrentMcpWorkspaceId, getMcpRequestContext } from "../../request-context.js";

export const GODOT_RUNTIME_TEST_SERVER_ID: string = "godot_runtime";

const SESSION_TTL_MS: number = 30 * 60 * 1000;
const HEARTBEAT_STALE_MS: number = 7_000;
const TOOL_TIMEOUT_MS: number = 30_000;
const RUNTIME_TOOL_NAMES: ReadonlySet<string> = new Set(["observe", "action", "wait", "assert", "screenshot"]);
const RUNTIME_ASSERTION_PROPERTIES: ReadonlySet<string> = new Set(["exists", "visible", "visibleInTree", "enabled", "text", "buttonPressed", "selected", "currentTab", "testState"]);
const RUNTIME_KEYS: ReadonlySet<string> = new Set(["enter", "tab", "shift+tab", "escape", "backspace", "delete", "arrow_up", "arrow_down", "arrow_left", "arrow_right", "home", "end", "page_up", "page_down", "ctrl+a", "ctrl+f", "ctrl+s", "ctrl+z", "ctrl+y"]);

type JsonObject = Record<string, unknown>;

type RuntimeTestSession = {
	testSessionId: string;
	tokenHash: Buffer;
	workspaceId: string;
	ownerWorkspaceId: string;
	workspaceRoot: string;
	ownerSocket: WebSocket;
	createdAtMs: number;
	expiresAtMs: number;
	runtimeInstanceId?: string | undefined;
	runtimeSocket?: WebSocket | undefined;
	lastHeartbeatAtMs?: number | undefined;
	treeRevision?: number | undefined;
	scenePath?: string | undefined;
};

type PendingRuntimeCall = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
	socket: WebSocket;
	testSessionId: string;
	runtimeInstanceId: string;
	toolName: string;
	identity: RuntimeToolIdentity;
};

type RuntimeToolIdentity = {
	sessionId: string;
	requestId: string;
	runId: string;
	toolCallId: string;
};

type RuntimeScreenshot = {
	testSessionId: string;
	runtimeInstanceId: string;
	observationId: string;
	bytes: Buffer;
	width: number;
	height: number;
	sha256: string;
};

export type GodotRuntimeTestSessionSummary = {
	testSessionId: string;
	workspaceId: string;
	workspaceRoot: string;
	runtimeInstanceId: string | null;
	online: boolean;
	createdAt: string;
	expiresAt: string;
	lastHeartbeatAt: string | null;
	treeRevision: number | null;
	scenePath: string | null;
};

export type GodotRuntimeHello = {
	testSessionId: string;
	testSessionToken: string;
	runtimeInstanceId: string;
	workspaceRoot: string;
};

function hashToken(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

function normalizeWorkspaceRoot(value: string): string {
	return path.resolve(value).replace(/[\\/]+$/u, "").toLowerCase();
}

function isSocketOpen(socket: WebSocket | undefined): socket is WebSocket {
	return socket !== undefined && socket.readyState === 1;
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAssertionValue(value: unknown): value is string | number | boolean | null {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[]): void {
	const allowedKeys: ReadonlySet<string> = new Set(allowed);
	if (Object.keys(value).some((key: string): boolean => !allowedKeys.has(key))) throw new Error("runtime_action_property_unknown");
}

function validateRuntimeAction(action: JsonObject): void {
	const type: unknown = action.type;
	if (type === "button_press" || type === "toggle") {
		assertOnlyKeys(action, ["type"]);
		return;
	}
	if (type === "set_text") {
		assertOnlyKeys(action, ["type", "text"]);
		if (typeof action.text !== "string" || action.text.length > 4096) throw new Error("runtime_text_invalid");
		return;
	}
	if (type === "select") {
		assertOnlyKeys(action, ["type", "index"]);
		if (!Number.isInteger(action.index) || Number(action.index) < 0 || Number(action.index) > 10_000) throw new Error("runtime_selection_invalid");
		return;
	}
	if (type === "key_press") {
		assertOnlyKeys(action, ["type", "key"]);
		if (typeof action.key !== "string" || !RUNTIME_KEYS.has(action.key)) throw new Error("runtime_key_not_allowed");
		return;
	}
	throw new Error("runtime_action_unsupported");
}

export class GodotRuntimeTestBridge {
	private readonly sessions: Map<string, RuntimeTestSession> = new Map();
	private readonly pendingCalls: Map<string, PendingRuntimeCall> = new Map();
	private readonly screenshots: Map<string, RuntimeScreenshot> = new Map();
	private lastEventSequence: number = 0;

	createSession(ownerSocket: WebSocket, workspaceId: string, workspaceRoot: string, ownerWorkspaceId: string = workspaceId): GodotRuntimeTestSessionSummary & { token: string } {
		this.cleanupExpired();
		for (const session of this.sessions.values()) {
			if (session.ownerSocket === ownerSocket && session.workspaceId === workspaceId) this.revokeSession(session.testSessionId);
		}
		const token: string = randomBytes(32).toString("base64url");
		const now: number = Date.now();
		const session: RuntimeTestSession = {
			testSessionId: `godot-test-${randomUUID()}`,
			tokenHash: hashToken(token),
			workspaceId,
			ownerWorkspaceId,
			workspaceRoot: path.resolve(workspaceRoot),
			ownerSocket,
			createdAtMs: now,
			expiresAtMs: now + SESSION_TTL_MS
		};
		this.sessions.set(session.testSessionId, session);
		return { ...this.summarize(session), token };
	}

	validateHello(hello: GodotRuntimeHello): RuntimeTestSession {
		this.cleanupExpired();
		const session: RuntimeTestSession | undefined = this.sessions.get(hello.testSessionId);
		if (session === undefined) throw new Error("runtime_test_session_unknown");
		const presentedHash: Buffer = hashToken(hello.testSessionToken);
		if (presentedHash.length !== session.tokenHash.length || !timingSafeEqual(presentedHash, session.tokenHash)) {
			throw new Error("runtime_test_token_invalid");
		}
		if (normalizeWorkspaceRoot(hello.workspaceRoot) !== normalizeWorkspaceRoot(session.workspaceRoot)) {
			throw new Error("runtime_test_workspace_mismatch");
		}
		if (session.runtimeInstanceId !== undefined && session.runtimeInstanceId !== hello.runtimeInstanceId) {
			throw new Error("runtime_test_instance_mismatch");
		}
		return session;
	}

	attachRuntime(socket: WebSocket, hello: GodotRuntimeHello): GodotRuntimeTestSessionSummary {
		const session: RuntimeTestSession = this.validateHello(hello);
		if (isSocketOpen(session.runtimeSocket) && session.runtimeSocket !== socket) {
			throw new Error("runtime_test_instance_already_connected");
		}
		session.runtimeSocket = socket;
		session.runtimeInstanceId = hello.runtimeInstanceId;
		session.lastHeartbeatAtMs = Date.now();
		return this.summarize(session);
	}

	heartbeat(socket: WebSocket, params: { testSessionId: string; runtimeInstanceId: string; treeRevision: number; scenePath?: string | undefined }): GodotRuntimeTestSessionSummary {
		const session: RuntimeTestSession = this.requireRuntimeSession(socket, params.testSessionId, params.runtimeInstanceId);
		session.lastHeartbeatAtMs = Date.now();
		session.treeRevision = params.treeRevision;
		session.scenePath = params.scenePath;
		return this.summarize(session);
	}

	handleToolResult(socket: WebSocket, params: {
		callId: string;
		testSessionId: string;
		runtimeInstanceId: string;
		ok: boolean;
		result?: unknown;
		error?: { code: string; message: string; retryable: boolean } | undefined;
	}): boolean {
		const pending: PendingRuntimeCall | undefined = this.pendingCalls.get(params.callId);
		if (pending === undefined || pending.socket !== socket || pending.testSessionId !== params.testSessionId || pending.runtimeInstanceId !== params.runtimeInstanceId) {
			return false;
		}
		this.pendingCalls.delete(params.callId);
		clearTimeout(pending.timeout);
		if (params.ok) {
			try {
				if (pending.toolName === "observe" || pending.toolName === "action") {
					this.clearScreenshots(pending.testSessionId);
				}
				if (pending.toolName === "screenshot") {
					this.storeScreenshot(pending.testSessionId, pending.runtimeInstanceId, params.result);
				}
				pending.resolve(params.result ?? { ok: true });
			} catch (error: unknown) {
				pending.reject(error instanceof Error ? error : new Error("runtime_screenshot_invalid"));
			}
		} else pending.reject(new Error(`${params.error?.code ?? "runtime_tool_failed"}: ${params.error?.message ?? "Runtime tool failed."}`));
		return true;
	}

	listSessions(workspaceId?: string | undefined): GodotRuntimeTestSessionSummary[] {
		this.cleanupExpired();
		return Array.from(this.sessions.values())
			.filter((session): boolean => workspaceId === undefined || session.workspaceId === workspaceId || session.ownerWorkspaceId === workspaceId)
			.map((session): GodotRuntimeTestSessionSummary => this.summarize(session));
	}

	listOwnerSessions(ownerSocket: WebSocket): GodotRuntimeTestSessionSummary[] {
		this.cleanupExpired();
		return Array.from(this.sessions.values())
			.filter((session): boolean => session.ownerSocket === ownerSocket)
			.map((session): GodotRuntimeTestSessionSummary => this.summarize(session));
	}

	stopSession(ownerSocket: WebSocket, testSessionId: string): boolean {
		const session: RuntimeTestSession | undefined = this.sessions.get(testSessionId);
		if (session === undefined || session.ownerSocket !== ownerSocket) return false;
		this.revokeSession(testSessionId);
		return true;
	}

	detachSocket(socket: WebSocket): void {
		for (const session of Array.from(this.sessions.values())) {
			if (session.ownerSocket === socket || session.runtimeSocket === socket) this.revokeSession(session.testSessionId);
		}
		for (const [callId, pending] of this.pendingCalls.entries()) {
			if (pending.socket !== socket) continue;
			clearTimeout(pending.timeout);
			pending.reject(new Error("runtime_unavailable: runtime connection closed"));
			this.pendingCalls.delete(callId);
		}
	}

	isActiveSession(testSessionId: string, workspaceId?: string | undefined): boolean {
		this.cleanupExpired();
		const session: RuntimeTestSession | undefined = this.sessions.get(testSessionId);
		return session !== undefined
			&& (workspaceId === undefined || session.workspaceId === workspaceId || session.ownerWorkspaceId === workspaceId)
			&& this.isSessionOnline(session);
	}

	isOnline(workspaceId?: string | undefined): boolean {
		return this.listSessions(workspaceId).some((session): boolean => session.online);
	}

	listTools(): { tools: JsonObject[] } {
		return { tools: [
			{ name: "observe", description: "Observe the live Godot Control tree in an explicit runtime test session.", inputSchema: { type: "object", properties: { testSessionId: { type: "string" }, runtimeInstanceId: { type: "string" } } } },
			{ name: "action", description: "Dispatch one allowlisted Godot InputEvent action to an observed Control.", inputSchema: { type: "object", properties: {}, additionalProperties: true } },
			{ name: "wait", description: "Wait for an allowlisted runtime Control state.", inputSchema: { type: "object", properties: {}, additionalProperties: true } },
			{ name: "assert", description: "Assert an allowlisted runtime Control state.", inputSchema: { type: "object", properties: {}, additionalProperties: true } },
			{ name: "screenshot", description: "Capture the live Godot viewport for an existing observation.", inputSchema: { type: "object", properties: {}, additionalProperties: true } }
		] };
	}

	async callTool(name: string, args: JsonObject, workspaceId?: string | undefined, abortSignal?: AbortSignal | undefined) {
		if (!RUNTIME_TOOL_NAMES.has(name)) throw new Error(`runtime_tool_unknown: ${name}`);
		const session: RuntimeTestSession = this.selectSession(args, workspaceId ?? getCurrentMcpWorkspaceId());
		const forwardedArgs: JsonObject = this.validateToolArgs(name, args, session);
		const result: unknown = await this.requestRuntimeTool(session, name, forwardedArgs, abortSignal);
		if (name === "screenshot" && isJsonObject(result) && result.ok === true && typeof result.data === "string" && result.mimeType === "image/png") {
			const metadata: JsonObject = {
				...result,
				testSessionId: session.testSessionId,
				runtimeInstanceId: session.runtimeInstanceId,
				screenshot: "available"
			};
			delete metadata.data;
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(metadata, null, 2) },
					{ type: "image" as const, data: result.data, mimeType: "image/png" }
				]
			};
		}
		return textResult(result);
	}

	getScreenshotReference(testSessionId: string, runtimeInstanceId: string, observationId: string): ProviderToolImageReference {
		const screenshot: RuntimeScreenshot | undefined = this.screenshots.get(this.screenshotKey(testSessionId, runtimeInstanceId, observationId));
		if (screenshot === undefined) throw new Error("runtime_screenshot_stale");
		return {
			source: { kind: "godot_runtime", testSessionId, runtimeInstanceId, observationId },
			title: "Godot runtime viewport",
			mimeType: "image/png",
			byteSize: screenshot.bytes.byteLength,
			sha256: screenshot.sha256,
			width: screenshot.width,
			height: screenshot.height
		};
	}

	readScreenshot(testSessionId: string, runtimeInstanceId: string, observationId: string): Buffer {
		const screenshot: RuntimeScreenshot | undefined = this.screenshots.get(this.screenshotKey(testSessionId, runtimeInstanceId, observationId));
		if (screenshot === undefined) throw new Error("runtime_screenshot_stale");
		return Buffer.from(screenshot.bytes);
	}

	private selectSession(args: JsonObject, workspaceId?: string | undefined): RuntimeTestSession {
		this.cleanupExpired();
		const requestedSessionId: string | undefined = typeof args.testSessionId === "string" ? args.testSessionId : undefined;
		const candidates: RuntimeTestSession[] = Array.from(this.sessions.values())
			.filter((session): boolean => workspaceId === undefined || session.workspaceId === workspaceId || session.ownerWorkspaceId === workspaceId)
			.filter((session): boolean => requestedSessionId === undefined || session.testSessionId === requestedSessionId)
			.filter((session): boolean => this.isSessionOnline(session));
		if (candidates.length === 0) throw new Error("runtime_test_unavailable: start a Godot runtime test from Studio first");
		if (candidates.length > 1) throw new Error("runtime_test_target_required: multiple runtime tests are active");
		const session: RuntimeTestSession = candidates[0]!;
		if (typeof args.runtimeInstanceId === "string" && args.runtimeInstanceId !== session.runtimeInstanceId) {
			throw new Error("runtime_test_instance_mismatch");
		}
		return session;
	}

	private validateToolArgs(name: string, args: JsonObject, session: RuntimeTestSession): JsonObject {
		const forwarded: JsonObject = { ...args, testSessionId: session.testSessionId, runtimeInstanceId: session.runtimeInstanceId };
		if (name === "observe") return forwarded;
		if (typeof args.observationId !== "string" || args.observationId.length < 1 || args.observationId.length > 240) throw new Error("runtime_observation_id_required");
		if (name === "screenshot") return forwarded;
		if (typeof args.nodeId !== "string" || args.nodeId.length < 1 || args.nodeId.length > 240) throw new Error("runtime_node_id_required");
		if (name === "action") {
			if (typeof args.actionId !== "string" || args.actionId.length < 1 || args.actionId.length > 160) throw new Error("runtime_action_id_required");
			if (!isJsonObject(args.action)) throw new Error("runtime_action_required");
			validateRuntimeAction(args.action);
		}
		if (name === "wait" || name === "assert") {
			if (!isJsonObject(args.assertion)) throw new Error("runtime_assertion_required");
			if (typeof args.assertion.property !== "string" || !RUNTIME_ASSERTION_PROPERTIES.has(args.assertion.property)) throw new Error("runtime_assertion_property_not_allowed");
			if (!("equals" in args.assertion) || !isAssertionValue(args.assertion.equals)) throw new Error("runtime_assertion_value_invalid");
			if (name === "wait" && args.timeoutMsec !== undefined && (!Number.isInteger(args.timeoutMsec) || Number(args.timeoutMsec) < 1 || Number(args.timeoutMsec) > 30_000)) throw new Error("runtime_wait_timeout_invalid");
		}
		return forwarded;
	}

	private requestRuntimeTool(session: RuntimeTestSession, toolName: string, args: JsonObject, abortSignal?: AbortSignal | undefined): Promise<unknown> {
		if (!this.isSessionOnline(session) || session.runtimeSocket === undefined || session.runtimeInstanceId === undefined) {
			return Promise.reject(new Error("runtime_test_unavailable"));
		}
		if (abortSignal?.aborted) return Promise.reject(new Error("runtime_tool_cancelled"));
		const socket: WebSocket = session.runtimeSocket;
		const callId: string = `runtime-tool-${randomUUID()}`;
		const context = getMcpRequestContext();
		const identity: RuntimeToolIdentity = {
			sessionId: context?.sessionId ?? "",
			requestId: context?.requestId ?? callId,
			runId: context?.runId ?? context?.requestId ?? callId,
			toolCallId: context?.toolCallId ?? callId
		};
		return new Promise<unknown>((resolve, reject): void => {
			const onAbort = (): void => {
				const pending: PendingRuntimeCall | undefined = this.pendingCalls.get(callId);
				if (pending === undefined) return;
				clearTimeout(pending.timeout);
				this.pendingCalls.delete(callId);
				this.sendToolCancellation(callId, pending, "runtime_tool_cancelled");
				reject(new Error("runtime_tool_cancelled"));
			};
			const timeout: NodeJS.Timeout = setTimeout((): void => {
				const pending: PendingRuntimeCall | undefined = this.pendingCalls.get(callId);
				if (pending !== undefined) this.sendToolCancellation(callId, pending, "runtime_tool_timeout");
				this.pendingCalls.delete(callId);
				abortSignal?.removeEventListener("abort", onAbort);
				reject(new Error(`runtime_tool_timeout: ${toolName}`));
			}, TOOL_TIMEOUT_MS);
			this.pendingCalls.set(callId, {
				resolve: (value: unknown): void => { abortSignal?.removeEventListener("abort", onAbort); resolve(value); },
				reject: (error: Error): void => { abortSignal?.removeEventListener("abort", onAbort); reject(error); },
				timeout,
				socket,
				testSessionId: session.testSessionId,
				runtimeInstanceId: session.runtimeInstanceId!,
				toolName,
				identity
			});
			abortSignal?.addEventListener("abort", onAbort, { once: true });
			this.lastEventSequence = Math.max(Date.now() * 1000, this.lastEventSequence + 1);
			const event: ServerEvent = {
				protocolVersion: 3,
				type: "event",
				eventId: `event-${randomUUID()}`,
				event: "godot.runtime.tool.requested",
				sessionId: identity.sessionId,
				requestId: identity.requestId,
				runId: identity.runId,
				sequence: this.lastEventSequence,
				createdAt: new Date().toISOString(),
				data: {
					callId,
					toolCallId: identity.toolCallId,
					toolName,
					args,
					workspaceId: session.workspaceId,
					testSessionId: session.testSessionId,
					runtimeInstanceId: session.runtimeInstanceId
				}
			};
			try {
				socket.send(JSON.stringify(event));
			} catch (error: unknown) {
				clearTimeout(timeout);
				this.pendingCalls.delete(callId);
				abortSignal?.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error("runtime_tool_send_failed"));
			}
		});
	}

	private sendToolCancellation(callId: string, pending: PendingRuntimeCall, reason: string): void {
		if (!isSocketOpen(pending.socket)) return;
		this.lastEventSequence = Math.max(Date.now() * 1000, this.lastEventSequence + 1);
		const event: ServerEvent = {
			protocolVersion: 3,
			type: "event",
			eventId: `event-${randomUUID()}`,
			event: "godot.runtime.tool.cancelled",
			sessionId: pending.identity.sessionId,
			requestId: pending.identity.requestId,
			runId: pending.identity.runId,
			sequence: this.lastEventSequence,
			createdAt: new Date().toISOString(),
			data: {
				callId,
				toolCallId: pending.identity.toolCallId,
				testSessionId: pending.testSessionId,
				runtimeInstanceId: pending.runtimeInstanceId,
				reason
			}
		};
		try {
			pending.socket.send(JSON.stringify(event));
		} catch {
			// Closing the runtime connection is already a terminal cancellation path.
		}
	}

	private requireRuntimeSession(socket: WebSocket, testSessionId: string, runtimeInstanceId: string): RuntimeTestSession {
		const session: RuntimeTestSession | undefined = this.sessions.get(testSessionId);
		if (session === undefined || session.runtimeSocket !== socket || session.runtimeInstanceId !== runtimeInstanceId) {
			throw new Error("runtime_test_identity_mismatch");
		}
		return session;
	}

	private revokeSession(testSessionId: string): void {
		const session: RuntimeTestSession | undefined = this.sessions.get(testSessionId);
		if (session === undefined) return;
		this.sessions.delete(testSessionId);
		this.clearScreenshots(testSessionId);
		for (const [callId, pending] of this.pendingCalls.entries()) {
			if (pending.testSessionId !== testSessionId) continue;
			clearTimeout(pending.timeout);
			this.sendToolCancellation(callId, pending, "runtime_test_revoked");
			pending.reject(new Error("runtime_test_revoked"));
			this.pendingCalls.delete(callId);
		}
		if (isSocketOpen(session.runtimeSocket)) session.runtimeSocket.close(1000, "runtime_test_revoked");
	}

	private storeScreenshot(testSessionId: string, runtimeInstanceId: string, value: unknown): void {
		if (!isJsonObject(value)
			|| value.ok !== true
			|| value.mimeType !== "image/png"
			|| typeof value.data !== "string"
			|| typeof value.observationId !== "string"
			|| !Number.isInteger(value.width)
			|| !Number.isInteger(value.height)) {
			throw new Error("runtime_screenshot_invalid");
		}
		const bytes: Buffer = Buffer.from(value.data, "base64");
		const width: number = Number(value.width);
		const height: number = Number(value.height);
		if (bytes.byteLength < 33
			|| bytes.byteLength > 5 * 1024 * 1024
			|| assertSupportedImageSignature(bytes) !== "image/png"
			|| bytes.toString("ascii", 12, 16) !== "IHDR"
			|| bytes.readUInt32BE(16) !== width
			|| bytes.readUInt32BE(20) !== height) {
			throw new Error("runtime_screenshot_invalid");
		}
		this.clearScreenshots(testSessionId);
		const screenshot: RuntimeScreenshot = {
			testSessionId,
			runtimeInstanceId,
			observationId: value.observationId,
			bytes,
			width,
			height,
			sha256: createHash("sha256").update(bytes).digest("hex")
		};
		this.screenshots.set(this.screenshotKey(testSessionId, runtimeInstanceId, value.observationId), screenshot);
	}

	private clearScreenshots(testSessionId: string): void {
		for (const [key, screenshot] of this.screenshots.entries()) {
			if (screenshot.testSessionId === testSessionId) this.screenshots.delete(key);
		}
	}

	private screenshotKey(testSessionId: string, runtimeInstanceId: string, observationId: string): string {
		return `${testSessionId}\n${runtimeInstanceId}\n${observationId}`;
	}

	private cleanupExpired(): void {
		const now: number = Date.now();
		for (const session of Array.from(this.sessions.values())) {
			if (session.expiresAtMs <= now) this.revokeSession(session.testSessionId);
		}
	}

	private isSessionOnline(session: RuntimeTestSession): boolean {
		return isSocketOpen(session.runtimeSocket)
			&& session.lastHeartbeatAtMs !== undefined
			&& Date.now() - session.lastHeartbeatAtMs <= HEARTBEAT_STALE_MS;
	}

	private summarize(session: RuntimeTestSession): GodotRuntimeTestSessionSummary {
		return {
			testSessionId: session.testSessionId,
			workspaceId: session.workspaceId,
			workspaceRoot: session.workspaceRoot,
			runtimeInstanceId: session.runtimeInstanceId ?? null,
			online: this.isSessionOnline(session),
			createdAt: new Date(session.createdAtMs).toISOString(),
			expiresAt: new Date(session.expiresAtMs).toISOString(),
			lastHeartbeatAt: session.lastHeartbeatAtMs === undefined ? null : new Date(session.lastHeartbeatAtMs).toISOString(),
			treeRevision: session.treeRevision ?? null,
			scenePath: session.scenePath ?? null
		};
	}
}

export const godotRuntimeTestBridge: GodotRuntimeTestBridge = new GodotRuntimeTestBridge();
