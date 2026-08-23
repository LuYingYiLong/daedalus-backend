import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type WebSocket from "ws";
import { z } from "zod";
import type { WorkspaceConfig } from "../../workspace/types.js";
import { getPluginCatalog, installPlugin, updatePluginFromSource } from "../manager.js";
import type { PluginRecord } from "../types.js";
import { applyPluginDevelopmentSnapshot, preparePluginDevelopmentSnapshot, resolveManagedDevelopmentRoot } from "./snapshot.js";
import { pluginDevelopmentReviewRuntime } from "./review-runtime.js";
import { runPluginDevelopmentTests } from "./test-runner.js";
import { pluginDevelopmentTestPlanSchema, PLUGIN_DEVELOPMENT_TOOL_NAMES, type PluginDevelopmentControlContext, type PluginDevelopmentScope, type PluginDevelopmentToolName } from "./types.js";
import { validatePluginDevelopmentDirectory } from "./validation.js";

const targetSchema = z.object({
	slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
	scope: z.enum(["workspace", "personal"]),
	sourceFolderId: z.string().min(1).max(128).optional()
}).strict();

const MAX_REPAIR_ATTEMPTS: number = 3;
const repairAttempts = new Map<string, { static: number; runtime: number }>();

function attemptKey(sessionId: string, slug: string): string {
	return `${sessionId}\0${slug}`;
}

function recordAttempt(sessionId: string, slug: string, kind: "static" | "runtime", failed: boolean): number {
	const key = attemptKey(sessionId, slug);
	const current = repairAttempts.get(key) ?? { static: 0, runtime: 0 };
	if (!failed) current[kind] = 0;
	else current[kind] += 1;
	repairAttempts.set(key, current);
	return current[kind];
}

function publicRecord(plugin: PluginRecord): Record<string, unknown> {
	return {
		id: plugin.id,
		packageName: plugin.packageName,
		version: plugin.version,
		fingerprint: plugin.fingerprint,
		trust: plugin.trust,
		enabled: plugin.enabled,
		capabilities: plugin.nativePlugin?.capabilities ?? [],
		p2Capabilities: Object.keys(plugin.p2?.capabilities ?? {})
	};
}

async function findInstalledDevelopmentPlugin(rootPath: string, packageName: string): Promise<PluginRecord | undefined> {
	return (await getPluginCatalog()).plugins.find((plugin): boolean =>
		plugin.packageName === packageName
		&& plugin.source.type === "local"
		&& resolve(plugin.source.path) === resolve(rootPath)
	);
}

function assertToolName(value: string): asserts value is PluginDevelopmentToolName {
	if (!(PLUGIN_DEVELOPMENT_TOOL_NAMES as readonly string[]).includes(value)) throw new Error(`Unknown plugin development tool: ${value}.`);
}

export function createPluginDevelopmentControl(
	socket: WebSocket,
	sessionId: string,
	workspace?: WorkspaceConfig
): PluginDevelopmentControlContext {
	return {
		execute: async (toolName, args, abortSignal): Promise<Record<string, unknown>> => {
			assertToolName(toolName);
			switch (toolName) {
			case "mcp_plugin_dev_prepare": {
				const proposal = await preparePluginDevelopmentSnapshot(args, sessionId, workspace);
				const failed = proposal.diagnostics.some((item): boolean => item.severity === "error");
				const attempt = recordAttempt(sessionId, z.object({ slug: z.string() }).passthrough().parse(args).slug, "static", failed);
				return { ok: !failed, ...proposal, repairAttempt: attempt, repairAttemptsRemaining: Math.max(0, MAX_REPAIR_ATTEMPTS - attempt), exhausted: failed && attempt >= MAX_REPAIR_ATTEMPTS };
			}
			case "mcp_plugin_dev_apply": {
				const input = z.object({ proposalToken: z.string().length(64), expectedRevision: z.string().length(64).optional() }).strict().parse(args);
				const record = await applyPluginDevelopmentSnapshot(input.proposalToken, sessionId);
				return { ok: true, applied: true, slug: record.slug, revision: record.revision, scope: record.scope };
			}
			case "mcp_plugin_dev_validate": {
				const target = targetSchema.parse(args);
				const development = await resolveManagedDevelopmentRoot(target, workspace);
				const validation = await validatePluginDevelopmentDirectory(development.rootPath);
				const failed = validation.diagnostics.some((item): boolean => item.severity === "error");
				const attempt = recordAttempt(sessionId, target.slug, "static", failed);
				return { ok: !failed, revision: development.revision, diagnostics: validation.diagnostics, capabilitySummary: validation.capabilitySummary, repairAttempt: attempt, repairAttemptsRemaining: Math.max(0, MAX_REPAIR_ATTEMPTS - attempt), exhausted: failed && attempt >= MAX_REPAIR_ATTEMPTS };
			}
			case "mcp_plugin_dev_install": {
				const target = targetSchema.parse(args);
				const development = await resolveManagedDevelopmentRoot(target, workspace);
				const validation = await validatePluginDevelopmentDirectory(development.rootPath);
				if (validation.diagnostics.some((item): boolean => item.severity === "error") || validation.scan === undefined || validation.testPlan === undefined) throw Object.assign(new Error("Plugin must pass static validation before installation."), { code: "plugin_dev_validation_required", diagnostics: validation.diagnostics });
				const source = { type: "local" as const, path: development.rootPath };
				const current = await findInstalledDevelopmentPlugin(development.rootPath, validation.scan.packageName);
				const plugin = current === undefined
					? await installPlugin(source)
					: current.contentHash === validation.scan.contentHash
						? current
						: await updatePluginFromSource(current.id, source, current.fingerprint);
				if (plugin.trust === "trusted" && plugin.enabled) {
					return { ok: true, installed: true, reviewStatus: "trusted", plugin: publicRecord(plugin), revision: development.revision, reused: true };
				}
				const review = await pluginDevelopmentReviewRuntime.request(socket, sessionId, plugin, development.revision, validation.testPlan.cases.length, abortSignal);
				const reviewedPlugin = review.status === "trusted"
					? (await getPluginCatalog()).plugins.find((candidate): boolean => candidate.id === plugin.id) ?? plugin
					: plugin;
				return { ok: review.status === "trusted", installed: true, reviewId: review.reviewId, reviewStatus: review.status, plugin: publicRecord(reviewedPlugin), revision: development.revision };
			}
			case "mcp_plugin_dev_test": {
				const input = targetSchema.extend({ pluginId: z.string().min(1).max(240) }).strict().parse(args);
				const development = await resolveManagedDevelopmentRoot(input, workspace);
				const plugin = (await getPluginCatalog()).plugins.find((candidate): boolean => candidate.id === input.pluginId);
				if (plugin === undefined) throw Object.assign(new Error("Installed development plugin was not found."), { code: "plugin_not_found" });
				if (plugin.trust !== "trusted" || !plugin.enabled) throw Object.assign(new Error("End-to-end tests require the current plugin revision to be trusted and enabled."), { code: "plugin_dev_trust_required" });
				if (plugin.source.type !== "local" || resolve(plugin.source.path) !== resolve(development.rootPath)) throw Object.assign(new Error("Installed plugin does not match this development project."), { code: "plugin_dev_install_mismatch" });
				const plan = pluginDevelopmentTestPlanSchema.parse(JSON.parse(await readFile(resolve(development.rootPath, "tests", "daedalus.plugin-tests.json"), "utf8")));
				const result = await runPluginDevelopmentTests(plugin, development.revision, plan, abortSignal);
				const attempt = recordAttempt(sessionId, input.slug, "runtime", !result.ok);
				return { ...result, repairAttempt: attempt, repairAttemptsRemaining: Math.max(0, MAX_REPAIR_ATTEMPTS - attempt), exhausted: !result.ok && attempt >= MAX_REPAIR_ATTEMPTS };
			}
			}
		}
	};
}

export { pluginDevelopmentReviewRuntime };
export type { PluginDevelopmentScope };
