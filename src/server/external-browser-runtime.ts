import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { BrowserConversationAuthority } from "./browser-conversation-authority.js";
import {
	recordBrowserActivity,
	saveBrowserScreenshot,
} from "../session/browser-activity-store.js";
import {
	EXTERNAL_BROWSER_TOOLS,
	type BrowserScope,
} from "../protocol/external-browser.js";
import { interpretBrowserConsent } from "../providers/browser-consent.js";
import type { ProviderChatOptions } from "../providers/provider-types.js";
import type { ClientSession } from "./client-session.js";
import { getClientConnection } from "./client-connections.js";
import type { BrowserControlContext } from "../tools/browser-tools.js";
import { studioBrowserRuntime } from "./studio-browser-runtime.js";
import { sendJson } from "./send-json.js";

type Binding = {
	scope: BrowserScope;
	socket: WebSocket;
	signal: AbortSignal;
	cancel(): void;
	timer?: NodeJS.Timeout;
	heartbeat: number;
	started: boolean;
	externalTask?: boolean;
	proposalDisplayed?: boolean;
};
const authority = new BrowserConversationAuthority(recordBrowserActivity);
const bindings = new Map<string, Binding>();
const planSources = new WeakMap<WebSocket, Map<string, string>>();
// 仅 plan.approve 的服务端路径可以登记原始用户文本，不接受 RPC/模型自行传入
export function registerApprovedBrowserPlan(
	socket: WebSocket,
	runId: string,
	originalUserMessage: string,
): void {
	let sources = planSources.get(socket);
	if (!sources) {
		sources = new Map();
		planSources.set(socket, sources);
	}
	sources.set(runId, originalUserMessage);
}
const key = (connectionId: string, sessionId: string): string =>
	`${connectionId}:${sessionId}`;
export async function beginExternalBrowserTurn(
	socket: WebSocket,
	session: ClientSession,
	requestId: string,
	canonicalId: string,
	message: string,
	options: ProviderChatOptions,
	controller: AbortController,
	inputAllowed: boolean,
	fresh: boolean,
): Promise<string> {
	const planMessage = planSources.get(socket)?.get(requestId);
	planSources.get(socket)?.delete(requestId);
	const conn = getClientConnection(socket);
	if (
		conn?.clientType !== "studio" ||
		!conn.capabilities.externalBrowser ||
		!session.sessionId ||
		session.scheduledTaskOrigin
	) {
		if (session.sessionId) authority.revokeSessionProposals(session.sessionId);
		return "";
	}
	const scope: BrowserScope = {
		connectionId: conn.connectionId,
		sessionId: session.sessionId,
		requestId: canonicalId,
		runId: requestId,
		generation: randomUUID(),
	};
	const old = bindings.get(key(conn.connectionId, session.sessionId));
	if (old?.timer) clearInterval(old.timer);
	const binding: Binding = {
		scope,
		socket,
		signal: controller.signal,
		cancel: () => controller.abort(),
		heartbeat: Date.now(),
		started: false,
	};
	bindings.set(key(conn.connectionId, session.sessionId), binding);
	controller.signal.addEventListener(
		"abort",
		() =>
			finishExternalBrowserTurn(socket, session.sessionId!, requestId, true),
		{ once: true },
	);
	const prompt = await authority.begin(
		scope,
		planMessage ?? message,
		inputAllowed,
		controller.signal,
		(proposal, reply) =>
			planMessage !== undefined
				? Promise.resolve({ decision: "clarify", stepIds: [] })
				: interpretBrowserConsent(proposal, reply, options, controller.signal),
		fresh,
	);
	binding.externalTask = prompt.length > 0;
	return prompt;
}
export function externalBrowserControl(
	socket: WebSocket,
	sessionId: string,
	legacy: BrowserControlContext | undefined,
): BrowserControlContext {
	const connectionId = getClientConnection(socket)!.connectionId;
	const binding = (): Binding => {
		const b = bindings.get(key(connectionId, sessionId));
		if (
			!b ||
			b.signal.aborted ||
			!getClientConnection(socket)?.capabilities.externalBrowser
		)
			throw new Error("browser_scope_stale");
		return b;
	};
	return {
		externalSupported: true,
		canExecute: () => {
			try {
				return authority.canExecute(binding().scope);
			} catch {
				return false;
			}
		},
		finalReply: () => {
			try {
				return authority.finalReply(binding().scope);
			} catch {
				return undefined;
			}
		},
		execute: async (tool, args, signal, identity) => {
			const external =
				(EXTERNAL_BROWSER_TOOLS as readonly string[]).includes(tool) ||
				args.targetId !== undefined;
			if (!external) {
				signal?.throwIfAborted();
				const current = bindings.get(key(connectionId, sessionId));
				if (current?.started || current?.externalTask)
					throw new Error("browser_external_target_required");
				if (!legacy) throw new Error("browser_embedded_disabled");
				return legacy.execute(tool, args, signal, identity);
			}
			const b = binding();
			if (
				!identity ||
				(identity.requestId !== b.scope.requestId &&
					identity.requestId !== b.scope.runId)
			)
				throw new Error("browser_request_mismatch");
			if (!b.started) {
				b.started = true;
				b.heartbeat = Date.now();
				b.timer = setInterval(() => {
					if (Date.now() - b.heartbeat > 5000) {
						b.cancel();
						finishExternalBrowserTurn(socket, sessionId, b.scope.runId, true);
					}
				}, 1000);
				b.timer.unref();
			}
			const result = await authority.execute(
				b.scope,
				tool,
				args,
				(operation, payload, scope, abort) =>
					studioBrowserRuntime.forwardExternal(
						socket,
						scope,
						identity.toolCallId,
						operation,
						payload,
						abort,
					),
			);
			if (tool === "mcp_browser_screenshot") {
				b.signal.throwIfAborted();
				const { dataUrl, ...safe } = result;
				const reference = await saveBrowserScreenshot(
					b.scope,
					dataUrl,
					b.signal,
				);
				return {
					...safe,
					browserImage: reference,
					activityId:
						reference.source.kind === "browser_activity"
							? reference.source.activityId
							: undefined,
				};
			}
			return result;
		},
	};
}
export function updateExternalBrowser(
	socket: WebSocket,
	update: {
		sessionId: string;
		runId: string;
		generation: string;
		state: "heartbeat" | "revoke";
	},
): void {
	const conn = getClientConnection(socket),
		b = conn && bindings.get(key(conn.connectionId, update.sessionId));
	if (conn && update.state === "revoke")
		authority.revokePending(
			conn.connectionId,
			update.sessionId,
			update.runId,
			update.generation,
		);
	if (
		!b ||
		b.socket !== socket ||
		b.scope.runId !== update.runId ||
		b.scope.generation !== update.generation
	)
		return;
	if (update.state === "heartbeat") b.heartbeat = Date.now();
	else {
		b.cancel();
		finishExternalBrowserTurn(socket, update.sessionId, update.runId, true);
	}
}
export function finishExternalBrowserTurn(
	socket: WebSocket,
	sessionId: string,
	runId: string,
	cancelled = false,
): void {
	const conn = getClientConnection(socket),
		id = conn && key(conn.connectionId, sessionId),
		b = id && bindings.get(id);
	if (!b || b.scope.runId !== runId) return;
	const keepTarget =
		!cancelled &&
		b.proposalDisplayed === true &&
		!!authority.finalReply(b.scope);
	authority.finish(
		b.scope,
		cancelled || (!!authority.finalReply(b.scope) && !keepTarget),
	);
	if (b.timer) clearInterval(b.timer);
	bindings.delete(id as string);
	if (b.started)
		sendJson(socket, {
			protocolVersion: 3,
			type: "event",
			event: "browser.tool.cancel",
			eventId: randomUUID(),
			sessionId,
			requestId: b.scope.requestId,
			runId,
			sequence: Date.now() * 1000,
			createdAt: new Date().toISOString(),
			data: { external: true, scope: b.scope, finished: true, keepTarget },
		});
}
export function markBrowserProposalDisplayed(
	socket: WebSocket,
	sessionId: string | undefined,
	runId: string,
	text: string,
): void {
	const conn = getClientConnection(socket),
		b = conn && sessionId && bindings.get(key(conn.connectionId, sessionId));
	if (
		b &&
		b.scope.runId === runId &&
		authority.finalReply(b.scope) === text &&
		!b.signal.aborted
	)
		b.proposalDisplayed = true;
}
export function revokeExternalBrowser(socket: WebSocket): void {
	for (const b of [...bindings.values()])
		if (b.socket === socket) {
			b.cancel();
			finishExternalBrowserTurn(socket, b.scope.sessionId, b.scope.runId, true);
			authority.revoke(b.scope.connectionId);
		}
	const conn = getClientConnection(socket);
	if (conn) authority.revoke(conn.connectionId);
}
