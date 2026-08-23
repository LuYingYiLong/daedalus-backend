import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePluginRuntime, invokePlugin, stopPlugin } from "../runtime/manager.js";
import {
	getPluginContextProviderById,
	getPluginSkill,
	getPluginToolEntries,
	listPluginCommands,
	listPluginContextProviders,
	listPluginHooks,
	listPluginMcps,
	listPluginSkills
} from "../runtime/registries.js";
import { getPluginP2Snapshot } from "../p2/registry.js";
import type { PluginRecord } from "../types.js";
import type { PluginDevelopmentTestCase, PluginDevelopmentTestPlan, PluginDevelopmentTestResult } from "./types.js";

function text(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function assertResult(test: PluginDevelopmentTestCase, value: unknown): void {
	const serialized = text(value);
	if (test.expect?.contains !== undefined && !serialized.includes(test.expect.contains)) throw new Error(`Result does not contain ${JSON.stringify(test.expect.contains)}.`);
	if (test.expect?.ok === true && typeof value === "object" && value !== null && (value as Record<string, unknown>).ok === false) throw new Error("Result reported ok=false.");
}

async function runCase(plugin: PluginRecord, sessionId: string, test: PluginDevelopmentTestCase): Promise<unknown> {
	const coreSkills = listPluginSkills().filter((entry): boolean => entry.pluginId === plugin.id);
	const p2 = await getPluginP2Snapshot();
	switch (test.capability) {
	case "registry": {
		const registered = [
			...getPluginToolEntries().filter((entry): boolean => entry.pluginId === plugin.id).map((entry): string => entry.name),
			...coreSkills.map((entry): string => entry.slug),
			...listPluginMcps().filter((entry): boolean => entry.pluginId === plugin.id).map((entry): string => entry.localServerId),
			...p2.commands.filter((entry): boolean => entry.pluginId === plugin.id).map((entry): string => entry.command),
			...p2.contextProviders.filter((entry): boolean => entry.pluginId === plugin.id).map((entry): string => entry.id)
		];
		if (test.expect?.registered !== false && !registered.some((name): boolean => name === test.target || name.endsWith(`:${test.target}`))) throw new Error(`Registration was not found: ${test.target}.`);
		return { registered };
	}
	case "tool": {
		const entry = getPluginToolEntries().find((candidate): boolean => candidate.pluginId === plugin.id && (candidate.name === test.target || candidate.llmToolName === test.target));
		if (entry === undefined) throw new Error(`Plugin tool was not registered: ${test.target}.`);
		return await invokePlugin(plugin.id, sessionId, "tool", entry.name, test.input ?? {});
	}
	case "skill": {
		const entry = coreSkills.find((candidate): boolean => candidate.slug === test.target || candidate.ref === test.target) ?? getPluginSkill(test.target);
		if (entry === undefined || entry.pluginId !== plugin.id) throw new Error(`Plugin Skill was not registered: ${test.target}.`);
		return { ref: entry.ref, body: entry.body };
	}
	case "hook": {
		const entry = listPluginHooks(test.target).find((candidate): boolean => candidate.pluginId === plugin.id) ?? [...new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "Stop"])].flatMap(listPluginHooks).find((candidate): boolean => candidate.pluginId === plugin.id && candidate.handlerName === test.target);
		if (entry === undefined) throw new Error(`Plugin Hook was not registered: ${test.target}.`);
		return await invokePlugin(plugin.id, sessionId, "hook", entry.handlerName, test.input ?? {});
	}
	case "mcp": {
		const server = listPluginMcps().find((candidate): boolean => candidate.pluginId === plugin.id && (candidate.localServerId === test.target || candidate.tools.some((tool): boolean => tool.name === test.target)));
		if (server === undefined) throw new Error(`Plugin MCP capability was not registered: ${test.target}.`);
		const tool = server.tools.find((candidate): boolean => candidate.name === test.target) ?? server.tools[0];
		if (tool === undefined) return { serverId: server.serverId, registered: true };
		return await invokePlugin(plugin.id, sessionId, "mcp_tool", `${server.localServerId}:${tool.name}`, test.input ?? {});
	}
	case "command": {
		const entry = listPluginCommands().find((candidate): boolean => candidate.pluginId === plugin.id && (candidate.command === test.target || candidate.id === test.target));
		if (entry === undefined) throw new Error(`Plugin command was not registered: ${test.target}.`);
		return await invokePlugin(plugin.id, sessionId, "command", entry.handlerName, test.input ?? {});
	}
	case "context_provider": {
		const entry = listPluginContextProviders().find((candidate): boolean => candidate.pluginId === plugin.id && (candidate.id === test.target || candidate.providerId === test.target)) ?? getPluginContextProviderById(test.target);
		if (entry === undefined || entry.pluginId !== plugin.id) throw new Error(`Plugin context provider was not registered: ${test.target}.`);
		return await invokePlugin(plugin.id, sessionId, "context_provider", entry.handlerName, test.input ?? {});
	}
	case "panel":
		return p2.panels.find((entry): boolean => entry.pluginId === plugin.id && (entry.panelId === test.target || entry.panelId.endsWith(`:${test.target}`))) ?? Promise.reject(new Error(`Plugin panel was not registered: ${test.target}.`));
	case "settings":
		return p2.settings.find((entry): boolean => entry.pluginId === plugin.id && (entry.settingsId === test.target || entry.settingsId.endsWith(`:${test.target}`))) ?? Promise.reject(new Error(`Plugin settings page was not registered: ${test.target}.`));
	case "timeline_part":
		return p2.timelineParts.find((entry): boolean => entry.pluginId === plugin.id && (entry.partType === test.target || entry.partType.endsWith(`:${test.target}`))) ?? Promise.reject(new Error(`Plugin timeline part was not registered: ${test.target}.`));
	case "browser":
		return p2.browser.find((entry): boolean => entry.pluginId === plugin.id) ?? Promise.reject(new Error("Plugin browser declaration was not registered."));
	case "language_service":
		return p2.languageServices.find((entry): boolean => entry.pluginId === plugin.id && (entry.id === test.target || entry.id.endsWith(`:${test.target}`))) ?? Promise.reject(new Error(`Plugin language service was not registered: ${test.target}.`));
	case "event":
		return p2.events.find((entry): boolean => entry.pluginId === plugin.id && (entry.topic === test.target || entry.topic.endsWith(`:${test.target}`))) ?? Promise.reject(new Error(`Plugin event was not registered: ${test.target}.`));
	}
}

export async function runPluginDevelopmentTests(plugin: PluginRecord, revision: string, plan: PluginDevelopmentTestPlan, abortSignal?: AbortSignal): Promise<PluginDevelopmentTestResult> {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "daedalus-plugin-test-workspace-"));
	const sessionId = `plugin-test:${plugin.id}:${Date.now().toString(36)}`;
	const cases: PluginDevelopmentTestResult["cases"] = [];
	const throwIfAborted = (): void => {
		if (abortSignal?.aborted) throw Object.assign(new Error("Plugin development test was cancelled."), { code: "plugin_dev_test_cancelled" });
	};
	const stopOnAbort = (): void => {
		void stopPlugin(plugin.id, sessionId).catch((): void => undefined);
	};
	abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
	try {
		throwIfAborted();
		await ensurePluginRuntime(plugin.id, { sessionId, workspaceId: sessionId, workspaceRoot });
		for (const test of plan.cases) {
			throwIfAborted();
			try {
				const result = await runCase(plugin, sessionId, test);
				assertResult(test, result);
				cases.push({ id: test.id, ok: true, message: "Passed" });
			} catch (error: unknown) {
				cases.push({ id: test.id, ok: false, message: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
			}
		}
	} finally {
		abortSignal?.removeEventListener("abort", stopOnAbort);
		await stopPlugin(plugin.id, sessionId).catch((): void => undefined);
		await rm(workspaceRoot, { recursive: true, force: true });
	}
	const failed = cases.filter((entry): boolean => !entry.ok).length;
	return { ok: failed === 0, pluginId: plugin.id, revision, passed: cases.length - failed, failed, cases };
}
