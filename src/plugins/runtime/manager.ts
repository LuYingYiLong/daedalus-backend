import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDaedalusPath } from "../../app-paths.js";
import { createSandboxInvocation } from "../../mcp/terminal/sandbox-runner.js";
import { terminateProcess } from "../../mcp/terminal/process-runner.js";
import { materializeRuntimeAsset } from "../../runtime/runtime-assets.js";
import { getPluginCatalog, pluginFingerprint } from "../manager.js";
import { readPluginRecords } from "../store.js";
import type { PluginRecord, PluginRuntimeSnapshot } from "../types.js";
import {
	ensureHarnessRuntime,
	clearHarnessPluginQuarantine,
	getHarnessRuntimeSnapshot,
	hasHarnessHandle,
	invokeHarnessPlugin,
	listHarnessRuntimeSnapshots,
	countHarnessSessionRuntimes,
	restartHarnessPlugin,
	stopAllHarnessRuntimes,
	stopHarnessPlugin
} from "../harness/manager.js";
import type { HarnessHandle } from "../harness/runner.js";
import {
	clearPluginRegistrations,
	registerPluginCommand,
	registerPluginContextProvider,
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
	PLUGIN_START_TIMEOUT_MS,
	MAX_PLUGIN_ACTIVE_CALLS,
	MAX_PLUGIN_PENDING_CALLS,
	MAX_PLUGIN_SESSIONS,
	MAX_PLUGIN_RSS_BYTES,
	PLUGIN_IDLE_TIMEOUT_MS
} from "./runtime-limits.js";
import {
	clearPluginQuarantine,
	getPluginIsolation,
	listPluginQuarantines,
	recordPluginFailure
} from "./quarantine.js";
import { addPluginRuntimeLog } from "./runtime-logs.js";
import { installPluginDependencies } from "./dependency-installer.js";
import { readChildRssBytes } from "./resource-usage.js";
import { stopAllPluginLanguageServices, stopPluginLanguageServicesForPlugin } from "../p2/language-service.js";
import {
	encodeWorkerMessage,
	parseWorkerEvent,
	PLUGIN_RUNTIME_PROTOCOL_VERSION,
	type PluginRuntimeContext,
	type PluginWorkerEvent,
	type PluginWorkerMessage,
	type PluginToolRegistration,
	type PluginSkillRegistration,
	type PluginHookRegistration,
	type PluginMcpRegistration,
	type PluginCommandRegistration,
	type PluginContextProviderRegistration
} from "./worker-protocol.js";

type PendingCall = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; started: boolean; startedAt: number; kind: "tool" | "hook" | "mcp_tool" | "mcp_resource" | "command" | "context_provider"; name: string; args: Record<string, unknown> };
type StagedRegistrations = { tools: PluginToolRegistration[]; skills: PluginSkillRegistration[]; hooks: Array<{ registration: PluginHookRegistration; handlerName: string }>; mcps: PluginMcpRegistration[]; commands: PluginCommandRegistration[]; contextProviders: PluginContextProviderRegistration[] };

export type WorkerHandle = {
	pluginId: string;
	sessionId: string;
	child: ChildProcessWithoutNullStreams;
	pending: Map<string, PendingCall>;
	ready: Promise<void>;
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	buffer: string;
	stderrTail: string;
	registrationCounts: { tools: number; skills: number; hooks: number; mcps: number; commands: number; contextProviders: number };
	context: PluginRuntimeContext;
	activeCalls: number;
	lastUsedAt: number;
	stopping: boolean;
	failed: boolean;
	idleTimer?: NodeJS.Timeout | undefined;
	resourceTimer?: NodeJS.Timeout | undefined;
	stagedRegistrations: StagedRegistrations;
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

function updateResourceSnapshot(handle: WorkerHandle): void {
	setSnapshot(handle.pluginId, { resourceUsage: { activeCalls: handle.activeCalls, pendingCalls: handle.pending.size, lastMeasuredAt: new Date().toISOString() } });
}

function commitWorkerRegistrations(handle: WorkerHandle): void {
	try {
		clearPluginRegistrations(handle.pluginId);
		for (const registration of handle.stagedRegistrations.tools) registerPluginTool(handle.pluginId, registration);
		for (const registration of handle.stagedRegistrations.skills) registerPluginSkill(handle.pluginId, registration);
		for (const { registration, handlerName } of handle.stagedRegistrations.hooks) registerPluginHook(handle.pluginId, registration, handlerName);
		for (const registration of handle.stagedRegistrations.mcps) registerPluginMcp(handle.pluginId, registration);
		for (const registration of handle.stagedRegistrations.commands) registerPluginCommand(handle.pluginId, registration);
		for (const registration of handle.stagedRegistrations.contextProviders) registerPluginContextProvider(handle.pluginId, registration);
	} catch (error: unknown) {
		clearPluginRegistrations(handle.pluginId);
		throw error;
	}
}

function dispatchQueued(handle: WorkerHandle): void {
	for (const [id, pending] of handle.pending) {
		if (handle.activeCalls >= MAX_PLUGIN_ACTIVE_CALLS) break;
		if (pending.started) continue;
		pending.started = true;
		handle.activeCalls += 1;
		try {
			handle.child.stdin.write(encodeWorkerMessage({ type: "invoke", id, kind: pending.kind, name: pending.name, args: pending.args }));
		} catch (error: unknown) {
			clearTimeout(pending.timer);
			handle.pending.delete(id);
			handle.activeCalls = Math.max(0, handle.activeCalls - 1);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}
	updateResourceSnapshot(handle);
}

function rejectPending(handle: WorkerHandle, error: Error): void {
	for (const [id, pending] of handle.pending) {
		clearTimeout(pending.timer);
		pending.reject(error);
		handle.pending.delete(id);
	}
	handle.activeCalls = 0;
	updateResourceSnapshot(handle);
}

async function validateRecord(record: PluginRecord, sessionId?: string): Promise<void> {
	if (record.trust !== "trusted" || !record.enabled) throw new Error("Plugin is not trusted and enabled.");
	if (record.nativePlugin === undefined) throw new Error("Plugin does not declare a Daedalus native runtime.");
	if (record.compatibility.classification === "unsupported") throw new Error("Plugin compatibility is unsupported.");
	if (pluginFingerprint(record) !== record.fingerprint) throw new Error("Plugin fingerprint is stale. Rescan and trust the plugin again.");
	if (sessionId !== undefined) {
		const isolation = await getPluginIsolation(record.id, sessionId);
		if (isolation?.status === "quarantined") throw Object.assign(new Error(isolation.reason ?? "Plugin runtime is quarantined."), { code: "plugin_runtime_quarantined" });
	}
}

function handleEvent(handle: WorkerHandle, event: PluginWorkerEvent): void {
	if (event.type === "ready") { commitWorkerRegistrations(handle); handle.resolveReady(); return; }
	if (event.type === "error") { handle.rejectReady(new Error(event.message)); return; }
	if (event.type === "result") {
		const pending = handle.pending.get(event.id);
		if (pending === undefined) throw new Error("Plugin worker returned an unknown response ID.");
		clearTimeout(pending.timer);
		handle.pending.delete(event.id);
		if (pending.started) handle.activeCalls = Math.max(0, handle.activeCalls - 1);
		if (event.ok) {
			let size = 0;
			try { size = Buffer.byteLength(JSON.stringify(event.value) ?? "null", "utf8"); } catch { size = MAX_PLUGIN_RESULT_CHARS + 1; }
			if (size > MAX_PLUGIN_RESULT_CHARS) pending.reject(new Error("Plugin result exceeded the size limit."));
			else pending.resolve(event.value);
		}
		else pending.reject(new Error(event.error ?? "Plugin call failed."));
		addPluginRuntimeLog({ pluginId: handle.pluginId, sessionId: handle.sessionId, event: "invoke", status: event.ok ? "ok" : "failed", durationMs: Date.now() - pending.startedAt, message: event.ok ? undefined : event.error });
		dispatchQueued(handle);
		return;
	}
	if (event.type === "register.tool") {
		if (!handle.context.capabilities.includes("tools")) throw new Error("Plugin registered a capability that was not declared.");
		if (++handle.registrationCounts.tools > MAX_PLUGIN_TOOLS) throw new Error("Plugin tool registration limit exceeded.");
		handle.stagedRegistrations.tools.push(event.registration);
		setSnapshot(handle.pluginId, { registeredTools: handle.registrationCounts.tools });
		return;
	}
	if (event.type === "register.skill") {
		if (!handle.context.capabilities.includes("skills")) throw new Error("Plugin registered a capability that was not declared.");
		if (++handle.registrationCounts.skills > MAX_PLUGIN_SKILLS) throw new Error("Plugin skill registration limit exceeded.");
		if (event.registration.body.length > 200_000 || event.registration.allowedTools.length > 64) throw new Error("Plugin skill registration exceeds the size limit.");
		handle.stagedRegistrations.skills.push(event.registration);
		setSnapshot(handle.pluginId, { registeredSkills: handle.registrationCounts.skills });
		return;
	}
	if (event.type === "register.hook") {
		if (!handle.context.capabilities.includes("hooks")) throw new Error("Plugin registered a capability that was not declared.");
		if (++handle.registrationCounts.hooks > MAX_PLUGIN_HOOKS) throw new Error("Plugin hook registration limit exceeded.");
		if (event.registration.event.length > 64 || event.registration.matcher !== undefined && event.registration.matcher.length > 512) throw new Error("Plugin hook registration exceeds the size limit.");
		handle.stagedRegistrations.hooks.push({ registration: event.registration, handlerName: event.registration.handlerName ?? "" });
		setSnapshot(handle.pluginId, { registeredHooks: handle.registrationCounts.hooks });
		return;
	}
	if (event.type === "register.mcp") {
		if (!handle.context.capabilities.includes("mcp")) throw new Error("Plugin registered a capability that was not declared.");
		if (++handle.registrationCounts.mcps > MAX_PLUGIN_MCP_SERVERS) throw new Error("Plugin MCP registration limit exceeded.");
		if (event.registration.tools.length > MAX_PLUGIN_TOOLS || event.registration.resources.length > 64) throw new Error("Plugin MCP registration exceeds the size limit.");
		handle.stagedRegistrations.mcps.push(event.registration);
		setSnapshot(handle.pluginId, { registeredMcpServers: handle.registrationCounts.mcps });
		return;
	}
	if (event.type === "register.command") {
		if (!(handle.context.p2Capabilities ?? []).includes("commands")) throw new Error("Plugin registered an undeclared P2 command capability.");
		if (++handle.registrationCounts.commands > 128) throw new Error("Plugin command registration limit exceeded.");
		handle.stagedRegistrations.commands.push(event.registration);
		return;
	}
	if (event.type === "register.context-provider") {
		if (!(handle.context.p2Capabilities ?? []).includes("contextProviders")) throw new Error("Plugin registered an undeclared context provider capability.");
		if (++handle.registrationCounts.contextProviders > 64) throw new Error("Plugin context provider registration limit exceeded.");
		handle.stagedRegistrations.contextProviders.push(event.registration);
	}
}

async function startWorker(record: PluginRecord, context: PluginRuntimeContext): Promise<WorkerHandle> {
	const runtimeRoot = join(getDaedalusPath("plugins.runtime"), record.id.replace(/[^a-zA-Z0-9._-]/gu, "_"), context.sessionId.replace(/[^a-zA-Z0-9._-]/gu, "_"));
	await mkdir(runtimeRoot, { recursive: true });
	const entry = join(record.packageRoot, record.nativePlugin!.entry);
	let bootstrapJs = fileURLToPath(new URL("./worker-bootstrap.js", import.meta.url));
	const bootstrapTs = fileURLToPath(new URL("./worker-bootstrap.ts", import.meta.url));
	const backendRoot = fileURLToPath(new URL("../../../", import.meta.url));
	const launchCwd = context.workspaceRoot ?? runtimeRoot;
	// Node 24 on Windows resolves an absolute entry-point as a filesystem path
	// before the ESM loader gets a chance to handle it.  In the AppContainer
	// this can trigger an EPERM realpath of `C:\\`.  Keep the bootstrap as a
	// relative path from the sandbox cwd instead; the helper grants backendRoot
	// read access separately, so this does not widen the workspace boundary.
	const relativeBootstrap = (target: string): string => {
		const value = relative(launchCwd, target).replaceAll("\\", "/");
		return value.startsWith(".") ? value : `./${value}`;
	};
	let useSourceBootstrap: boolean = !existsSync(bootstrapJs);
	if (useSourceBootstrap && !existsSync(bootstrapTs)) {
		const workerAssetRoot = join(runtimeRoot, "worker-assets");
		const materializedBootstrap = await materializeRuntimeAsset("plugin.workerBootstrap", { rootDir: workerAssetRoot, fileName: "worker-bootstrap.js" });
		const materializedProtocol = await materializeRuntimeAsset("plugin.workerProtocol", { rootDir: workerAssetRoot, fileName: "worker-protocol.js" });
		bootstrapJs = materializedBootstrap.path;
		await copyFile(materializedProtocol.path, join(dirname(bootstrapJs), "worker-protocol.js"));
		useSourceBootstrap = false;
	}
	const bootstrapArgs: string[] = useSourceBootstrap
		? [
			"--preserve-symlinks",
			"--preserve-symlinks-main",
			"--import",
			pathToFileURL(join(backendRoot, "node_modules", "tsx", "dist", "loader.mjs")).href,
			relativeBootstrap(bootstrapTs),
			"--plugin-worker"
		]
		: ["--preserve-symlinks", "--preserve-symlinks-main", relativeBootstrap(bootstrapJs), "--plugin-worker"];
	const sandbox = createSandboxInvocation({
		command: { kind: "argv", command: process.execPath, args: bootstrapArgs },
		cwd: context.workspaceRoot ?? runtimeRoot,
		workspaceRoot: context.workspaceRoot ?? runtimeRoot,
		readOnlyPaths: [record.packageRoot, ...(useSourceBootstrap ? [backendRoot] : [dirname(bootstrapJs)])],
		env: { DAEDALUS_PLUGIN_ID: record.id },
		network: false
	});
	if (!sandbox.available) throw new Error(sandbox.error);
	const child = spawn(sandbox.command, sandbox.args, { cwd: runtimeRoot, env: sandbox.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject): void => { resolveReady = resolve; rejectReady = reject; });
	const handle: WorkerHandle = { pluginId: record.id, sessionId: context.sessionId, child, pending: new Map(), ready, resolveReady, rejectReady, buffer: "", stderrTail: "", registrationCounts: { tools: 0, skills: 0, hooks: 0, mcps: 0, commands: 0, contextProviders: 0 }, context, activeCalls: 0, lastUsedAt: Date.now(), stopping: false, failed: false, stagedRegistrations: { tools: [], skills: [], hooks: [], mcps: [], commands: [], contextProviders: [] } };
	handles.set(key(record.id, context.sessionId), handle);
	setSnapshot(record.id, { status: "starting", activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === record.id).length });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string): void => {
		handle.buffer += chunk;
		if (Buffer.byteLength(handle.buffer, "utf8") > MAX_PLUGIN_MESSAGE_BYTES) { handle.stopping = true; handle.failed = true; terminateProcess(child, true); rejectReady(new Error("Plugin worker output exceeded the limit.")); return; }
		let index: number;
		while ((index = handle.buffer.indexOf("\n")) >= 0) {
			const line = handle.buffer.slice(0, index); handle.buffer = handle.buffer.slice(index + 1);
			try { handleEvent(handle, parseWorkerEvent(line)); }
			catch (error: unknown) {
				const failure = error instanceof Error ? error : new Error(String(error));
				clearPluginRegistrations(record.id);
				handle.stopping = true;
				handle.failed = true;
				rejectPending(handle, failure);
				rejectReady(failure);
				terminateProcess(child, true);
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string): void => {
		handle.stderrTail = redactRuntimeText(`${handle.stderrTail}${String(chunk)}`);
		addPluginRuntimeLog({ pluginId: record.id, sessionId: context.sessionId, event: "error", status: "failed", message: redactRuntimeText(String(chunk)) });
	});
	child.once("error", (error: Error): void => { rejectReady(error); rejectPending(handle, error); });
	child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null): void => {
		if (handle.idleTimer !== undefined) clearInterval(handle.idleTimer);
		if (handle.resourceTimer !== undefined) clearInterval(handle.resourceTimer);
		clearPluginRegistrations(record.id);
		const exit = exitCode === null ? `signal ${signal ?? "unknown"}` : `code ${exitCode}`;
		const detail = handle.stderrTail.trim();
		const error = new Error(`Plugin worker exited (${exit}).${detail.length > 0 ? ` ${detail}` : ""}`);
		rejectReady(error);
		rejectPending(handle, error);
		const wasActive: boolean = handles.get(key(record.id, context.sessionId)) === handle;
		if (wasActive) {
			handles.delete(key(record.id, context.sessionId));
			if (!handle.stopping || handle.failed) {
				void recordPluginFailure(record.id, context.sessionId, error.message).then((isolation): void => {
					setSnapshot(record.id, { status: isolation.status === "quarantined" ? "quarantined" : "failed", isolation, lastExitCode: exitCode, activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === record.id).length, lastError: error.message });
					if (isolation.status === "quarantined") clearPluginRegistrations(record.id);
				}).catch((): void => setSnapshot(record.id, { status: "failed", lastError: error.message }));
			} else {
				setSnapshot(record.id, { status: "stopped", lastExitCode: exitCode, activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === record.id).length });
			}
		}
	});
	const message: PluginWorkerMessage = { type: "initialize", protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION, entry, context };
	child.stdin.write(encodeWorkerMessage(message));
	await Promise.race([ready, new Promise<void>((_resolve, reject): void => { setTimeout((): void => reject(new Error("Plugin worker startup timed out.")), PLUGIN_START_TIMEOUT_MS); })]);
	handle.resourceTimer = setInterval((): void => {
		void readChildRssBytes(handle.child).then((rssBytes): void => {
			if (rssBytes === undefined) return;
			setSnapshot(record.id, { resourceUsage: { activeCalls: handle.activeCalls, pendingCalls: handle.pending.size, rssBytes, lastMeasuredAt: new Date().toISOString() } });
			if (rssBytes > MAX_PLUGIN_RSS_BYTES && !handle.stopping) {
				handle.stopping = true;
				handle.failed = true;
				const error = new Error("Plugin worker exceeded its memory limit.");
				rejectPending(handle, error);
				setSnapshot(record.id, { status: "failed", lastError: error.message });
				terminateProcess(handle.child, true);
			}
		}).catch((): void => undefined);
	}, 2_000);
	handle.resourceTimer.unref();
	handle.idleTimer = setInterval((): void => {
		if (!handle.stopping && handle.pending.size === 0 && Date.now() - handle.lastUsedAt >= PLUGIN_IDLE_TIMEOUT_MS) {
			handle.stopping = true;
			void stopPlugin(record.id, context.sessionId);
		}
	}, 60_000);
	handle.idleTimer.unref();
	setSnapshot(record.id, { status: "ready" });
	addPluginRuntimeLog({ pluginId: record.id, sessionId: context.sessionId, event: "ready", status: "ok" });
	return handle;
}

export type PluginRuntimeHandle = WorkerHandle | HarnessHandle;

export async function ensurePluginRuntime(pluginId: string, context: Omit<PluginRuntimeContext, "pluginId" | "capabilities">): Promise<PluginRuntimeHandle> {
	const record = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
	if (record === undefined) throw new Error("Plugin not found.");
	if ([...handles.values()].filter((handle): boolean => handle.sessionId === context.sessionId).length + countHarnessSessionRuntimes(context.sessionId) >= MAX_PLUGIN_SESSIONS && !handles.has(key(pluginId, context.sessionId)) && !hasHarnessHandle(pluginId, context.sessionId)) throw Object.assign(new Error("Plugin session runtime limit reached."), { code: "plugin_runtime_session_limit" });
	if (record.compatibility.harnessBundle && ["harness-bundle", "both"].includes(record.compatibility.classification)) return await ensureHarnessRuntime(pluginId, context);
	await validateRecord(record, context.sessionId);
	const dependency = await installPluginDependencies(record, false);
	setSnapshot(pluginId, { dependencyStatus: dependency.status });
	if (dependency.status === "needs_network") throw Object.assign(new Error("Plugin dependencies require explicit network approval."), { code: "plugin_dependencies_need_network" });
	if (dependency.status === "failed") throw new Error(dependency.result?.stderr || "Plugin dependency installation failed.");
	const existing = handles.get(key(pluginId, context.sessionId));
	if (existing !== undefined) return existing;
	try {
		return await startWorker(record, { ...context, pluginId, capabilities: record.nativePlugin!.capabilities, p2Capabilities: Object.keys(record.p2?.capabilities ?? {}) });
	} catch (error: unknown) {
		// Failures that happen before a child handle is installed (sandbox setup,
		// invalid cwd, spawn configuration) would otherwise bypass the circuit
		// breaker. A live handle records its own close/timeout failure exactly once.
		if (!handles.has(key(pluginId, context.sessionId))) {
			const reason = error instanceof Error ? error.message : String(error);
			void recordPluginFailure(pluginId, context.sessionId, reason).then((isolation): void => {
				setSnapshot(pluginId, { status: isolation.status === "quarantined" ? "quarantined" : "failed", isolation, lastError: reason });
			}).catch((): void => setSnapshot(pluginId, { status: "failed", lastError: reason }));
		}
		throw error;
	}
}

export async function installPluginRuntimeDependencies(pluginId: string, allowNetwork: boolean): Promise<PluginRuntimeSnapshot> {
	const record = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
	if (record === undefined) throw new Error("Plugin not found.");
	await validateRecord(record);
	const dependency = await installPluginDependencies(record, allowNetwork);
	setSnapshot(pluginId, { dependencyStatus: dependency.status, lastError: dependency.status === "failed" ? dependency.result?.stderr : undefined });
	addPluginRuntimeLog({ pluginId, event: "dependency", status: dependency.status === "ready" || dependency.status === "not_required" ? "ok" : "failed", message: dependency.result?.stderr?.slice(-2000) });
	if (dependency.status === "needs_network") throw Object.assign(new Error("Plugin dependencies require explicit network approval."), { code: "plugin_dependencies_need_network" });
	if (dependency.status === "failed") throw new Error(dependency.result?.stderr || "Plugin dependency installation failed.");
	return getPluginRuntimeSnapshot(pluginId)!;
}

export async function invokePlugin(pluginId: string, sessionId: string, kind: "tool" | "hook" | "mcp_tool" | "mcp_resource" | "command" | "context_provider", name: string, args: Record<string, unknown>, timeoutMs: number = PLUGIN_CALL_TIMEOUT_MS): Promise<unknown> {
	if (hasHarnessHandle(pluginId, sessionId)) {
		return await invokeHarnessPlugin(pluginId, sessionId, kind, name, args, timeoutMs);
	}
	const handle = handles.get(key(pluginId, sessionId));
	if (handle === undefined) throw new Error("Plugin runtime is not running.");
	const id = randomUUID();
	handle.lastUsedAt = Date.now();
	if (handle.pending.size >= MAX_PLUGIN_PENDING_CALLS) throw Object.assign(new Error("Plugin runtime call queue is full."), { code: "plugin_runtime_queue_full" });
	return new Promise((resolve, reject): void => {
		const timer = setTimeout((): void => {
			const pending = handle.pending.get(id);
			if (pending === undefined) return;
			handle.pending.delete(id);
			if (pending.started) handle.activeCalls = Math.max(0, handle.activeCalls - 1);
			reject(new Error("Plugin call timed out."));
			void recordPluginFailure(pluginId, sessionId, "Plugin call timed out.").then((isolation): void => {
				if (isolation.status === "quarantined") { handle.stopping = true; clearPluginRegistrations(pluginId); terminateProcess(handle.child, true); setSnapshot(pluginId, { status: "quarantined", isolation }); }
			});
			dispatchQueued(handle);
		}, Math.min(PLUGIN_CALL_TIMEOUT_MS, timeoutMs));
		handle.pending.set(id, { resolve, reject, timer, started: false, startedAt: Date.now(), kind, name, args });
		dispatchQueued(handle);
	});
}

export async function stopPlugin(pluginId: string, sessionId?: string, status: "stopped" | "disabled" = "stopped"): Promise<void> {
	await stopHarnessPlugin(pluginId, sessionId, status);
	stopPluginLanguageServicesForPlugin(pluginId, sessionId);
	const targets = [...handles.values()].filter((handle): boolean => handle.pluginId === pluginId && (sessionId === undefined || handle.sessionId === sessionId));
	for (const handle of targets) {
		handle.stopping = true;
		handle.failed = false;
		if (handle.idleTimer !== undefined) clearInterval(handle.idleTimer);
		if (handle.resourceTimer !== undefined) clearInterval(handle.resourceTimer);
		handle.child.stdin.write(encodeWorkerMessage({ type: "shutdown" }));
		terminateProcess(handle.child, true);
		rejectPending(handle, new Error("Plugin runtime stopped."));
		handles.delete(key(handle.pluginId, handle.sessionId));
	}
	clearPluginRegistrations(pluginId);
	setSnapshot(pluginId, { status, activeSessions: [...handles.values()].filter((item): boolean => item.pluginId === pluginId).length });
	await rm(join(getDaedalusPath("plugins.runtime"), pluginId.replace(/[^a-zA-Z0-9._-]/gu, "_")), { recursive: true, force: true }).catch((): void => undefined);
}

export async function clearPluginRuntimeQuarantine(pluginId: string, sessionId?: string): Promise<void> {
	await clearPluginQuarantine(pluginId, sessionId);
	await clearHarnessPluginQuarantine(pluginId, sessionId);
	setSnapshot(pluginId, { status: "stopped", isolation: { status: "none", failureCount: 0, updatedAt: new Date().toISOString() }, lastError: undefined });
}

export async function listPluginRuntimeQuarantine(pluginId?: string): Promise<unknown[]> {
	return await listPluginQuarantines(pluginId);
}

export async function restartPlugin(pluginId: string): Promise<void> {
	if (getHarnessRuntimeSnapshot(pluginId) !== undefined) {
		await restartHarnessPlugin(pluginId);
		return;
	}
	const contexts: PluginRuntimeContext[] = [...handles.values()].filter((handle): boolean => handle.pluginId === pluginId).map((handle): PluginRuntimeContext => handle.context);
	await stopPlugin(pluginId);
	for (const context of contexts) {
		try { await ensurePluginRuntime(pluginId, context); }
		catch (error: unknown) { setSnapshot(pluginId, { status: "failed", lastError: error instanceof Error ? error.message : String(error) }); }
	}
}

export function listPluginRuntimeSnapshots(): PluginRuntimeSnapshot[] {
	const merged = new Map<string, PluginRuntimeSnapshot>();
	for (const snapshot of snapshots.values()) merged.set(snapshot.pluginId, structuredClone(snapshot));
	for (const snapshot of listHarnessRuntimeSnapshots()) merged.set(snapshot.pluginId, snapshot);
	return [...merged.values()];
}

export function getPluginRuntimeSnapshot(pluginId: string): PluginRuntimeSnapshot | undefined { return getHarnessRuntimeSnapshot(pluginId) ?? snapshots.get(pluginId); }

export async function stopAllPluginRuntimes(): Promise<void> {
	await stopAllHarnessRuntimes();
	stopAllPluginLanguageServices();
	for (const pluginId of new Set([...handles.values()].map((handle): string => handle.pluginId))) await stopPlugin(pluginId);
}

/** Backend restarts never revive child processes; remove their abandoned sandboxes before serving requests. */
export async function recoverPluginRuntimeState(): Promise<void> {
	for (const path of [getDaedalusPath("plugins.runtime"), getDaedalusPath("plugins.harnessRuntime"), join(getDaedalusPath("plugins.root"), "staging")]) {
		try {
			for (const entry of await readdir(path)) await rm(join(path, entry), { recursive: true, force: true });
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") addPluginRuntimeLog({ pluginId: "system", event: "error", status: "failed", message: redactRuntimeText(error instanceof Error ? error.message : String(error)) });
		}
	}
	for (const isolation of await listPluginQuarantines()) {
		setSnapshot(isolation.pluginId, { status: "quarantined", isolation, lastError: isolation.reason });
	}
}

export async function ensureSessionPluginRuntimes(context: { sessionId: string; workspaceId?: string | undefined; workspaceRoot?: string | undefined }): Promise<void> {
	const catalog = await getPluginCatalog();
	for (const plugin of catalog.plugins.filter((candidate): boolean => candidate.enabled && (candidate.nativePlugin !== undefined || candidate.compatibility.harnessBundle))) {
		try {
			await ensurePluginRuntime(plugin.id, context);
		} catch (error: unknown) {
			setSnapshot(plugin.id, { status: "failed", lastError: error instanceof Error ? error.message : String(error) });
			addPluginRuntimeLog({ pluginId: plugin.id, sessionId: context.sessionId, event: "error", status: "failed", message: error instanceof Error ? error.message : String(error) });
		}
	}
}
