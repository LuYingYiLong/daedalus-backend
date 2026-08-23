import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";
import { getPluginCatalog, updatePluginFromSource } from "../../plugins/manager.js";
import { listPluginDevelopmentRuns, getPluginDevelopmentRun } from "../../plugins/maintenance/diagnostic-history.js";
import { createMaintenanceOperation, getMaintenanceOperation, updateMaintenanceOperation } from "../../plugins/maintenance/operation-store.js";
import { applyPluginChangelogDraft, confirmPluginRelease, getPluginChangelogDraft, previewPluginRelease, publishPluginArtifact } from "../../plugins/maintenance/release-service.js";
import type { PluginSource } from "../../plugins/types.js";
import { previewPluginUpdate } from "../../plugins/maintenance/update-preflight.js";
import { publicPluginRecord } from "./plugin-handlers.js";

type PluginMaintenanceRequest = Extract<ClientRequest, { method: `plugin.${string}` }>;

function ensureStudio(socket: WebSocket): void {
	if (getClientConnection(socket)?.clientType !== "studio") throw Object.assign(new Error("Plugin maintenance is only available to Daedalus Studio."), { code: "studio_only" });
}

function publicOperation(operation: Awaited<ReturnType<typeof createMaintenanceOperation>> | null): unknown {
	if (operation === null) return null;
	return { ...operation, expectedFingerprint: operation.expectedFingerprint === undefined ? undefined : `${operation.expectedFingerprint.slice(0, 8)}…` };
}

async function runMaintenanceOperation<T extends object>(pluginId: string, kind: "changelog" | "release" | "publish", stage: "changelog_draft" | "artifact" | "publishing", work: (operationId: string) => Promise<T>, awaitingConfirmation: boolean): Promise<T & { operationId: string }> {
	const operation = await createMaintenanceOperation({ pluginId, kind });
	try {
		await updateMaintenanceOperation(operation.id, { stage, progress: 20 });
		const result = await work(operation.id);
		await updateMaintenanceOperation(operation.id, { stage: awaitingConfirmation ? "awaiting_confirmation" : "completed", progress: awaitingConfirmation ? 80 : 100, status: awaitingConfirmation ? "awaiting_confirmation" : "succeeded" });
		return { ...result, operationId: operation.id };
	} catch (error: unknown) {
		await updateMaintenanceOperation(operation.id, { stage: "failed", status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }).catch((): void => undefined);
		throw error;
	}
}

export async function handlePluginMaintenanceRequest(socket: WebSocket, request: ClientRequest, _session: ClientSession, _mcpHost: McpHost): Promise<void> {
	ensureStudio(socket);
	const pluginRequest = request as PluginMaintenanceRequest;
	let result: unknown;
	switch (pluginRequest.method) {
	case "plugin.update.preview": {
		const params = pluginRequest.params as { pluginId: string; expectedFingerprint: string; source: PluginSource };
		const plugin = (await getPluginCatalog()).plugins.find((item) => item.id === params.pluginId);
		if (plugin === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
		if (plugin.fingerprint !== params.expectedFingerprint) throw Object.assign(new Error("Plugin fingerprint is stale."), { code: "plugin_fingerprint_stale" });
		result = await previewPluginUpdate({ plugin, expectedFingerprint: params.expectedFingerprint, source: params.source });
		break;
	}
	case "plugin.update.install": {
		const params = pluginRequest.params as { pluginId: string; expectedFingerprint: string; source: PluginSource };
		const current = (await getPluginCatalog()).plugins.find((item) => item.id === params.pluginId);
		if (current === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
		const preflight = await previewPluginUpdate({ plugin: current, expectedFingerprint: params.expectedFingerprint, source: params.source });
		if (preflight.blockers.length > 0) throw Object.assign(new Error(preflight.blockers.join(" ")), { code: "plugin_update_blocked" });
		const operation = await createMaintenanceOperation({ pluginId: params.pluginId, kind: "update", expectedFingerprint: params.expectedFingerprint });
		try {
			await updateMaintenanceOperation(operation.id, { stage: "staging", progress: 15 });
			await updateMaintenanceOperation(operation.id, { stage: "static_validation", progress: 35 });
			const plugin = await updatePluginFromSource(params.pluginId, params.source, params.expectedFingerprint);
			await updateMaintenanceOperation(operation.id, { stage: "completed", progress: 100, status: "succeeded" });
			result = { operationId: operation.id, plugin: publicPluginRecord(plugin) };
		} catch (error: unknown) {
			await updateMaintenanceOperation(operation.id, { stage: "failed", status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }).catch((): void => undefined);
			throw error;
		}
		break;
	}
	case "plugin.update.operation.get":
		result = publicOperation(await getMaintenanceOperation((pluginRequest.params as { operationId: string }).operationId));
		break;
	case "plugin.update.operation.cancel": {
		const operationId = (pluginRequest.params as { operationId: string }).operationId;
		const operation = await getMaintenanceOperation(operationId);
		result = publicOperation(operation === null || operation.status !== "running" ? operation : await updateMaintenanceOperation(operationId, { stage: "cancelled", status: "cancelled" }));
		break;
	}
	case "plugin.development.runs.list": {
		const params = (pluginRequest.params ?? {}) as { pluginId?: string; limit?: number };
		result = await listPluginDevelopmentRuns(params.pluginId, params.limit);
		break;
	}
	case "plugin.development.runs.get":
		result = await getPluginDevelopmentRun((pluginRequest.params as { runId: string }).runId);
		break;
	case "plugin.changelog.generate": {
		const params = pluginRequest.params as { pluginId: string; nextVersion: string; aiText?: string };
		result = await runMaintenanceOperation(params.pluginId, "changelog", "changelog_draft", async (): Promise<Awaited<ReturnType<typeof previewPluginRelease>>> => await previewPluginRelease(params), true);
		break;
	}
	case "plugin.changelog.apply":
		result = await applyPluginChangelogDraft(pluginRequest.params as { draftId: string; expectedRevision: string; accepted: boolean; editedText?: string });
		break;
	case "plugin.release.preview": {
		const params = pluginRequest.params as { pluginId: string; nextVersion: string; aiText?: string };
		result = await runMaintenanceOperation(params.pluginId, "release", "changelog_draft", async (): Promise<Awaited<ReturnType<typeof previewPluginRelease>>> => await previewPluginRelease(params), true);
		break;
	}
	case "plugin.release.confirm":
	case "plugin.release.export": {
		const params = pluginRequest.params as { draftId: string; expectedRevision: string; editedText?: string };
		const draft = await getPluginChangelogDraft(params.draftId);
		result = await runMaintenanceOperation(draft?.pluginId ?? "unknown", "release", "artifact", async (): Promise<Awaited<ReturnType<typeof confirmPluginRelease>>> => await confirmPluginRelease(params), false);
		break;
	}
	case "plugin.publish.confirm": {
		const params = pluginRequest.params as { artifactPath: string; registry: string };
		result = await runMaintenanceOperation("release", "publish", "publishing", async (): Promise<Awaited<ReturnType<typeof publishPluginArtifact>>> => await publishPluginArtifact(params), false);
		break;
	}
	default:
		throw Object.assign(new Error("Unsupported plugin maintenance request."), { code: "plugin_maintenance_method_unsupported" });
	}
	sendJson(socket, { type: "response", id: request.id, ok: true, result });
}
