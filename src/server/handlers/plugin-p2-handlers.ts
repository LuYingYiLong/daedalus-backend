import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";
import { ensurePluginRuntime, invokePlugin } from "../../plugins/runtime/manager.js";
import { getPluginCommand, getPluginContextProvider, getPluginP2Snapshot } from "../../plugins/p2/registry.js";
import { additionalContextItemSchema } from "../../protocol/schema.js";
import { acknowledgePluginEvent, publishPluginEvent, subscribePluginEvents } from "../../plugins/p2/event-bus.js";
import { sendStudioPersistentSessionEvent } from "../session-events.js";
import { studioBrowserRuntime } from "../studio-browser-runtime.js";
import { BROWSER_TOOL_NAMES, type BrowserToolName } from "../../tools/browser-tools.js";
import { getPluginCatalog } from "../../plugins/manager.js";
import { getPluginUiState, updatePluginUiState } from "../../plugins/p2/ui-state.js";
import { createNativeConversionReport } from "../../plugins/p2/native-converter.js";
import { startPluginLanguageService, stopPluginLanguageService } from "../../plugins/p2/language-service.js";

type PluginP2Request = Extract<ClientRequest, { method: `plugin.${string}` }>;

function ensureStudio(socket: WebSocket): void {
	if (getClientConnection(socket)?.clientType !== "studio") {
		throw Object.assign(new Error("Plugin P2 extensions are only available to Daedalus Studio."), { code: "studio_only" });
	}
}

function runtimeContext(session: ClientSession): { sessionId: string; workspaceId?: string; workspaceRoot?: string } {
	return {
		sessionId: session.sessionId ?? "studio-p2-preview",
		...(session.activeWorkspace?.id === undefined ? {} : { workspaceId: session.activeWorkspace.id }),
		...(session.activeWorkspace?.rootPath === undefined ? {} : { workspaceRoot: session.activeWorkspace.rootPath })
	};
}

function clip(value: unknown, max: number): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function findPanel(snapshot: Awaited<ReturnType<typeof getPluginP2Snapshot>>, panelId: string) {
	return snapshot.panels.find((candidate): boolean => candidate.panelId === panelId || panelId.startsWith(`${candidate.panelId}:`));
}

function findSettings(snapshot: Awaited<ReturnType<typeof getPluginP2Snapshot>>, settingsId: string) {
	return snapshot.settings.find((candidate): boolean => candidate.settingsId === settingsId);
}

export async function handlePluginP2Request(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): Promise<void> {
	ensureStudio(socket);
	const p2Request = request as PluginP2Request;
	let result: unknown;
	if (p2Request.method === "plugin.extensions.registry.get") {
		result = await getPluginP2Snapshot();
	} else if (p2Request.method === "plugin.command.resolve") {
		const command = await getPluginCommand(p2Request.params.command);
		if (command === undefined) throw Object.assign(new Error("Plugin command was not found or is disabled."), { code: "plugin_command_not_found" });
		await ensurePluginRuntime(command.pluginId, runtimeContext(session));
		const value = await invokePlugin(command.pluginId, runtimeContext(session).sessionId, "command", command.handler, p2Request.params.args ?? {});
		const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
		result = {
			command: command.command,
			prompt: clip(record.prompt, 32_000),
			additionalContext: Array.isArray(record.additionalContext) ? record.additionalContext.filter((item): boolean => additionalContextItemSchema.safeParse(item).success).slice(0, 16) : [],
			model: record.model && typeof record.model === "object" ? record.model : undefined
		};
	} else if (p2Request.method === "plugin.context-provider.list") {
		result = { providers: (await getPluginP2Snapshot()).contextProviders };
	} else if (p2Request.method === "plugin.context-provider.resolve") {
		const provider = await getPluginContextProvider(p2Request.params.providerId);
		if (provider === undefined) throw Object.assign(new Error("Plugin context provider was not found or is disabled."), { code: "plugin_context_provider_not_found" });
		const requestedScopes = p2Request.params.scopes ?? provider.scopes;
		if (requestedScopes.some((scope): boolean => !provider.scopes.includes(scope))) throw Object.assign(new Error("Plugin context provider requested an undeclared scope."), { code: "plugin_context_scope_denied" });
		await ensurePluginRuntime(provider.pluginId, runtimeContext(session));
		const value = await invokePlugin(provider.pluginId, runtimeContext(session).sessionId, "context_provider", provider.handlerName, { ...(p2Request.params.args ?? {}), scopes: requestedScopes });
		const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
		result = {
			providerId: provider.providerId,
			title: clip(record.title, 200) || provider.title,
			content: clip(record.content, 32_000),
			source: clip(record.source, 1000),
			metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : undefined
		};
	} else if (p2Request.method === "plugin.ui.panel.create") {
		const panel = findPanel(await getPluginP2Snapshot(), p2Request.params.panelId);
		if (panel === undefined) throw Object.assign(new Error("Plugin panel was not found or is disabled."), { code: "plugin_panel_not_found" });
		if (!panel.locations.includes(p2Request.params.location)) throw Object.assign(new Error("Plugin panel is not declared for this Dock location."), { code: "plugin_panel_location_denied" });
		const key = p2Request.params.panelId;
		if (p2Request.params.state !== undefined) await updatePluginUiState("panel", key, p2Request.params.state);
		result = { created: true, panelId: p2Request.params.panelId, location: p2Request.params.location, state: await getPluginUiState("panel", key) };
	} else if (p2Request.method === "plugin.ui.panel.state.get") {
		const panel = findPanel(await getPluginP2Snapshot(), p2Request.params.panelId);
		if (panel === undefined) throw Object.assign(new Error("Plugin panel was not found or is disabled."), { code: "plugin_panel_not_found" });
		result = await getPluginUiState("panel", p2Request.params.panelId);
	} else if (p2Request.method === "plugin.ui.panel.state.update") {
		const panel = findPanel(await getPluginP2Snapshot(), p2Request.params.panelId);
		if (panel === undefined) throw Object.assign(new Error("Plugin panel was not found or is disabled."), { code: "plugin_panel_not_found" });
		result = await updatePluginUiState("panel", p2Request.params.panelId, p2Request.params.state);
	} else if (p2Request.method === "plugin.ui.panel.action") {
		const panel = findPanel(await getPluginP2Snapshot(), p2Request.params.panelId);
		if (panel === undefined) throw Object.assign(new Error("Plugin panel was not found or is disabled."), { code: "plugin_panel_not_found" });
		const action = panel.actions?.[p2Request.params.action];
		if (action === undefined) throw Object.assign(new Error("Plugin panel action is not declared."), { code: "plugin_panel_action_not_declared" });
		if (action.risk !== "read" && action.risk !== "verify") throw Object.assign(new Error("Plugin panel write actions require the Approval Gateway and are not callable directly."), { code: "plugin_panel_approval_required" });
		if (session.sessionId === undefined) throw Object.assign(new Error("A session is required for plugin panel actions."), { code: "session_required" });
		await ensurePluginRuntime(panel.pluginId, runtimeContext(session));
		const value = await invokePlugin(panel.pluginId, runtimeContext(session).sessionId, "command", action.handler, p2Request.params.args ?? {});
		result = { accepted: true, action: p2Request.params.action, result: value };
	} else if (p2Request.method === "plugin.settings.state.get") {
		if (findSettings(await getPluginP2Snapshot(), p2Request.params.settingsId) === undefined) throw Object.assign(new Error("Plugin settings page was not found or is disabled."), { code: "plugin_settings_not_found" });
		result = await getPluginUiState("settings", p2Request.params.settingsId);
	} else if (p2Request.method === "plugin.settings.state.update") {
		if (findSettings(await getPluginP2Snapshot(), p2Request.params.settingsId) === undefined) throw Object.assign(new Error("Plugin settings page was not found or is disabled."), { code: "plugin_settings_not_found" });
		result = await updatePluginUiState("settings", p2Request.params.settingsId, p2Request.params.state);
	} else if (p2Request.method === "plugin.browser.invoke") {
		const browser = (await getPluginP2Snapshot()).browser.find((candidate): boolean => candidate.pluginId === p2Request.params.pluginId);
		if (browser === undefined) throw Object.assign(new Error("Plugin browser capability is not enabled."), { code: "plugin_browser_denied" });
		const actionMap: Record<string, BrowserToolName> = {
			navigate: "mcp_browser_navigate",
			observe: "mcp_browser_observe",
			navigation: "mcp_browser_navigation",
			scroll: "mcp_browser_scroll",
			wait: "mcp_browser_wait",
			screenshot: "mcp_browser_screenshot",
			click: "mcp_browser_click",
			type: "mcp_browser_type",
			select: "mcp_browser_select"
		};
		const toolName = actionMap[p2Request.params.action];
		if (toolName === undefined || !BROWSER_TOOL_NAMES.includes(toolName)) throw Object.assign(new Error("Unsupported plugin browser action."), { code: "plugin_browser_action_unsupported" });
		if (!browser.actions.includes(p2Request.params.action as (typeof browser.actions)[number])) throw Object.assign(new Error("Plugin browser action is not declared."), { code: "plugin_browser_action_not_declared" });
		if (["mcp_browser_navigate", "mcp_browser_navigation", "mcp_browser_scroll", "mcp_browser_click", "mcp_browser_type", "mcp_browser_select"].includes(toolName)) throw Object.assign(new Error("Plugin browser write actions require the Approval Gateway and are not callable directly."), { code: "plugin_browser_approval_required" });
		if (session.sessionId === undefined) throw Object.assign(new Error("A session is required for plugin browser actions."), { code: "session_required" });
		result = await studioBrowserRuntime.createControl(socket, session.sessionId).execute(toolName, p2Request.params.args ?? {});
	} else if (p2Request.method === "plugin.language-service.start") {
		if (session.sessionId === undefined || session.activeWorkspace?.rootPath === undefined) throw Object.assign(new Error("A workspace-backed session is required for a language service."), { code: "plugin_language_service_workspace_required" });
		result = await startPluginLanguageService({ serviceId: p2Request.params.serviceId, sessionId: session.sessionId, workspaceRoot: session.activeWorkspace.rootPath });
	} else if (p2Request.method === "plugin.language-service.stop") {
		if (session.sessionId === undefined) throw Object.assign(new Error("A session is required to stop a language service."), { code: "session_required" });
		result = stopPluginLanguageService({ serviceId: p2Request.params.serviceId, sessionId: session.sessionId });
	} else if (p2Request.method === "plugin.harness.convert.preview" || p2Request.method === "plugin.harness.convert.activate") {
		const record = (await getPluginCatalog()).plugins.find((candidate): boolean => candidate.id === p2Request.params.pluginId);
		if (record === undefined) throw Object.assign(new Error("Plugin was not found."), { code: "plugin_not_found" });
		const report = createNativeConversionReport(record);
		if (p2Request.method === "plugin.harness.convert.activate" && report.fingerprint !== p2Request.params.expectedFingerprint) throw Object.assign(new Error("Plugin fingerprint changed; rescan before activating conversion."), { code: "plugin_fingerprint_conflict" });
		result = { ...report, activated: p2Request.method === "plugin.harness.convert.activate" && report.activationReady };
	} else if (p2Request.method === "plugin.events.publish") {
		result = await publishPluginEvent({
			pluginId: p2Request.params.pluginId,
			topic: p2Request.params.topic,
			payload: p2Request.params.payload,
			...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
			...(session.activeWorkspace?.id === undefined ? {} : { workspaceId: session.activeWorkspace.id })
		});
	} else if (p2Request.method === "plugin.events.subscribe") {
		result = await subscribePluginEvents({
			pluginId: p2Request.params.pluginId,
			topic: p2Request.params.topic,
			...(p2Request.params.cursor === undefined ? {} : { cursor: p2Request.params.cursor })
		});
	} else if (p2Request.method === "plugin.events.ack") {
		result = await acknowledgePluginEvent(p2Request.params.pluginId, p2Request.params.topic, p2Request.params.cursor);
	} else if (p2Request.method === "plugin.timeline.append") {
		const registered = (await getPluginP2Snapshot()).timelineParts.find((part): boolean => part.pluginId === p2Request.params.pluginId && part.partType === p2Request.params.partType);
		if (registered === undefined) throw Object.assign(new Error("Plugin timeline part is not registered."), { code: "plugin_timeline_part_denied" });
		const sessionId = session.sessionId;
		if (sessionId === undefined) throw Object.assign(new Error("A session is required for plugin timeline parts."), { code: "session_required" });
		const requestId = `plugin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		sendStudioPersistentSessionEvent(socket, session, sessionId, requestId, "plugin.timeline.part", {
			pluginId: p2Request.params.pluginId,
			partType: p2Request.params.partType,
			...(p2Request.params.title === undefined ? {} : { title: p2Request.params.title }),
			...(p2Request.params.summary === undefined ? {} : { summary: p2Request.params.summary }),
			...(p2Request.params.icon === undefined ? {} : { icon: p2Request.params.icon }),
			...(p2Request.params.status === undefined ? {} : { status: p2Request.params.status }),
			data: p2Request.params.data
		});
		result = { appended: true, requestId };
	} else {
		throw Object.assign(new Error(`Unsupported P2 extension method: ${p2Request.method}.`), { code: "plugin_p2_method_unsupported" });
	}
	sendJson(socket, { type: "response", id: request.id, ok: true, result });
}
