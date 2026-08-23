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
import { pluginDevelopmentTestPlanSchema, PLUGIN_DEVELOPMENT_TOOL_NAMES, type PluginDevelopmentControlContext, type PluginDevelopmentScope, type PluginDevelopmentTestResult, type PluginDevelopmentToolName } from "./types.js";
import { validatePluginDevelopmentDirectory } from "./validation.js";
import { getPluginDevelopmentStatus, updatePluginDevelopmentStatus } from "./status-store.js";
import { createPluginDiagnostic } from "./diagnostics.js";
import { recordPluginDevelopmentRun } from "../maintenance/diagnostic-history.js";

const targetSchema = z.object({
	slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
	scope: z.enum(["workspace", "personal"]),
	sourceFolderId: z.string().min(1).max(128).optional()
}).strict();

const MAX_REPAIR_ATTEMPTS: number = 3;
const repairAttempts = new Map<string, { revision: string; static: number; runtime: number }>();

function attemptKey(sessionId: string, slug: string): string {
	return `${sessionId}\0${slug}`;
}

function recordAttempt(sessionId: string, slug: string, revision: string, kind: "static" | "runtime", failed: boolean, persistedAttempt = 0): number {
	const key = attemptKey(sessionId, slug);
	const existing = repairAttempts.get(key);
	const current = existing?.revision === revision ? existing : { revision, static: kind === "static" ? persistedAttempt : 0, runtime: kind === "runtime" ? persistedAttempt : 0 };
	if (!failed) current[kind] = 0;
	else current[kind] += 1;
	repairAttempts.set(key, current);
	return current[kind];
}

async function assertRepairBudget(slug: string, revision: string, kind: "static" | "runtime"): Promise<void> {
	const status = await getPluginDevelopmentStatus(slug);
	if (status?.revision === revision && ((kind === "static" && status.staticAttempt >= MAX_REPAIR_ATTEMPTS) || (kind === "runtime" && status.runtimeAttempt >= MAX_REPAIR_ATTEMPTS))) {
		throw Object.assign(new Error(`Plugin development ${kind} repair budget is exhausted for revision ${revision}. Generate a new revision to continue.`), { code: "plugin_dev_repair_exhausted" });
	}
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

async function developmentStatusFields(slug: string): Promise<Record<string, unknown>> {
	const status = await getPluginDevelopmentStatus(slug);
	return status === null ? {} : {
		phase: status.phase,
		staticAttempt: status.staticAttempt,
		runtimeAttempt: status.runtimeAttempt,
		staticAttemptsRemaining: status.staticAttemptsRemaining,
		runtimeAttemptsRemaining: status.runtimeAttemptsRemaining
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
				const slug = z.object({ slug: z.string() }).passthrough().parse(args).slug;
				await assertRepairBudget(slug, proposal.proposedRevision, "static");
				const previous = await getPluginDevelopmentStatus(slug);
				const attempt = failed
					? recordAttempt(sessionId, slug, proposal.proposedRevision, "static", true, previous?.revision === proposal.proposedRevision ? previous.staticAttempt : 0)
					: (previous?.revision === proposal.proposedRevision ? previous.staticAttempt : 0);
				// A valid proposal is counted only when validate reports a failure;
				// an invalid proposal is counted here because apply must reject it.
				const phase = failed && attempt >= MAX_REPAIR_ATTEMPTS ? "exhausted" : failed ? "failed" : "preparing";
				await updatePluginDevelopmentStatus(slug, { revision: proposal.proposedRevision, phase, staticAttempt: attempt, runtimeAttempt: 0, lastDiagnostics: proposal.diagnostics });
				return { ok: !failed, ...proposal, phase, repairAttempt: attempt, repairAttemptsRemaining: Math.max(0, MAX_REPAIR_ATTEMPTS - attempt), exhausted: phase === "exhausted", ...await developmentStatusFields(slug) };
			}
			case "mcp_plugin_dev_apply": {
				const input = z.object({ proposalToken: z.string().length(64), expectedRevision: z.string().length(64).optional() }).strict().parse(args);
				const record = await applyPluginDevelopmentSnapshot(input.proposalToken, sessionId);
				await updatePluginDevelopmentStatus(record.slug, { revision: record.revision, phase: "validating", lastDiagnostics: [] });
				return { ok: true, applied: true, slug: record.slug, revision: record.revision, scope: record.scope, ...await developmentStatusFields(record.slug) };
			}
			case "mcp_plugin_dev_validate": {
				const target = targetSchema.parse(args);
				const development = await resolveManagedDevelopmentRoot(target, workspace);
				await assertRepairBudget(target.slug, development.revision, "static");
				const persistedStatus = await getPluginDevelopmentStatus(target.slug);
				const validation = await validatePluginDevelopmentDirectory(development.rootPath);
				const failed = validation.diagnostics.some((item): boolean => item.severity === "error");
				const attempt = recordAttempt(sessionId, target.slug, development.revision, "static", failed, persistedStatus?.revision === development.revision ? persistedStatus.staticAttempt : 0);
				const phase = failed ? (attempt >= MAX_REPAIR_ATTEMPTS ? "exhausted" : "failed") : "awaiting_install";
				await updatePluginDevelopmentStatus(target.slug, { revision: development.revision, phase, staticAttempt: attempt, lastDiagnostics: validation.diagnostics });
				return { ok: !failed, revision: development.revision, phase, diagnostics: validation.diagnostics, capabilitySummary: validation.capabilitySummary, repairAttempt: attempt, repairAttemptsRemaining: Math.max(0, MAX_REPAIR_ATTEMPTS - attempt), exhausted: failed && attempt >= MAX_REPAIR_ATTEMPTS, ...await developmentStatusFields(target.slug) };
			}
			case "mcp_plugin_dev_install": {
				const target = targetSchema.parse(args);
				const development = await resolveManagedDevelopmentRoot(target, workspace);
				const validation = await validatePluginDevelopmentDirectory(development.rootPath);
				if (validation.diagnostics.some((item): boolean => item.severity === "error") || validation.scan === undefined || validation.testPlan === undefined) throw Object.assign(new Error("Plugin must pass static validation before installation."), { code: "plugin_dev_validation_required", diagnostics: validation.diagnostics });
				await updatePluginDevelopmentStatus(target.slug, { revision: development.revision, phase: "awaiting_trust", lastDiagnostics: [] });
				const source = { type: "local" as const, path: development.rootPath };
				const current = await findInstalledDevelopmentPlugin(development.rootPath, validation.scan.packageName);
				const plugin = current === undefined
					? await installPlugin(source)
					: current.contentHash === validation.scan.contentHash
						? current
						: await updatePluginFromSource(current.id, source, current.fingerprint);
				if (plugin.trust === "trusted" && plugin.enabled) {
					await updatePluginDevelopmentStatus(target.slug, { revision: development.revision, phase: "testing" });
					return { ok: true, installed: true, reviewStatus: "trusted", plugin: publicRecord(plugin), revision: development.revision, reused: true, ...await developmentStatusFields(target.slug) };
				}
				const review = await pluginDevelopmentReviewRuntime.request(socket, sessionId, plugin, development.revision, validation.testPlan.cases.length, abortSignal);
				const reviewedPlugin = review.status === "trusted"
					? (await getPluginCatalog()).plugins.find((candidate): boolean => candidate.id === plugin.id) ?? plugin
					: plugin;
				await updatePluginDevelopmentStatus(target.slug, { revision: development.revision, phase: review.status === "trusted" ? "testing" : "awaiting_trust" });
				return { ok: review.status === "trusted", installed: true, reviewId: review.reviewId, reviewStatus: review.status, plugin: publicRecord(reviewedPlugin), revision: development.revision, ...await developmentStatusFields(target.slug) };
			}
			case "mcp_plugin_dev_test": {
				const input = targetSchema.extend({ pluginId: z.string().min(1).max(240) }).strict().parse(args);
				const development = await resolveManagedDevelopmentRoot(input, workspace);
				const plugin = (await getPluginCatalog()).plugins.find((candidate): boolean => candidate.id === input.pluginId);
				if (plugin === undefined) throw Object.assign(new Error("Installed development plugin was not found."), { code: "plugin_not_found" });
				if (plugin.trust !== "trusted" || !plugin.enabled) throw Object.assign(new Error("End-to-end tests require the current plugin revision to be trusted and enabled."), { code: "plugin_dev_trust_required" });
				if (plugin.source.type !== "local" || resolve(plugin.source.path) !== resolve(development.rootPath)) throw Object.assign(new Error("Installed plugin does not match this development project."), { code: "plugin_dev_install_mismatch" });
				await assertRepairBudget(input.slug, development.revision, "runtime");
				await updatePluginDevelopmentStatus(input.slug, { revision: development.revision, phase: "testing", lastDiagnostics: [] });
				const plan = pluginDevelopmentTestPlanSchema.parse(JSON.parse(await readFile(resolve(development.rootPath, "tests", "daedalus.plugin-tests.json"), "utf8")));
				let result;
				try {
					result = await runPluginDevelopmentTests(plugin, development.revision, plan, abortSignal);
				} catch (error: unknown) {
					const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "plugin_test_failed";
					const retryable = abortSignal?.aborted !== true && !["sandbox_unavailable", "plugin_runtime_quarantined"].includes(code);
					const diagnostic = createPluginDiagnostic({ code, message: error instanceof Error ? error.message : String(error), stage: "test", retryable });
					const persistedStatus = await getPluginDevelopmentStatus(input.slug);
					const attempt = recordAttempt(sessionId, input.slug, development.revision, "runtime", retryable, persistedStatus?.revision === development.revision ? persistedStatus.runtimeAttempt : 0);
					const failedResult: PluginDevelopmentTestResult = { runId: `plugin-test-failed-${Date.now().toString(36)}`, ok: false, pluginId: input.pluginId, revision: development.revision, durationMs: 0, sandbox: { available: false, mode: "unavailable", network: "disabled", workspaceDisplay: "[isolated-test-workspace]" }, passed: 0, failed: 0, cases: [], diagnostics: [diagnostic] };
					await recordPluginDevelopmentRun({ pluginId: input.pluginId, revision: development.revision, trigger: "creator", result: failedResult });
					await updatePluginDevelopmentStatus(input.slug, { revision: development.revision, phase: abortSignal?.aborted ? "cancelled" : attempt >= MAX_REPAIR_ATTEMPTS ? "exhausted" : "failed", runtimeAttempt: attempt, lastDiagnostics: [diagnostic] });
					throw error;
				}
				const cancelled = abortSignal?.aborted === true || result.diagnostics.some((diagnostic): boolean => diagnostic.code === "plugin_dev_test_cancelled");
				const persistedStatus = await getPluginDevelopmentStatus(input.slug);
				const retryableFailure = !result.ok && !cancelled && result.diagnostics.some((diagnostic): boolean => diagnostic.retryable);
				const attempt = recordAttempt(sessionId, input.slug, development.revision, "runtime", retryableFailure, persistedStatus?.revision === development.revision ? persistedStatus.runtimeAttempt : 0);
				const phase = cancelled ? "cancelled" : result.ok ? "passed" : (retryableFailure && attempt >= MAX_REPAIR_ATTEMPTS ? "exhausted" : "failed");
				await recordPluginDevelopmentRun({ pluginId: input.pluginId, revision: development.revision, trigger: "creator", result });
				await updatePluginDevelopmentStatus(input.slug, { revision: development.revision, phase, runtimeAttempt: attempt, lastDiagnostics: result.diagnostics, lastTest: result });
				return { ...result, phase, repairAttempt: attempt, repairAttemptsRemaining: Math.max(0, MAX_REPAIR_ATTEMPTS - attempt), exhausted: !result.ok && attempt >= MAX_REPAIR_ATTEMPTS, ...await developmentStatusFields(input.slug) };
			}
			}
		}
	};
}

export { pluginDevelopmentReviewRuntime };
export type { PluginDevelopmentScope };
