import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { createBackendHealthResult } from "../backend-health.js";
import { createSlashCommandListResult } from "../slash-commands.js";
import { listPromptTemplates } from "../../prompts/registry.js";
import { listSkillSummaries } from "../../skills/catalog.js";
import { getSkillContent, installSkillFromPath, removePersonalSkill, setWorkspaceSkillEnabled, updateSkillContent } from "../../skills/management.js";
import type { SkillWorkspace } from "../../skills/types.js";
import { sendGlobalEvent } from "../session-events.js";
import { getUserPromptConfig, setUserPromptConfig } from "../../user-prompt-store.js";
import { getGeneralSettings, updateGeneralSettings } from "../../general-settings-store.js";
import { getWebSearchSettingsStatus, updateWebSearchSettings } from "../../web-search-settings-store.js";
import { getDaedalusDir } from "../../app-paths.js";
import { getUsageMetricsSummary, getUsageMetricsTrends, listUsageMetricsLogs } from "../../usage/metrics-store.js";
import { requestBackendShutdown } from "../../runtime/shutdown.js";
import { clearWorkbenchNextStepHints, emitWorkbenchUpdated } from "../workbench.js";

declare const __DAEDALUS_SEA_BUILD__: boolean | undefined;

type BackendUpdateModule = typeof import("../backend-update.js");

async function loadSourceBackendUpdateModule(): Promise<BackendUpdateModule> {
	const modulePath: string = "../backend-update.js";
	return await import(modulePath) as BackendUpdateModule;
}

function getActiveSkillWorkspace(session: ClientSession): SkillWorkspace | undefined {
	if (session.activeWorkspace !== undefined) {
		return { id: session.activeWorkspace.id, rootPath: session.activeWorkspace.rootPath };
	}
	if (session.godotProjectPath !== undefined) {
		return { id: `runtime:${session.godotProjectPath}`, rootPath: session.godotProjectPath };
	}
	return undefined;
}

function getSkillWorkspace(session: ClientSession): SkillWorkspace {
	return getActiveSkillWorkspace(session) ?? { id: "studio:global", rootPath: getDaedalusDir() };
}

function getProjectSkillWorkspace(session: ClientSession): SkillWorkspace {
	const workspace: SkillWorkspace | undefined = getActiveSkillWorkspace(session);
	if (workspace === undefined) {
		throw new Error("No active workspace is available for project skill management.");
	}
	return workspace;
}

async function sendSkillList(socket: WebSocket, requestId: string, workspace: SkillWorkspace): Promise<void> {
	sendJson(socket, { type: "response", id: requestId, ok: true, result: await listSkillSummaries(workspace) });
}

export async function handleCoreRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "ping":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: { message: "pong" }
		});
		break;

	case "backend.health":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: createBackendHealthResult()
		});
		break;

	case "backend.shutdown": {
		if ((process.env.DAEDALUS_BACKEND_AUTH_TOKEN?.length ?? 0) === 0) {
			throw new Error("Authenticated managed runtime is required for backend shutdown.");
		}
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: { accepted: true }
		});
		const shutdownTimer = setTimeout((): void => {
			if (!requestBackendShutdown("authenticated_rpc")) {
				process.exitCode = 1;
			}
		}, 25);
		shutdownTimer.unref();
		break;
	}

	case "backend.update.check": {
		if (typeof __DAEDALUS_SEA_BUILD__ !== "undefined" && __DAEDALUS_SEA_BUILD__) {
			throw new Error("Backend updates are managed by Daedalus Studio for this distribution.");
		}
		const { checkBackendUpdate } = await loadSourceBackendUpdateModule();
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await checkBackendUpdate()
		});
		break;
	}

	case "backend.update.install": {
		if (typeof __DAEDALUS_SEA_BUILD__ !== "undefined" && __DAEDALUS_SEA_BUILD__) {
			throw new Error("Backend updates are managed by Daedalus Studio for this distribution.");
		}
		const { installBackendUpdate } = await loadSourceBackendUpdateModule();
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await installBackendUpdate(request.params)
		});
		break;
	}

	case "usage.metrics.summary.get":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await getUsageMetricsSummary(request.params)
		});
		break;

	case "usage.metrics.logs.list":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await listUsageMetricsLogs(request.params)
		});
		break;

	case "usage.metrics.trends.get":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await getUsageMetricsTrends(request.params)
		});
		break;

	case "command.list":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: createSlashCommandListResult()
		});
		break;

	case "prompt.list":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				prompts: listPromptTemplates()
			}
		});
		break;

	case "userPrompt.get":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await getUserPromptConfig()
		});
		break;

	case "userPrompt.set":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await setUserPromptConfig(request.params)
		});
		break;

	case "generalSettings.get":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await getGeneralSettings()
		});
		break;

	case "generalSettings.update":
		{
			const settings = await updateGeneralSettings(request.params);
			if (request.params.nextStepHintsEnabled === false) {
				session.nextStepHintAbortController?.abort();
				session.nextStepHintAbortController = undefined;
				clearWorkbenchNextStepHints(session);
				emitWorkbenchUpdated(socket, request.id, session);
			}
			if (request.params.godotExecutablePath !== undefined) {
				await mcpHost.refreshGodotExecutableConfiguration();
				if (session.activeWorkspace?.godotExecutablePath === undefined) {
					session.godotExecutablePath = settings.godotExecutablePath ?? undefined;
				}
			}
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: settings
		});
		break;
		}

	case "webSearchSettings.get":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await getWebSearchSettingsStatus()
		});
		break;

	case "webSearchSettings.update":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await updateWebSearchSettings(request.params)
		});
		break;

	case "skill.list":
	case "skill.reload":
		await sendSkillList(socket, request.id, getSkillWorkspace(session));
		break;

	case "skill.get": {
		const workspace: SkillWorkspace = getSkillWorkspace(session);
		sendJson(socket, { type: "response", id: request.id, ok: true, result: { ref: request.params.ref, content: await getSkillContent(workspace, request.params.ref) } });
		break;
	}

	case "skill.set_enabled": {
		const workspace: SkillWorkspace = getSkillWorkspace(session);
		await setWorkspaceSkillEnabled(workspace, request.params.ref, request.params.enabled);
		await sendSkillList(socket, request.id, workspace);
		sendGlobalEvent(socket, request.id, "skill.catalog.changed", { ref: request.params.ref });
		break;
	}

	case "skill.update": {
		const workspace: SkillWorkspace = getSkillWorkspace(session);
		await updateSkillContent(workspace, request.params.ref, request.params.content);
		await sendSkillList(socket, request.id, workspace);
		sendGlobalEvent(socket, request.id, "skill.catalog.changed", { ref: request.params.ref });
		break;
	}

	case "skill.remove": {
		const workspace: SkillWorkspace = getSkillWorkspace(session);
		await removePersonalSkill(workspace, request.params.ref);
		await sendSkillList(socket, request.id, workspace);
		sendGlobalEvent(socket, request.id, "skill.catalog.changed", { ref: request.params.ref });
		break;
	}

	case "skill.install": {
		const workspace: SkillWorkspace = request.params.source === "project" ? getProjectSkillWorkspace(session) : getSkillWorkspace(session);
		const ref: string = await installSkillFromPath(workspace, request.params.source, request.params.kind, request.params.path);
		await sendSkillList(socket, request.id, workspace);
		sendGlobalEvent(socket, request.id, "skill.catalog.changed", { ref });
		break;
	}

		default:
			throw new Error(`Unsupported core method: ${request.method}`);
	}
}
