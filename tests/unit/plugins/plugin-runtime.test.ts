import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolve } from "node:path";
import { clearPluginRegistrations, getPluginTool, listPluginMcpTools, listPluginSkills, registerPluginMcp, registerPluginSkill, registerPluginTool } from "../../../src/plugins/runtime/registries.js";
import { encodeWorkerMessage, parseWorkerEvent } from "../../../src/plugins/runtime/worker-protocol.js";

const fixturePath: string = fileURLToPath(new URL("../../fixtures/native-plugin", import.meta.url));

async function readWorkerEvents(child: ChildProcessWithoutNullStreams, count: number): Promise<Array<Record<string, unknown>>> {
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	const events: Array<Record<string, unknown>> = [];
	return new Promise((resolveEvents, reject): void => {
		const timeout = setTimeout((): void => {
			lines.close();
			reject(new Error("Native plugin fixture worker timed out."));
		}, 10_000);
		lines.on("line", (line: string): void => {
			try {
				events.push(parseWorkerEvent(line) as unknown as Record<string, unknown>);
			} catch (error: unknown) {
				clearTimeout(timeout);
				lines.close();
				reject(error);
				return;
			}
			if (events.length >= count) {
				clearTimeout(timeout);
				lines.close();
				resolveEvents(events);
			}
		});
	});
}

test("native plugin registrations use stable namespaces and can be cleared", (): void => {
	const pluginId = "fixture-runtime-plugin";
	registerPluginTool(pluginId, { name: "read_status", title: "Read status", description: "Read status", inputSchema: { type: "object" }, risk: "read", workflow: true, global: false });
	registerPluginSkill(pluginId, { slug: "status", name: "Status", description: "Status instructions", body: "Use the status tool.", allowedTools: [] });
	registerPluginMcp(pluginId, { serverId: "fixture", serverName: "Fixture", tools: [{ name: "ping", inputSchema: { type: "object" }, risk: "read" }], resources: [] });
	try {
		const tool = getPluginTool("mcp_plugin_fixture_runtime_plugin_read_status");
		assert.equal(tool?.mapping.serverId, "plugin:fixture-runtime-plugin");
		assert.equal(listPluginSkills().some((skill): boolean => skill.ref === "plugin:fixture-runtime-plugin:status"), true);
		assert.equal(listPluginMcpTools().find((tool): boolean => tool.pluginId === pluginId)?.name, "ping");
	} finally {
		clearPluginRegistrations(pluginId);
	}
	assert.equal(getPluginTool("mcp_plugin_fixture_runtime_plugin_read_status"), undefined);
});

test("worker protocol accepts JSON line events and rejects malformed envelopes", (): void => {
	const encoded = encodeWorkerMessage({ type: "shutdown" });
	assert.equal(encoded.endsWith("\n"), true);
	assert.equal(parseWorkerEvent(JSON.stringify({ type: "ready", protocolVersion: 1 })).type, "ready");
	assert.throws(() => parseWorkerEvent(JSON.stringify({ value: true })), /Invalid plugin worker event/);
});

test("native plugin fixture registers and invokes through the worker protocol", async (): Promise<void> => {
	const backendRoot: string = resolve(".");
	const bootstrap: string = resolve("src/plugins/runtime/worker-bootstrap.ts");
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", "tsx", bootstrap, "--plugin-worker"], {
		cwd: backendRoot,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString("utf8"); });
	try {
		child.stdin.write(encodeWorkerMessage({
			type: "initialize",
			protocolVersion: 1,
			entry: resolve(fixturePath, "index.js"),
			context: { pluginId: "fixture", sessionId: "test", workspaceId: "workspace", workspaceRoot: backendRoot, capabilities: ["tools", "skills", "hooks", "mcp"] },
		}));
		// fixture 会先发送 P2 命令和上下文提供器注册，再发送原生能力注册；等待完整快照，避免依赖 CI 的 stdout 分块方式
		const registrations = await readWorkerEvents(child, 7);
		assert.equal(registrations.filter((event): boolean => event.type === "register.command").length, 1);
		assert.equal(registrations.filter((event): boolean => event.type === "register.context-provider").length, 1);
		assert.equal(registrations.filter((event): boolean => event.type === "register.tool").length, 1);
		assert.equal(registrations.filter((event): boolean => event.type === "register.skill").length, 1);
		assert.equal(registrations.filter((event): boolean => event.type === "register.hook").length, 1);
		assert.equal(registrations.filter((event): boolean => event.type === "register.mcp").length, 1);
		assert.equal(registrations.filter((event): boolean => event.type === "ready").length, 1);
		child.stdin.write(encodeWorkerMessage({ type: "invoke", id: "echo", kind: "tool", name: "fixture_echo", args: { text: "hello" } }));
		const [result] = await readWorkerEvents(child, 1);
		assert.equal(result?.type, "result", stderr);
		assert.deepEqual(result?.value, { echo: "hello" });
	} finally {
		if (child.exitCode === null) child.kill();
	}
});
