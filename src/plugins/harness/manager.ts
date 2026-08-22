import { readPluginRecords } from "../store.js";
import type { HarnessInstallation, PluginRecord, PluginRuntimeSnapshot } from "../types.js";
import type { PluginRuntimeContext } from "../runtime/worker-protocol.js";
import { addPluginRuntimeLog } from "../runtime/runtime-logs.js";
import { pluginFingerprint } from "../manager.js";
import { invalidateHarnessPluginTrust, readHarnessRuntimeConfig } from "./config-store.js";
import { detectHarnessInstallation } from "./installation.js";
import { invokeHarness, startHarnessSidecar, stopHarnessSidecar, type HarnessHandle } from "./runner.js";
import { clearPluginRegistrations } from "../runtime/registries.js";
import { createHarnessRuntimeFingerprint } from "./trust.js";
import { clearPluginQuarantine, getPluginIsolation, recordPluginFailure } from "../runtime/quarantine.js";
import { readChildRssBytes } from "../runtime/resource-usage.js";
import { terminateProcess } from "../../mcp/terminal/process-runner.js";
import { MAX_HARNESS_RSS_BYTES, PLUGIN_IDLE_TIMEOUT_MS } from "../runtime/runtime-limits.js";

const handles = new Map<string, HarnessHandle>();
const snapshots = new Map<string, PluginRuntimeSnapshot>();

function key(pluginId: string, sessionId: string): string { return `${pluginId}\0${sessionId}`; }

function setSnapshot(pluginId: string, patch: Partial<PluginRuntimeSnapshot>): void {
	const current: PluginRuntimeSnapshot = snapshots.get(pluginId) ?? {
		pluginId,
		runtimeKind: "harness",
		status: "stopped",
		activeSessions: 0,
		registeredTools: 0,
		registeredSkills: 0,
		registeredHooks: 0,
		registeredMcpServers: 0,
		dependencyStatus: "not_required",
		harnessStatus: "unconfigured",
		updatedAt: new Date().toISOString()
	};
	snapshots.set(pluginId, { ...current, ...patch, runtimeKind: "harness", updatedAt: new Date().toISOString() });
}

async function validateRecord(record: PluginRecord, sessionId?: string): Promise<void> {
	if (record.trust !== "trusted" || !record.enabled) throw new Error("Plugin is not trusted and enabled.");
	if (!record.compatibility.harnessBundle || !["harness-bundle", "both"].includes(record.compatibility.classification)) throw new Error("Plugin does not declare a runnable Harness Bundle.");
	if (record.compatibility.patchPath === undefined || !record.compatibility.patchExists) throw new Error("Harness Bundle patch is unavailable.");
	if (pluginFingerprint(record) !== record.fingerprint) throw Object.assign(new Error("Plugin fingerprint is stale. Rescan and trust the plugin again."), { code: "plugin_fingerprint_stale" });
	if (sessionId !== undefined) {
		const isolation = await getPluginIsolation(record.id, sessionId);
		if (isolation?.status === "quarantined") throw Object.assign(new Error(isolation.reason ?? "Plugin runtime is quarantined."), { code: "plugin_runtime_quarantined" });
	}
}

async function requireRecord(pluginId: string): Promise<PluginRecord> {
	const record = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
	if (record === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
	await validateRecord(record);
	return record;
}

export async function ensureHarnessRuntime(pluginId: string, context: Omit<PluginRuntimeContext, "pluginId" | "capabilities">): Promise<HarnessHandle> {
	const existing = handles.get(key(pluginId, context.sessionId));
	if (existing !== undefined) return existing;
	const record: PluginRecord = await requireRecord(pluginId);
	await validateRecord(record, context.sessionId);
	const config = await readHarnessRuntimeConfig();
	const installation: HarnessInstallation = await detectHarnessInstallation(config);
	if (installation.status !== "detected") {
		setSnapshot(pluginId, { status: "failed", harnessStatus: installation.status === "needs_setup" ? "needs_setup" : installation.status === "unconfigured" ? "unconfigured" : "failed", lastError: installation.error });
		throw Object.assign(new Error(installation.error ?? "Harness runtime is unavailable."), { code: "plugin_harness_unavailable" });
	}
	if (record.harnessRuntimeFingerprint !== createHarnessRuntimeFingerprint(record, config, installation)) {
		await invalidateHarnessPluginTrust(pluginId);
		throw Object.assign(new Error("Harness path, version, Bridge, or generated Bundle profile changed. Review and trust the plugin again."), { code: "plugin_harness_trust_stale" });
	}
	const runtimeContext: PluginRuntimeContext = { ...context, pluginId, capabilities: ["tools", "skills", "hooks", "mcp"] };
	let handle: HarnessHandle;
	try {
		handle = await startHarnessSidecar(record, runtimeContext, installation, {
		onSnapshot: (patch): void => setSnapshot(pluginId, { ...patch, activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === pluginId).length + (handles.has(key(pluginId, context.sessionId)) ? 0 : 1) }),
		onClosed: (closedHandle, error): void => {
			if (closedHandle.resourceTimer !== undefined) clearInterval(closedHandle.resourceTimer);
			if (handles.get(key(closedHandle.pluginId, closedHandle.sessionId)) !== closedHandle) return;
			handles.delete(key(closedHandle.pluginId, closedHandle.sessionId));
			if (closedHandle.idleTimer !== undefined) clearInterval(closedHandle.idleTimer);
			clearPluginRegistrations(closedHandle.pluginId);
			if (closedHandle.stopping) {
				if (closedHandle.failed) {
					void recordPluginFailure(closedHandle.pluginId, closedHandle.sessionId, error?.message ?? "Harness Sidecar failed.").then((isolation): void => setSnapshot(closedHandle.pluginId, { status: isolation.status === "quarantined" ? "quarantined" : "failed", isolation, harnessStatus: "failed", lastError: error?.message }));
					return;
				}
				setSnapshot(closedHandle.pluginId, { status: "stopped", harnessStatus: "ready", activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === closedHandle.pluginId).length });
				return;
			}
			void recordPluginFailure(closedHandle.pluginId, closedHandle.sessionId, error?.message ?? "Harness Sidecar exited.").then((isolation): void => {
				setSnapshot(closedHandle.pluginId, { status: isolation.status === "quarantined" ? "quarantined" : "failed", isolation, harnessStatus: "failed", activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === closedHandle.pluginId).length, lastError: error?.message });
			}).catch((): void => setSnapshot(closedHandle.pluginId, { status: "failed", harnessStatus: "failed", lastError: error?.message }));
		}
		});
	} catch (error: unknown) {
		const reason = error instanceof Error ? error.message : String(error);
		const isolation = await recordPluginFailure(pluginId, context.sessionId, reason).catch((): undefined => undefined);
		if (isolation !== undefined) setSnapshot(pluginId, { status: isolation.status === "quarantined" ? "quarantined" : "failed", isolation, harnessStatus: "failed", lastError: reason });
		else setSnapshot(pluginId, { status: "failed", harnessStatus: "failed", lastError: reason });
		throw error;
	}
	handle.resourceTimer = setInterval((): void => {
		void readChildRssBytes(handle.child).then((rssBytes): void => {
			if (rssBytes === undefined) return;
			setSnapshot(pluginId, { resourceUsage: { activeCalls: handle.activeCalls, pendingCalls: handle.pending.size, rssBytes, lastMeasuredAt: new Date().toISOString() } });
			if (rssBytes > MAX_HARNESS_RSS_BYTES && !handle.stopping) {
				handle.stopping = true;
				handle.failed = true;
				const error = new Error("Harness Sidecar exceeded its memory limit.");
				setSnapshot(pluginId, { status: "failed", lastError: error.message });
				terminateProcess(handle.child, true);
			}
		}).catch((): void => undefined);
	}, 2_000);
	handle.resourceTimer.unref();
	handle.idleTimer = setInterval((): void => {
		if (!handle.stopping && handle.pending.size === 0 && Date.now() - handle.lastUsedAt >= PLUGIN_IDLE_TIMEOUT_MS) {
			handle.stopping = true;
			void stopHarnessPlugin(pluginId, context.sessionId);
		}
	}, 60_000);
	handle.idleTimer.unref();
	handles.set(key(pluginId, context.sessionId), handle);
	setSnapshot(pluginId, { status: "ready", harnessStatus: "running", activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === pluginId).length });
	addPluginRuntimeLog({ pluginId, sessionId: context.sessionId, event: "ready", status: "ok", message: `Harness ${installation.version ?? "unknown"}` });
	return handle;
}

export async function invokeHarnessPlugin(pluginId: string, sessionId: string, kind: "tool" | "hook" | "mcp_tool" | "mcp_resource", name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
	const handle = handles.get(key(pluginId, sessionId));
	if (handle === undefined) throw new Error("Harness runtime is not running.");
	return await invokeHarness(handle, kind, name, args, timeoutMs);
}

export async function stopHarnessPlugin(pluginId: string, sessionId?: string, status: "stopped" | "disabled" = "stopped"): Promise<void> {
	const targets = [...handles.values()].filter((handle): boolean => handle.pluginId === pluginId && (sessionId === undefined || handle.sessionId === sessionId));
	if (targets.length === 0 && !snapshots.has(pluginId)) return;
	for (const handle of targets) {
		handles.delete(key(handle.pluginId, handle.sessionId));
		await stopHarnessSidecar(handle);
	}
	clearPluginRegistrations(pluginId);
	setSnapshot(pluginId, { status, harnessStatus: status === "disabled" ? "disabled" : "ready", activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === pluginId).length, registeredTools: 0, registeredSkills: 0, registeredHooks: 0, registeredMcpServers: 0 });
}

export async function restartHarnessPlugin(pluginId: string): Promise<void> {
	const contexts: PluginRuntimeContext[] = [...handles.values()].filter((handle): boolean => handle.pluginId === pluginId).map((handle): PluginRuntimeContext => handle.context);
	await stopHarnessPlugin(pluginId);
	for (const context of contexts) await ensureHarnessRuntime(pluginId, context);
}

export async function clearHarnessPluginQuarantine(pluginId: string, sessionId?: string): Promise<void> {
	await clearPluginQuarantine(pluginId, sessionId);
	setSnapshot(pluginId, { status: "stopped", isolation: { status: "none", failureCount: 0, updatedAt: new Date().toISOString() }, lastError: undefined });
}

export function listHarnessRuntimeSnapshots(): PluginRuntimeSnapshot[] { return [...snapshots.values()].map((value): PluginRuntimeSnapshot => structuredClone(value)); }
export function getHarnessRuntimeSnapshot(pluginId: string): PluginRuntimeSnapshot | undefined { return snapshots.get(pluginId); }
export function hasHarnessHandle(pluginId: string, sessionId: string): boolean { return handles.has(key(pluginId, sessionId)); }
export function countHarnessSessions(pluginId: string): number { return [...handles.values()].filter((handle): boolean => handle.pluginId === pluginId).length; }
export function countHarnessSessionRuntimes(sessionId: string): number { return [...handles.values()].filter((handle): boolean => handle.sessionId === sessionId).length; }
export async function stopAllHarnessRuntimes(): Promise<void> { for (const pluginId of new Set([...handles.values()].map((handle): string => handle.pluginId))) await stopHarnessPlugin(pluginId); }
