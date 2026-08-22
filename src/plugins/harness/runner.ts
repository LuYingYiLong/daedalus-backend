import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { createSandboxInvocation } from "../../mcp/terminal/sandbox-runner.js";
import { terminateProcess } from "../../mcp/terminal/process-runner.js";
import {
	clearPluginRegistrations
} from "../runtime/registries.js";
import {
	MAX_PLUGIN_HOOKS,
	MAX_PLUGIN_MCP_SERVERS,
	MAX_PLUGIN_SKILLS,
	MAX_PLUGIN_TOOLS
} from "../runtime/runtime-limits.js";
import { addPluginRuntimeLog } from "../runtime/runtime-logs.js";
import type { HarnessInstallation, PluginRecord, PluginRuntimeSnapshot } from "../types.js";
import type { PluginRuntimeContext } from "../runtime/worker-protocol.js";
import { createHarnessLaunchArgs, prepareHarnessBundle, type PreparedHarnessBundle } from "./bundle-adapter.js";
import {
	assertHarnessBridgeVersion,
	encodeHarnessRequest,
	parseHarnessEvent,
	type HarnessBridgeEvent,
	type HarnessBridgeRequest,
	type HarnessRegistrySnapshot
} from "./bridge-protocol.js";
import {
	HARNESS_BRIDGE_PROTOCOL_VERSION,
	HARNESS_CALL_TIMEOUT_MS,
	HARNESS_SHUTDOWN_TIMEOUT_MS,
	HARNESS_START_TIMEOUT_MS,
	MAX_HARNESS_FRAME_BYTES,
	MAX_HARNESS_RESULT_BYTES,
	MAX_HARNESS_STDERR_CHARS
} from "./limits.js";
import { registerHarnessHooks } from "./hook-adapter.js";
import { registerHarnessMcpServers } from "./mcp-adapter.js";
import { registerHarnessSkills } from "./skill-adapter.js";
import { registerHarnessTools } from "./tool-adapter.js";

type PendingCall = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	startedAt: number;
	started: boolean;
	message: HarnessBridgeRequest;
};

export type HarnessHandle = {
	pluginId: string;
	sessionId: string;
	child: ChildProcessWithoutNullStreams;
	context: PluginRuntimeContext;
	prepared: PreparedHarnessBundle;
	installation: HarnessInstallation;
	bundleFingerprint: string;
	initializeSent: boolean;
	pending: Map<string, PendingCall>;
	buffer: string;
	stderr: string;
	ready: Promise<void>;
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	closed: Promise<void>;
	resolveClosed: () => void;
	finalized: boolean;
	activeCalls: number;
	stopping: boolean;
	failed: boolean;
	lastUsedAt: number;
	resourceTimer?: NodeJS.Timeout | undefined;
	idleTimer?: NodeJS.Timeout | undefined;
};

export type HarnessRunnerCallbacks = {
	onSnapshot: (snapshot: Partial<PluginRuntimeSnapshot>) => void;
	onClosed: (handle: HarnessHandle, error?: Error) => void;
};

function redact(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
		.replace(/(api[_-]?key|authorization|cookie|password|secret|token)(\s*[:=]\s*)([^\s,;]+)/giu, "$1$2[redacted]")
		.slice(-MAX_HARNESS_STDERR_CHARS);
}

function resultBytes(value: unknown): number {
	try { return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8"); }
	catch { return MAX_HARNESS_RESULT_BYTES + 1; }
}

function validateRegistrySnapshot(registry: HarnessRegistrySnapshot): void {
	if (!Array.isArray(registry.tools) || !Array.isArray(registry.skills) || !Array.isArray(registry.hooks) || !Array.isArray(registry.mcpServers)) throw new Error("Harness registry snapshot is malformed.");
	if (registry.tools.length > MAX_PLUGIN_TOOLS || registry.skills.length > MAX_PLUGIN_SKILLS || registry.hooks.length > MAX_PLUGIN_HOOKS || registry.mcpServers.length > MAX_PLUGIN_MCP_SERVERS) throw new Error("Harness registry snapshot exceeds plugin registration limits.");
	for (const tool of registry.tools) {
		if (typeof tool.name !== "string" || typeof tool.title !== "string" || typeof tool.description !== "string" || tool.inputSchema === null || typeof tool.inputSchema !== "object") throw new Error("Harness tool registration is malformed.");
	}
	for (const skill of registry.skills) {
		if (typeof skill.slug !== "string" || typeof skill.name !== "string" || typeof skill.description !== "string" || typeof skill.body !== "string" || !Array.isArray(skill.allowedTools) || skill.body.length > 200_000 || skill.allowedTools.length > 64) throw new Error("Harness Skill registration is malformed or too large.");
	}
	for (const hook of registry.hooks) {
		if (typeof hook.event !== "string" || typeof hook.handlerName !== "string" || hook.event.length > 64 || hook.matcher !== undefined && (typeof hook.matcher !== "string" || hook.matcher.length > 512)) throw new Error("Harness Hook registration is malformed or too large.");
	}
	for (const server of registry.mcpServers) {
		if (typeof server.serverId !== "string" || typeof server.serverName !== "string" || !Array.isArray(server.tools) || !Array.isArray(server.resources) || server.tools.length > MAX_PLUGIN_TOOLS || server.resources.length > 64) throw new Error("Harness MCP registration is malformed or too large.");
	}
}

function rejectPending(handle: HarnessHandle, error: Error): void {
	for (const [id, pending] of handle.pending) {
		clearTimeout(pending.timer);
		pending.reject(error);
		handle.pending.delete(id);
	}
	handle.activeCalls = 0;
}

function dispatchQueued(handle: HarnessHandle): void {
	if (handle.stopping) return;
	for (const pending of handle.pending.values()) {
		if (handle.activeCalls >= 4 || pending.started) {
			if (handle.activeCalls >= 4) break;
			continue;
		}
		pending.started = true;
		handle.activeCalls += 1;
		try {
			handle.child.stdin.write(encodeHarnessRequest(pending.message));
		} catch (error: unknown) {
			clearTimeout(pending.timer);
			handle.pending.delete(pending.message.id);
			handle.activeCalls = Math.max(0, handle.activeCalls - 1);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}
}

function finalizeHandle(handle: HarnessHandle, callbacks: HarnessRunnerCallbacks, error: Error): void {
	if (handle.finalized) return;
	handle.finalized = true;
	handle.rejectReady(error);
	rejectPending(handle, error);
	handle.resolveClosed();
	void handle.prepared.cleanup();
	callbacks.onClosed(handle, error);
}

function applyRegistrySnapshot(pluginId: string, registry: HarnessRegistrySnapshot): void {
	validateRegistrySnapshot(registry);
	clearPluginRegistrations(pluginId);
	registerHarnessTools(pluginId, registry.tools);
	registerHarnessSkills(pluginId, registry.skills);
	registerHarnessHooks(pluginId, registry.hooks);
	registerHarnessMcpServers(pluginId, registry.mcpServers);
}

function handleEvent(handle: HarnessHandle, event: HarnessBridgeEvent, callbacks: HarnessRunnerCallbacks): void {
	if ("id" in event) {
		const pending = handle.pending.get(event.id);
		if (pending === undefined) throw new Error("Harness bridge returned an unknown response ID.");
		clearTimeout(pending.timer);
		handle.pending.delete(event.id);
		if (pending.started) handle.activeCalls = Math.max(0, handle.activeCalls - 1);
		if ("error" in event) pending.reject(Object.assign(new Error(event.error.message), { code: "plugin_harness_call_failed" }));
		else if (resultBytes(event.result) > MAX_HARNESS_RESULT_BYTES) pending.reject(new Error("Harness result exceeds the size limit."));
		else pending.resolve(event.result);
		addPluginRuntimeLog({ pluginId: handle.pluginId, sessionId: handle.sessionId, event: "invoke", status: "error" in event ? "failed" : "ok", durationMs: Date.now() - pending.startedAt, message: "error" in event ? event.error.message : undefined });
		dispatchQueued(handle);
		return;
	}
	if (event.method === "log") {
		addPluginRuntimeLog({ pluginId: handle.pluginId, sessionId: handle.sessionId, event: event.params.level === "error" ? "error" : "invoke", status: event.params.level === "error" ? "failed" : "ok", message: redact(event.params.message) });
		return;
	}
	if (event.method === "bridge.loaded") {
		assertHarnessBridgeVersion(event.params.protocolVersion);
		if (!handle.initializeSent) {
			handle.initializeSent = true;
			void request(handle, "initialize", { protocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION, bundleFingerprint: handle.bundleFingerprint, context: handle.context }, HARNESS_START_TIMEOUT_MS)
				.catch((error: unknown): void => handle.rejectReady(error instanceof Error ? error : new Error(String(error))));
		}
		return;
	}
	if (event.method === "registry.snapshot") {
		applyRegistrySnapshot(handle.pluginId, event.params);
		callbacks.onSnapshot({ registeredTools: event.params.tools.length, registeredSkills: event.params.skills.length, registeredHooks: event.params.hooks.length, registeredMcpServers: event.params.mcpServers.length });
		return;
	}
	assertHarnessBridgeVersion(event.params.protocolVersion);
	applyRegistrySnapshot(handle.pluginId, event.params.registry);
	callbacks.onSnapshot({
		status: "ready",
		harnessStatus: "running",
		harnessVersion: event.params.harnessVersion ?? handle.installation.version,
		registeredTools: event.params.registry.tools.length,
		registeredSkills: event.params.registry.skills.length,
		registeredHooks: event.params.registry.hooks.length,
		registeredMcpServers: event.params.registry.mcpServers.length
	});
	handle.resolveReady();
}

function request(handle: HarnessHandle, method: HarnessBridgeRequest["method"], params: Record<string, unknown>, timeoutMs: number = HARNESS_CALL_TIMEOUT_MS): Promise<unknown> {
	const id: string = randomUUID();
	const message = { jsonrpc: "2.0", id, method, params } as HarnessBridgeRequest;
	return new Promise((resolve, reject): void => {
		const timer = setTimeout((): void => {
			handle.pending.delete(id);
			handle.activeCalls = Math.max(0, handle.activeCalls - 1);
			reject(Object.assign(new Error(`Harness ${method} timed out.`), { code: "plugin_harness_timeout" }));
		}, timeoutMs);
		handle.pending.set(id, { resolve, reject, timer, startedAt: Date.now(), started: true, message });
		handle.activeCalls += 1;
		try {
			handle.child.stdin.write(encodeHarnessRequest(message));
		} catch (error: unknown) {
			clearTimeout(timer);
			handle.pending.delete(id);
			handle.activeCalls = Math.max(0, handle.activeCalls - 1);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function queuedInvoke(handle: HarnessHandle, kind: "tool" | "hook" | "mcp_tool" | "mcp_resource", name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
	const id: string = randomUUID();
	const message = { jsonrpc: "2.0", id, method: "invoke", params: { kind, name, args } } as HarnessBridgeRequest;
	return new Promise((resolve, reject): void => {
		const timer = setTimeout((): void => {
			const pending = handle.pending.get(id);
			if (pending === undefined) return;
			handle.pending.delete(id);
			if (pending.started) handle.activeCalls = Math.max(0, handle.activeCalls - 1);
			reject(Object.assign(new Error("Harness invoke timed out."), { code: "plugin_harness_timeout" }));
			handle.failed = true;
			handle.stopping = true;
			terminateProcess(handle.child, true);
			dispatchQueued(handle);
		}, timeoutMs);
		handle.pending.set(id, { resolve, reject, timer, startedAt: Date.now(), started: false, message });
		dispatchQueued(handle);
	});
}

export async function startHarnessSidecar(
	record: PluginRecord,
	context: PluginRuntimeContext,
	installation: HarnessInstallation,
	callbacks: HarnessRunnerCallbacks
): Promise<HarnessHandle> {
	if (installation.status !== "detected" || installation.command === undefined) throw Object.assign(new Error(installation.error ?? "Harness installation is not ready."), { code: "plugin_harness_unavailable" });
	const prepared: PreparedHarnessBundle = await prepareHarnessBundle(record, context.sessionId);
	const launchArgs: string[] = createHarnessLaunchArgs(installation.args, prepared);
	const writableRoot: string = context.workspaceRoot ?? prepared.runtimeRoot;
	const sandbox = createSandboxInvocation({
		command: { kind: "argv", command: installation.command, args: launchArgs },
		cwd: context.workspaceRoot ?? prepared.runtimeRoot,
		workspaceRoot: writableRoot,
		readOnlyPaths: [record.packageRoot, prepared.runtimeRoot, ...(record.compatibility.patchPath === undefined ? [] : [dirname(prepared.pluginPatchPath)]), ...installation.readOnlyPaths],
		env: {
			DAEDALUS_PLUGIN_ID: record.id,
			DAEDALUS_HARNESS_BRIDGE_VERSION: String(HARNESS_BRIDGE_PROTOCOL_VERSION),
			DSH_HOME: prepared.harnessHome
		},
		network: false
	});
	if (!sandbox.available) { await prepared.cleanup(); throw Object.assign(new Error(sandbox.error), { code: "plugin_harness_sandbox_unavailable" }); }
	const child = spawn(sandbox.command, sandbox.args, { cwd: context.workspaceRoot ?? prepared.runtimeRoot, env: sandbox.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	let resolveClosed!: () => void;
	const ready = new Promise<void>((resolve, reject): void => { resolveReady = resolve; rejectReady = reject; });
	const closed = new Promise<void>((resolve): void => { resolveClosed = resolve; });
	const handle: HarnessHandle = { pluginId: record.id, sessionId: context.sessionId, child, context, prepared, installation, bundleFingerprint: record.fingerprint, initializeSent: false, pending: new Map(), buffer: "", stderr: "", ready, resolveReady, rejectReady, closed, resolveClosed, finalized: false, activeCalls: 0, stopping: false, failed: false, lastUsedAt: Date.now() };
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string): void => {
		handle.buffer += chunk;
		if (Buffer.byteLength(handle.buffer, "utf8") > MAX_HARNESS_FRAME_BYTES * 2) {
			handle.rejectReady(new Error("Harness bridge output exceeds the buffer limit."));
			terminateProcess(child, true);
			return;
		}
		let newline: number;
		while ((newline = handle.buffer.indexOf("\n")) >= 0) {
			const line: string = handle.buffer.slice(0, newline).trim();
			handle.buffer = handle.buffer.slice(newline + 1);
			if (line.length === 0) continue;
			try {
				if (!line.startsWith("{")) throw new Error("Harness stdout contained a non-JSON protocol frame.");
				handleEvent(handle, parseHarnessEvent(line), callbacks);
			}
			catch (error: unknown) {
				const failure = error instanceof Error ? error : new Error(String(error));
				rejectPending(handle, failure);
				handle.rejectReady(failure);
				terminateProcess(child, true);
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string): void => {
		handle.stderr = redact(`${handle.stderr}${chunk}`);
		addPluginRuntimeLog({ pluginId: record.id, sessionId: context.sessionId, event: "error", status: "failed", message: handle.stderr.slice(-2_000) });
	});
	child.once("error", (error: Error): void => { finalizeHandle(handle, callbacks, error); });
	child.once("close", (exitCode: number | null): void => {
		callbacks.onSnapshot({ lastExitCode: exitCode });
		const error = new Error(handle.stderr.trim() || "Harness Sidecar exited.");
		finalizeHandle(handle, callbacks, error);
	});
	callbacks.onSnapshot({ runtimeKind: "harness", status: "starting", harnessStatus: "ready", bundleSummary: prepared.summary, harnessVersion: installation.version, bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION });
	try {
		await Promise.race([
			handle.ready,
			new Promise<void>((_resolve, reject): void => { setTimeout((): void => reject(Object.assign(new Error("Harness Sidecar startup timed out."), { code: "plugin_harness_start_timeout" })), HARNESS_START_TIMEOUT_MS); })
		]);
	} catch (error: unknown) {
		if (child.exitCode === null) terminateProcess(child, true);
		await Promise.race([closed, new Promise<void>((resolve): void => { setTimeout(resolve, HARNESS_SHUTDOWN_TIMEOUT_MS); })]);
		await prepared.cleanup();
		throw error;
	}
	return handle;
}

export async function invokeHarness(handle: HarnessHandle, kind: "tool" | "hook" | "mcp_tool" | "mcp_resource", name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
	if (handle.pending.size >= 16) throw Object.assign(new Error("Harness runtime call queue is full."), { code: "plugin_runtime_queue_full" });
	handle.lastUsedAt = Date.now();
	return await queuedInvoke(handle, kind, name, args, Math.min(timeoutMs ?? HARNESS_CALL_TIMEOUT_MS, HARNESS_CALL_TIMEOUT_MS));
}

export async function stopHarnessSidecar(handle: HarnessHandle): Promise<void> {
	handle.stopping = true;
	try { await request(handle, "shutdown", {}, HARNESS_SHUTDOWN_TIMEOUT_MS); }
	catch { /* Process termination below remains authoritative. */ }
	if (handle.child.exitCode === null) terminateProcess(handle.child, true);
	await Promise.race([handle.closed, new Promise<void>((resolve): void => { setTimeout(resolve, HARNESS_SHUTDOWN_TIMEOUT_MS); })]);
	rejectPending(handle, new Error("Harness Sidecar stopped."));
	await handle.prepared.cleanup();
}
