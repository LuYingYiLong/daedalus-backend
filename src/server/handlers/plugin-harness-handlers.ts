import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { ClientSession } from "../client-session.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import { getClientConnection } from "../client-connections.js";
import { sendJson } from "../send-json.js";
import {
	invalidateHarnessPluginTrust,
	readHarnessRuntimeConfig,
	updateHarnessRuntimeConfig
} from "../../plugins/harness/config-store.js";
import { detectHarnessInstallation } from "../../plugins/harness/installation.js";
import { parseHarnessBundlePatch } from "../../plugins/harness/patch-parser.js";
import { getHarnessRuntimeSnapshot, stopAllHarnessRuntimes } from "../../plugins/harness/manager.js";
import { readPluginRecords } from "../../plugins/store.js";
import type { HarnessInstallation, HarnessRuntimeConfig } from "../../plugins/types.js";

type HarnessRequest = Extract<ClientRequest, { method: `plugin.harness.${string}` }>;

function ensureStudio(socket: WebSocket): void {
	if (getClientConnection(socket)?.clientType !== "studio") throw Object.assign(new Error("Harness plugin management is only available to Daedalus Studio."), { code: "studio_only" });
}

function publicInstallation(value: HarnessInstallation): Omit<HarnessInstallation, "command" | "args" | "readOnlyPaths"> {
	const { command: _command, args: _args, readOnlyPaths: _readOnlyPaths, ...result } = value;
	return result;
}

export async function handlePluginHarnessRequest(socket: WebSocket, request: ClientRequest, _session: ClientSession, _mcpHost: McpHost): Promise<void> {
	ensureStudio(socket);
	const harnessRequest = request as HarnessRequest;
	let result: unknown;
	switch (harnessRequest.method) {
	case "plugin.harness.config.get": {
		const config: HarnessRuntimeConfig = await readHarnessRuntimeConfig();
		result = { config, installation: publicInstallation(await detectHarnessInstallation(config)) };
		break;
	}
	case "plugin.harness.config.update": {
		const params = harnessRequest.params as { expectedRevision: string; enabled: boolean; executablePath: string | null; sourceRoot: string | null; launchMode: "installed" | "source" };
		const updated = await updateHarnessRuntimeConfig({ enabled: params.enabled, executablePath: params.executablePath, sourceRoot: params.sourceRoot, launchMode: params.launchMode }, params.expectedRevision);
		if (updated.changed) {
			await stopAllHarnessRuntimes();
			await invalidateHarnessPluginTrust();
		}
		result = { config: updated.config, installation: publicInstallation(await detectHarnessInstallation(updated.config)), trustInvalidated: updated.changed };
		break;
	}
	case "plugin.harness.detect": {
		const config: HarnessRuntimeConfig = await readHarnessRuntimeConfig();
		const params = harnessRequest.params as { draft?: { enabled: boolean; executablePath: string | null; sourceRoot: string | null; launchMode: "installed" | "source" } } | undefined;
		const draft = params?.draft;
		const responseConfig: HarnessRuntimeConfig = draft === undefined
			? config
			: {
				...config,
				enabled: draft.enabled,
				executablePath: draft.executablePath?.trim() || null,
				sourceRoot: draft.sourceRoot?.trim() || null,
				launchMode: draft.launchMode,
			};
		// 检测独立校验草稿路径，保存时仍保留开关状态，不会因检测隐式启用运行时
		const detectionConfig: HarnessRuntimeConfig = draft === undefined
			? config
			: { ...responseConfig, enabled: true };
		result = { config: responseConfig, installation: publicInstallation(await detectHarnessInstallation(detectionConfig)) };
		break;
	}
	case "plugin.harness.preview": {
		const pluginId: string = (harnessRequest.params as { pluginId: string }).pluginId;
		const plugin = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
		if (plugin === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
		if (!plugin.compatibility.harnessBundle || plugin.compatibility.patchPath === undefined) throw Object.assign(new Error("Plugin does not declare a Harness Bundle patch."), { code: "plugin_harness_bundle_missing" });
		result = await parseHarnessBundlePatch(plugin.packageRoot, plugin.compatibility.patchPath);
		break;
	}
	case "plugin.harness.runtime.status": {
		const pluginId: string = (harnessRequest.params as { pluginId: string }).pluginId;
		const config: HarnessRuntimeConfig = await readHarnessRuntimeConfig();
		result = { runtime: getHarnessRuntimeSnapshot(pluginId) ?? null, installation: publicInstallation(await detectHarnessInstallation(config)) };
		break;
	}
	}
	sendJson(socket, { type: "response", id: request.id, ok: true, result });
}
