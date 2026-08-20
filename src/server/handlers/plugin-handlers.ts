import type WebSocket from "ws";
import { basename } from "node:path";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";
import {
	getPluginCatalog,
	installPlugin,
	pluginFingerprint,
	removePlugin,
	scanPluginSource,
	updateActivePluginProfile,
	updatePluginTrustStatus
} from "../../plugins/manager.js";
import type { PluginCatalogResult, PluginRecord, PluginScanResult, PluginSource } from "../../plugins/types.js";

type PluginRequest = Extract<ClientRequest, { method: `plugin.${string}` }>;

function ensureStudio(socket: WebSocket): void {
	if (getClientConnection(socket)?.clientType !== "studio") {
		throw Object.assign(new Error("Plugin management is only available to Daedalus Studio."), { code: "studio_only" });
	}
}

function publicScanResult(result: PluginScanResult): PluginScanResult {
	const { packageRoot: _packageRoot, ...publicResult } = result;
	return publicResult;
}

function publicPluginRecord(record: PluginRecord): PluginRecord {
	let source: PluginSource = record.source;
	if (record.source.type === "local" || record.source.type === "tarball") {
		source = { ...record.source, path: `[local]/${basename(record.source.path)}` };
	} else if (record.source.type === "git") {
		try {
			const url = new URL(record.source.url);
			url.username = "";
			url.password = "";
			source = { ...record.source, url: url.toString() };
		} catch {
			source = { ...record.source, url: "[redacted-url]" };
		}
	}
	return { ...record, source, packageRoot: `[daedalus]/plugins/packages/${basename(record.packageRoot)}` };
}

function publicCatalog(catalog: PluginCatalogResult): PluginCatalogResult {
	return { ...catalog, plugins: catalog.plugins.map(publicPluginRecord) };
}

export async function handlePluginRequest(socket: WebSocket, request: ClientRequest, _session: ClientSession, _mcpHost: McpHost): Promise<void> {
	ensureStudio(socket);
	const pluginRequest: PluginRequest = request as PluginRequest;
	let result: unknown;
	switch (pluginRequest.method) {
	case "plugin.catalog.list":
		result = publicCatalog(await getPluginCatalog());
		break;
	case "plugin.scan":
		result = publicScanResult(await scanPluginSource(pluginRequest.params.source as PluginSource));
		break;
	case "plugin.install":
		result = { plugin: publicPluginRecord(await installPlugin(pluginRequest.params.source as PluginSource)), catalog: publicCatalog(await getPluginCatalog()) };
		break;
	case "plugin.remove":
		await removePlugin(pluginRequest.params.pluginId);
		result = publicCatalog(await getPluginCatalog());
		break;
	case "plugin.trust.update": {
		const plugin: PluginRecord = await updatePluginTrustStatus(pluginRequest.params.pluginId, pluginRequest.params.fingerprint, pluginRequest.params.status);
		result = { plugin: publicPluginRecord(plugin), fingerprint: pluginFingerprint(plugin) };
		break;
	}
	case "plugin.profile.get":
		result = publicCatalog(await getPluginCatalog());
		break;
	case "plugin.profile.update":
		result = publicCatalog(await updateActivePluginProfile(pluginRequest.params.pluginIds));
		break;
	}
	sendJson(socket, { type: "response", id: request.id, ok: true, result });
}
