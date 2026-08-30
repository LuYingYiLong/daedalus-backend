import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { getPluginCatalog, pluginFingerprint } from "../manager.js";
import { isPathInside } from "../manifest.js";
import { createSandboxInvocation } from "../../mcp/terminal/sandbox-runner.js";
import { terminateProcess } from "../../mcp/terminal/process-runner.js";
import { getPluginP2Snapshot } from "./registry.js";

const MAX_STDERR_CHARS = 4000;
const handles = new Map<string, ChildProcessWithoutNullStreams>();

function handleKey(pluginId: string, serviceId: string, sessionId: string): string {
	return `${pluginId}\0${serviceId}\0${sessionId}`;
}

function serviceIdMatches(candidate: string, requested: string): boolean {
	return candidate === requested || candidate.endsWith(`:${requested}`);
}

function redact(value: string): string {
	return value.replace(/(api[_-]?key|authorization|cookie|password|secret|token)(\s*[:=]\s*)([^\s,;]+)/giu, "$1$2[redacted]").slice(-MAX_STDERR_CHARS);
}

export async function startPluginLanguageService(input: { serviceId: string; sessionId: string; workspaceRoot: string }): Promise<Record<string, unknown>> {
	const snapshot = await getPluginP2Snapshot();
	const service = snapshot.languageServices.find((candidate): boolean => serviceIdMatches(candidate.id, input.serviceId));
	if (service === undefined) throw Object.assign(new Error("Plugin language service was not found or is disabled."), { code: "plugin_language_service_not_found" });
	const plugin = (await getPluginCatalog()).plugins.find((candidate): boolean => candidate.id === service.pluginId);
	if (plugin === undefined || pluginFingerprint(plugin) !== plugin.fingerprint) throw Object.assign(new Error("Plugin fingerprint is stale; rescan and trust the plugin again."), { code: "plugin_fingerprint_stale" });
	const workspaceRoot = resolve(input.workspaceRoot);
	if (workspaceRoot.length === 0) throw Object.assign(new Error("Language service workspace is invalid."), { code: "plugin_language_service_workspace_invalid" });
	const key = handleKey(service.pluginId, service.id, input.sessionId);
	const existing = handles.get(key);
	if (existing !== undefined && existing.exitCode === null) return { started: true, status: "running", serviceId: input.serviceId };
	const command = service.command.trim();
	if (command.length === 0 || /[\r\n]/u.test(command)) throw Object.assign(new Error("Language service command is invalid."), { code: "plugin_language_service_command_invalid" });
	// Language-service entries are package-owned executables.  Do not resolve
	// arbitrary PATH commands supplied by a plugin manifest.
	const packageCommand = isAbsolute(command) ? resolve(command) : resolve(plugin.packageRoot, command);
	if (!isPathInside(plugin.packageRoot, packageCommand)) throw Object.assign(new Error("Language service command must stay inside the plugin package."), { code: "plugin_language_service_command_escape" });
	try {
		const commandStat = await lstat(packageCommand);
		if (!commandStat.isFile()) throw new Error("entry is not a regular file");
	} catch (error: unknown) {
		throw Object.assign(new Error(`Language service entry is unavailable: ${error instanceof Error ? error.message : "unknown error"}.`), { code: "plugin_language_service_entry_missing" });
	}
	const sandbox = createSandboxInvocation({
		command: { kind: "argv", command: packageCommand, args: service.args ?? [] },
		cwd: workspaceRoot,
		workspaceRoot,
		readOnlyPaths: [plugin.packageRoot],
		env: { DAEDALUS_PLUGIN_ID: plugin.id, DAEDALUS_LANGUAGE_SERVICE_ID: service.id },
		network: false
	});
	if (!sandbox.available) throw Object.assign(new Error(sandbox.error ?? "Plugin language service sandbox is unavailable."), { code: "plugin_language_service_sandbox_unavailable" });
	const child = spawn(sandbox.command, sandbox.args, { cwd: workspaceRoot, env: sandbox.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (): void => undefined);
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string): void => { redact(chunk); });
	child.once("close", (): void => { if (handles.get(key) === child) handles.delete(key); });
	handles.set(key, child);
	return { started: true, status: "running", serviceId: input.serviceId, capabilities: service.capabilities };
}

export function stopPluginLanguageService(input: { serviceId: string; sessionId: string }): { stopped: true; serviceId: string } {
	for (const [key, child] of handles) {
		const [, serviceId, sessionId] = key.split("\0");
		if (sessionId !== input.sessionId || serviceId === undefined || !serviceIdMatches(serviceId, input.serviceId)) continue;
		terminateProcess(child, true);
		handles.delete(key);
	}
	return { stopped: true, serviceId: input.serviceId };
}

export function stopPluginLanguageServicesForPlugin(pluginId: string, sessionId?: string): void {
	for (const [key, child] of handles) {
		if (!key.startsWith(`${pluginId}\0`) || sessionId !== undefined && !key.endsWith(`\0${sessionId}`)) continue;
		terminateProcess(child, true);
		handles.delete(key);
	}
}

export function stopAllPluginLanguageServices(): void {
	for (const [key, child] of handles) {
		terminateProcess(child, true);
		handles.delete(key);
	}
}
