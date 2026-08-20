import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDaedalusPath } from "../../app-paths.js";
import { createSandboxInvocation } from "../../mcp/terminal/sandbox-runner.js";
import { getPluginCatalog, pluginFingerprint } from "../manager.js";
import { readPluginRecords } from "../store.js";
import type { PluginRecord, PluginRuntimeSnapshot } from "../types.js";
import {
	clearPluginRegistrations,
	registerPluginHook,
	registerPluginMcp,
	registerPluginSkill,
	registerPluginTool
} from "./registries.js";
import {
	PLUGIN_CALL_TIMEOUT_MS,
	MAX_PLUGIN_HOOKS,
	MAX_PLUGIN_MCP_SERVERS,
	MAX_PLUGIN_MESSAGE_BYTES,
	MAX_PLUGIN_RESULT_CHARS,
	MAX_PLUGIN_SKILLS,
	MAX_PLUGIN_TOOLS,
	PLUGIN_START_TIMEOUT_MS
} from "./runtime-limits.js";
import { addPluginRuntimeLog } from "./runtime-logs.js";
import { installPluginDependencies } from "./dependency-installer.js";
import {
	encodeWorkerMessage,
	parseWorkerEvent,
	PLUGIN_RUNTIME_PROTOCOL_VERSION,
	type PluginRuntimeContext,
	type PluginWorkerEvent,
	type PluginWorkerMessage
} from "./worker-protocol.js";

type PendingCall = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type WorkerHandle = {
	pluginId: string;
	sessionId: string;
	child: ChildProcessWithoutNullStreams;
	pending: Map<string, PendingCall>;
	ready: Promise<void>;
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	buffer: string;
	registrationCounts: { tools: number; skills: number; hooks: number; mcps: number };
	context: PluginRuntimeContext;
};

const handles = new Map<string, WorkerHandle>();
const snapshots = new Map<string, PluginRuntimeSnapshot>();

function key(pluginId: string, sessionId: string): string { return `${pluginId}\0${sessionId}`; }

function redactRuntimeText(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
		.replace(/(api[_-]?key|authorization|cookie|password|secret|token)(\s*[:=]\s*)([^\s,;]+)/giu, "$1$2[redacted]")
		.slice(-2000);
}

function setSnapshot(pluginId: string, patch: Partial<PluginRuntimeSnapshot>): void {
	const current: PluginRuntimeSnapshot = snapshots.get(pluginId) ?? {
		pluginId, status: "stopped", activeSessions: 0, registeredTools: 0, registeredSkills: 0,
		registeredHooks: 0, registeredMcpServers: 0, dependencyStatus: "not_required", updatedAt: new Date().toISOString()
	};
	snapshots.set(pluginId, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

function rejectPending(handle: WorkerHandle, error: Error): void {
	for (const [id, pending] of handle.pending) {
		clearTimeout(pending.timer);
		pending.reject(error);
		handle.pending.delete(id);
	}
}

function validateRecord(record: PluginRecord): void {
	if (record.trust !== "trusted" || !record.enabled) throw new Error("Plugin is not trusted and enabled.");
	if (record.nativePlugin === undefined) throw new Error("Plugin does not declare a Daedalus native runtime.");
	if (record.compatibility.classification === "unsupported") throw new Error("Plugin compatibility is unsupported.");
	if (pluginFingerprint(record) !== record.fingerprint) throw new Error("Plugin fingerprint is stale. Rescan and trust the plugin again.");
}

function handleEvent(handle: WorkerHandle, event: PluginWorkerEvent): void {
	if (event.type === "ready") { handle.resolveReady(); return; }
	if (event.type === "error") { handle.rejectReady(new Error(event.message)); return; }
	if (event.type === "result") {
		const pending = handle.pending.get(event.id);
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		handle.pending.delete(event.id);
		if (event.ok) {
			let size = 0;
			try { size = Buffer.byteLength(JSON.stringify(event.value) ?? "null", "utf8"); } catch { size = MAX_PLUGIN_RESULT_CHARS + 1; }
			if (size > MAX_PLUGIN_RESULT_CHARS) pending.reject(new Error("Plugin result exceeded the size limit."));
			else pending.resolve(event.value);
		}
		else pending.reject(new Error(event.error ?? "Plugin call failed."));
		return;
	}
	if (event.type === "register.tool") {
		if (!handle.context.capabilities.includes("tools")) throw new Error("Plugin registered a capability that was not declared.");
		if (++handle.registrationCounts.tools > MAX_PLUGIN_TOOLS) throw new Error("Plugin tool registration limit exceeded.");
		registerPluginTool(handle.pluginId, event.registration);
		setSnapshot(handle.pluginId, { registeredTools: handle.registrationCounts.tools });
		return;
	}
	if (event.type === "register.skill") {
		if (!handle.context.capabilities.includes("skills")) throw new Error("Plugin registered a capability that was not declared.");
		if (++handle.registrationCounts.skills > MAX_PLUGIN_SKILLS) throw new Error("Plugin skill registration limit exceeded.");
		if (event.registration.body.length > 200_000 || event.registration.allowedTools.length > 64) throw new Error("Plugin skill registration exceeds the size limit.");
		registerPluginSkill(handle.pluginId, event.registration);
		setSnapshot(handle.pluginId, { registeredSkills: handle.registrationCounts.skills });
		return;
	}
	if (event.type === "register.hook") {
		if (!handle.context.capabilities.includes("hooks")) throw new Error("Plugin registered a capability that was not declared.");
		if (++handle.registrationCounts.hooks > MAX_PLUGIN_HOOKS) throw new Error("Plugin hook registration limit exceeded.");
		if (event.registration.event.length > 64 || event.registration.matcher !== undefined && event.registration.matcher.length > 512) throw new Error("Plugin hook registration exceeds the size limit.");
		registerPluginHook(handle.pluginId, event.registration, event.registration.handlerName ?? "");
		setSnapshot(handle.pluginId, { registeredHooks: handle.registrationCounts.hooks });
		return;
	}
	if (event.type === "register.mcp") {
		if (!handle.context.capabilities.includes("mcp")) throw new Error("Plugin registered a capability that was not declared.");
		if (++handle.registrationCounts.mcps > MAX_PLUGIN_MCP_SERVERS) throw new Error("Plugin MCP registration limit exceeded.");
		if (event.registration.tools.length > MAX_PLUGIN_TOOLS || event.registration.resources.length > 64) throw new Error("Plugin MCP registration exceeds the size limit.");
		registerPluginMcp(handle.pluginId, event.registration);
		setSnapshot(handle.pluginId, { registeredMcpServers: handle.registrationCounts.mcps });
	}
}

async function startWorker(record: PluginRecord, context: PluginRuntimeContext): Promise<WorkerHandle> {
	const runtimeRoot = join(getDaedalusPath("plugins.runtime"), record.id.replace(/[^a-zA-Z0-9._-]/gu, "_"), context.sessionId.replace(/[^a-zA-Z0-9._-]/gu, "_"));
	await mkdir(runtimeRoot, { recursive: true });
	const entry = join(record.packageRoot, record.nativePlugin!.entry);
	const bootstrapJs = fileURLToPath(new URL("./worker-bootstrap.js", import.meta.url));
	const bootstrapTs = fileURLToPath(new URL("./worker-bootstrap.ts", import.meta.url));
	const backendRoot = fileURLToPath(new URL("../../../", import.meta.url));
	const useSourceBootstrap: boolean = !existsSync(bootstrapJs);
	const bootstrapArgs: string[] = useSourceBootstrap
		? ["--import", join(backendRoot, "node_modules", "tsx", "dist", "loader.mjs"), bootstrapTs, "--plugin-worker"]
		: [bootstrapJs, "--plugin-worker"];
	const sandbox = createSandboxInvocation({
		command: { kind: "argv", command: process.execPath, args: bootstrapArgs },
		cwd: context.workspaceRoot ?? runtimeRoot,
		workspaceRoot: context.workspaceRoot ?? runtimeRoot,
		readOnlyPaths: [record.packageRoot, ...(useSourceBootstrap ? [backendRoot] : [])],
		env: { DAEDALUS_PLUGIN_ID: record.id },
		network: false
	});
	if (!sandbox.available) throw new Error(sandbox.error);
	const child = spawn(sandbox.command, sandbox.args, { cwd: runtimeRoot, env: sandbox.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject): void => { resolveReady = resolve; rejectReady = reject; });
	const handle: WorkerHandle = { pluginId: record.id, sessionId: context.sessionId, child, pending: new Map(), ready, resolveReady, rejectReady, buffer: "", registrationCounts: { tools: 0, skills: 0, hooks: 0, mcps: 0 }, context };
	handles.set(key(record.id, context.sessionId), handle);
	setSnapshot(record.id, { status: "starting", activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === record.id).length });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string): void => {
		handle.buffer += chunk;
		if (Buffer.byteLength(handle.buffer, "utf8") > MAX_PLUGIN_MESSAGE_BYTES) { void stopPlugin(record.id, context.sessionId); rejectReady(new Error("Plugin worker output exceeded the limit.")); return; }
		let index: number;
		while ((index = handle.buffer.indexOf("\n")) >= 0) {
			const line = handle.buffer.slice(0, index); handle.buffer = handle.buffer.slice(index + 1);
			try { handleEvent(handle, parseWorkerEvent(line)); }
			catch (error: unknown) { rejectPending(handle, error instanceof Error ? error : new Error(String(error))); rejectReady(error instanceof Error ? error : new Error(String(error))); }
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string): void => {
		addPluginRuntimeLog({ pluginId: record.id, sessionId: context.sessionId, event: "error", status: "failed", message: redactRuntimeText(String(chunk)) });
	});
	child.once("error", (error: Error): void => { rejectReady(error); rejectPending(handle, error); });
	child.once("close", (): void => {
		const error = new Error("Plugin worker exited.");
		rejectReady(error);
		rejectPending(handle, error);
		const wasActive: boolean = handles.get(key(record.id, context.sessionId)) === handle;
		if (wasActive) {
			handles.delete(key(record.id, context.sessionId));
			setSnapshot(record.id, { status: "failed", activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === record.id).length, lastError: error.message });
		}
	});
	const message: PluginWorkerMessage = { type: "initialize", protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION, entry, context };
	child.stdin.write(encodeWorkerMessage(message));
	await Promise.race([ready, new Promise<void>((_resolve, reject): void => { setTimeout((): void => reject(new Error("Plugin worker startup timed out.")), PLUGIN_START_TIMEOUT_MS); })]);
	setSnapshot(record.id, { status: "ready" });
	addPluginRuntimeLog({ pluginId: record.id, sessionId: context.sessionId, event: "ready", status: "ok" });
	return handle;
}

export async function ensurePluginRuntime(pluginId: string, context: Omit<PluginRuntimeContext, "pluginId" | "capabilities">): Promise<WorkerHandle> {
	const record = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
	if (record === undefined) throw new Error("Plugin not found.");
	validateRecord(record);
	const dependency = await installPluginDependencies(record, false);
	setSnapshot(pluginId, { dependencyStatus: dependency.status });
	if (dependency.status === "needs_network") throw Object.assign(new Error("Plugin dependencies require explicit network approval."), { code: "plugin_dependencies_need_network" });
	if (dependency.status === "failed") throw new Error(dependency.result?.stderr || "Plugin dependency installation failed.");
	const existing = handles.get(key(pluginId, context.sessionId));
	if (existing !== undefined) return existing;
	return startWorker(record, { ...context, pluginId, capabilities: record.nativePlugin!.capabilities });
}

export async function installPluginRuntimeDependencies(pluginId: string, allowNetwork: boolean): Promise<PluginRuntimeSnapshot> {
	const record = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
	if (record === undefined) throw new Error("Plugin not found.");
	validateRecord(record);
	const dependency = await installPluginDependencies(record, allowNetwork);
	setSnapshot(pluginId, { dependencyStatus: dependency.status, lastError: dependency.status === "failed" ? dependency.result?.stderr : undefined });
	addPluginRuntimeLog({ pluginId, event: "dependency", status: dependency.status === "ready" || dependency.status === "not_required" ? "ok" : "failed", message: dependency.result?.stderr?.slice(-2000) });
	if (dependency.status === "needs_network") throw Object.assign(new Error("Plugin dependencies require explicit network approval."), { code: "plugin_dependencies_need_network" });
	if (dependency.status === "failed") throw new Error(dependency.result?.stderr || "Plugin dependency installation failed.");
	return getPluginRuntimeSnapshot(pluginId)!;
}

export async function invokePlugin(pluginId: string, sessionId: string, kind: "tool" | "hook" | "mcp_tool" | "mcp_resource", name: string, args: Record<string, unknown>, timeoutMs: number = PLUGIN_CALL_TIMEOUT_MS): Promise<unknown> {
	const handle = handles.get(key(pluginId, sessionId));
	if (handle === undefined) throw new Error("Plugin runtime is not running.");
	const id = randomUUID();
	return new Promise((resolve, reject): void => {
		const timer = setTimeout((): void => { handle.pending.delete(id); reject(new Error("Plugin call timed out.")); }, Math.min(PLUGIN_CALL_TIMEOUT_MS, timeoutMs));
		handle.pending.set(id, { resolve, reject, timer });
		handle.child.stdin.write(encodeWorkerMessage({ type: "invoke", id, kind, name, args }));
	});
}

export async function stopPlugin(pluginId: string, sessionId?: string, status: "stopped" | "disabled" = "stopped"): Promise<void> {
	const targets = [...handles.values()].filter((handle): boolean => handle.pluginId === pluginId && (sessionId === undefined || handle.sessionId === sessionId));
	for (const handle of targets) {
		handle.child.stdin.write(encodeWorkerMessage({ type: "shutdown" }));
		handle.child.kill();
		rejectPending(handle, new Error("Plugin runtime stopped."));
		handles.delete(key(handle.pluginId, handle.sessionId));
	}
	clearPluginRegistrations(pluginId);
	setSnapshot(pluginId, { status, activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === pluginId).length });
	await rm(join(getDaedalusPath("plugins.runtime"), pluginId.replace(/[^a-zA-Z0-9._-]/gu, "_")), { recursive: true, force: true }).catch((): void => undefined);
}

export async function restartPlugin(pluginId: string): Promise<void> {
	const contexts: PluginRuntimeContext[] = [...handles.values()].filter((handle): boolean => handle.pluginId === pluginId).map((handle): PluginRuntimeContext => handle.context);
	await stopPlugin(pluginId);
	for (const context of contexts) {
		try { await ensurePluginRuntime(pluginId, context); }
		catch (error: unknown) { setSnapshot(pluginId, { status: "failed", lastError: error instanceof Error ? error.message : String(error) }); }
	}
}

export function listPluginRuntimeSnapshots(): PluginRuntimeSnapshot[] { return [...snapshots.values()].map((snapshot): PluginRuntimeSnapshot => structuredClone(snapshot)); }

export function getPluginRuntimeSnapshot(pluginId: string): PluginRuntimeSnapshot | undefined { return snapshots.get(pluginId); }

export async function stopAllPluginRuntimes(): Promise<void> { for (const pluginId of new Set([...handles.values()].map((handle): string => handle.pluginId))) await stopPlugin(pluginId); }

export async function ensureSessionPluginRuntimes(context: { sessionId: string; workspaceId?: string | undefined; workspaceRoot?: string | undefined }): Promise<void> {
	const catalog = await getPluginCatalog();
	for (const plugin of catalog.plugins.filter((candidate): boolean => candidate.enabled && candidate.nativePlugin !== undefined)) {
		try {
			await ensurePluginRuntime(plugin.id, context);
		} catch (error: unknown) {
			setSnapshot(plugin.id, { status: "failed", lastError: error instanceof Error ? error.message : String(error) });
			addPluginRuntimeLog({ pluginId: plugin.id, sessionId: context.sessionId, event: "error", status: "failed", message: error instanceof Error ? error.message : String(error) });
		}
	}
}
