import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { findWorkspace } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import {
	listHookConfigSources,
	readHookConfigDocument,
	resolveHookConfigSource,
	writeHookConfigDocument
} from "../../hooks/config-store.js";
import type { HookConfigDocument, HookConfigSource } from "../../hooks/types.js";
import { updateHookTrust } from "../../hooks/trust-store.js";
import { hookRuntime } from "../../hooks/runtime.js";

type HookRequest = Extract<ClientRequest, { method: `hooks.${string}` }>;

function resolveWorkspace(workspaceId: string | undefined, session: ClientSession): WorkspaceConfig | undefined {
	if (workspaceId === undefined) return session.activeWorkspace;
	const workspace: WorkspaceConfig | undefined = findWorkspace(workspaceId);
	if (workspace === undefined) throw new Error(`Workspace not found: ${workspaceId}`);
	return workspace;
}

function resolveSource(request: Extract<HookRequest, { params: { scope: "global" | "source" } }>, session: ClientSession): HookConfigSource {
	const params = request.params;
	return resolveHookConfigSource({
		scope: params.scope,
		workspace: params.scope === "source" ? resolveWorkspace(params.workspaceId, session) : undefined,
		sourceFolderId: params.scope === "source" ? params.sourceFolderId : undefined
	});
}

export async function handleHookRequest(
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	_mcpHost: McpHost
): Promise<void> {
	if (!request.method.startsWith("hooks.")) throw new Error(`Unsupported hooks method: ${request.method}`);
	const hookRequest: HookRequest = request as HookRequest;
	switch (hookRequest.method) {
	case "hooks.config.sources.list": {
		const workspace: WorkspaceConfig | undefined = resolveWorkspace(hookRequest.params?.workspaceId, session);
		const documents: HookConfigDocument[] = await Promise.all(
			listHookConfigSources(workspace).map(async (source: HookConfigSource): Promise<HookConfigDocument> => await readHookConfigDocument(source))
		);
		sendJson(socket, { type: "response", id: request.id, ok: true, result: { sources: documents } });
		break;
	}
	case "hooks.config.get": {
		const document: HookConfigDocument = await readHookConfigDocument(resolveSource(hookRequest, session));
		sendJson(socket, { type: "response", id: request.id, ok: true, result: document });
		break;
	}
	case "hooks.config.update": {
		const document: HookConfigDocument = await writeHookConfigDocument({
			source: resolveSource(hookRequest, session),
			content: hookRequest.params.content,
			expectedRevision: hookRequest.params.expectedRevision
		});
		sendJson(socket, { type: "response", id: request.id, ok: true, result: document });
		break;
	}
	case "hooks.trust.update": {
		const source: HookConfigSource = resolveSource(hookRequest, session);
		const document: HookConfigDocument = await readHookConfigDocument(source);
		if (!document.handlers.some((handler): boolean => handler.fingerprint === hookRequest.params.fingerprint)) {
			throw new Error("hooks_fingerprint_stale: Reload the hook configuration before updating trust.");
		}
		await updateHookTrust(hookRequest.params.fingerprint, hookRequest.params.status);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await readHookConfigDocument(source)
		});
		break;
	}
	case "hooks.runs.list":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: { runs: hookRuntime.listRuns(hookRequest.params?.limit) }
		});
		break;
	}
}
