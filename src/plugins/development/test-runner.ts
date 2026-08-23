import { randomUUID } from "node:crypto";
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
import { createPluginDiagnostic } from "./diagnostics.js";
import { cleanupPluginSandboxTestRun, createPluginSandboxTestRun } from "./sandbox-test-host.js";
import { runDeterministicAdapter } from "./test-adapters.js";

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
		return p2.panels.find((entry): boolean => entry.pluginId === plugin.id && (entry.panelId === test.target || entry.panelId.endsWith(`:${test.target}`))) === undefined ? Promise.reject(new Error(`Plugin panel was not registered: ${test.target}.`)) : runDeterministicAdapter(test);
	case "settings":
		return p2.settings.find((entry): boolean => entry.pluginId === plugin.id && (entry.settingsId === test.target || entry.settingsId.endsWith(`:${test.target}`))) === undefined ? Promise.reject(new Error(`Plugin settings page was not registered: ${test.target}.`)) : runDeterministicAdapter(test);
	case "timeline_part":
		return p2.timelineParts.find((entry): boolean => entry.pluginId === plugin.id && (entry.partType === test.target || entry.partType.endsWith(`:${test.target}`))) === undefined ? Promise.reject(new Error(`Plugin timeline part was not registered: ${test.target}.`)) : runDeterministicAdapter(test);
	case "browser":
		return p2.browser.find((entry): boolean => entry.pluginId === plugin.id) === undefined ? Promise.reject(new Error("Plugin browser declaration was not registered.")) : runDeterministicAdapter(test);
	case "language_service":
		return p2.languageServices.find((entry): boolean => entry.pluginId === plugin.id && (entry.id === test.target || entry.id.endsWith(`:${test.target}`))) === undefined ? Promise.reject(new Error(`Plugin language service was not registered: ${test.target}.`)) : runDeterministicAdapter(test);
	case "event":
		return p2.events.find((entry): boolean => entry.pluginId === plugin.id && (entry.topic === test.target || entry.topic.endsWith(`:${test.target}`))) === undefined ? Promise.reject(new Error(`Plugin event was not registered: ${test.target}.`)) : runDeterministicAdapter(test);
	}
}

export async function runPluginDevelopmentTests(plugin: PluginRecord, revision: string, plan: PluginDevelopmentTestPlan, abortSignal?: AbortSignal): Promise<PluginDevelopmentTestResult> {
	const startedAt = Date.now();
	const runId = `plugin-test-${randomUUID()}`;
	const sandboxRun = await createPluginSandboxTestRun(runId);
	const sessionId = `plugin-test:${plugin.id}:${runId}`;
	const cases: PluginDevelopmentTestResult["cases"] = [];
	const diagnostics: PluginDevelopmentTestResult["diagnostics"] = [];
	const throwIfAborted = (): void => {
		if (abortSignal?.aborted) throw Object.assign(new Error("Plugin development test was cancelled."), { code: "plugin_dev_test_cancelled" });
	};
	const stopOnAbort = (): void => {
		void stopPlugin(plugin.id, sessionId).catch((): void => undefined);
	};
	abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
	try {
		throwIfAborted();
		if (!sandboxRun.sandbox.available) {
			diagnostics.push(createPluginDiagnostic({ code: "sandbox_unavailable", message: "Plugin development tests require an available OS sandbox.", stage: "sandbox", retryable: false, hint: "Configure the managed Daedalus sandbox helper and restart Backend." }));
			return { runId, ok: false, pluginId: plugin.id, revision, durationMs: Date.now() - startedAt, sandbox: { ...sandboxRun.sandbox, workspaceDisplay: sandboxRun.workspaceDisplay }, passed: 0, failed: 0, cases: plan.cases.map((test) => ({ id: test.id, capability: test.capability, target: test.target, status: "skipped", durationMs: 0, code: "sandbox_unavailable", retryable: false })), diagnostics };
		}
		await ensurePluginRuntime(plugin.id, { sessionId, workspaceId: sessionId, workspaceRoot: sandboxRun.workspaceRoot });
		for (const test of plan.cases) {
			throwIfAborted();
			const caseStartedAt = Date.now();
			try {
				const result = await runCase(plugin, sessionId, test);
				assertResult(test, result);
				cases.push({ id: test.id, capability: test.capability, target: test.target, status: "passed", durationMs: Date.now() - caseStartedAt, retryable: false, message: "Passed" });
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "plugin_test_failed";
				const retryable = !["sandbox_unavailable", "plugin_runtime_quarantined", "plugin_dev_test_cancelled"].includes(code);
				cases.push({ id: test.id, capability: test.capability, target: test.target, status: "failed", durationMs: Date.now() - caseStartedAt, retryable, code, message: message.slice(0, 2_000) });
				diagnostics.push(createPluginDiagnostic({ code, message, stage: "test", caseId: test.id, capability: test.capability, retryable, hint: "Use this diagnostic to generate a new plugin revision." }));
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "plugin_test_failed";
		diagnostics.push(createPluginDiagnostic({ code, message, stage: code.includes("timeout") ? "timeout" : code === "plugin_dev_test_cancelled" ? "test" : "sandbox", retryable: !["sandbox_unavailable", "plugin_runtime_quarantined", "plugin_dev_test_cancelled"].includes(code), hint: "The plugin was not allowed to run outside the OS sandbox." }));
	} finally {
		abortSignal?.removeEventListener("abort", stopOnAbort);
		await stopPlugin(plugin.id, sessionId).catch((): void => undefined);
		await cleanupPluginSandboxTestRun(sandboxRun).catch((error: unknown): void => { diagnostics.push(createPluginDiagnostic({ code: "sandbox_cleanup_failed", message: error instanceof Error ? error.message : String(error), stage: "cleanup", retryable: true })); });
	}
	const failed = cases.filter((entry): boolean => entry.status === "failed").length;
	return { runId, ok: failed === 0 && diagnostics.every((entry) => entry.severity !== "error"), pluginId: plugin.id, revision, durationMs: Date.now() - startedAt, sandbox: { ...sandboxRun.sandbox, workspaceDisplay: sandboxRun.workspaceDisplay }, passed: cases.filter((entry) => entry.status === "passed").length, failed, cases, diagnostics };
}
