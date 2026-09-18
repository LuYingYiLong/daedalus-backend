import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolve } from "node:path";
import { clearPluginRegistrations, getPluginTool, listPluginMcpTools, listPluginSkills, registerPluginFlowNode, registerPluginMcp, registerPluginSkill, registerPluginTool } from "../../../src/plugins/runtime/registries.js";
import { findFlowNodeTypeDefinition } from "../../../src/server/flow-node-registry.js";
import { encodeWorkerMessage, parseWorkerEvent, parseWorkerMessage } from "../../../src/plugins/runtime/worker-protocol.js";
import { getRuntimeRecoveryFields } from "../../../src/plugins/runtime/runtime-snapshot.js";

const fixturePath: string = fileURLToPath(new URL("../../fixtures/native-plugin", import.meta.url));
const flowFixturePath: string = fileURLToPath(new URL("../../fixtures/flow-node-plugin", import.meta.url));

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

test("community Flow nodes use host schema validation and package fingerprints", (): void => {
	const ownerPluginId = "fixture-flow";
	registerPluginFlowNode(ownerPluginId, "sha256:fixture", {
		typeId: "fixture-flow/uppercase",
		pluginId: "fixture-flow",
		pluginVersion: "1.0.0",
		configVersion: 1,
		category: "text",
		workspaceRequired: false,
		sideEffecting: false,
		executable: true,
		cachePolicy: "always",
		defaultTitle: "Uppercase",
		defaultConfig: { prefix: "" },
		configSchema: { type: "object", properties: { prefix: { type: "string" } }, required: ["prefix"], additionalProperties: false },
		summaryFields: ["prefix"],
		ui: { kind: "schema" },
		parameters: [{ id: "prefix", label: "Prefix", mode: "fixed", configField: "prefix" }],
		outputs: [{ id: "output", label: "Output", dataTypes: ["text"], defaultConnect: true }],
		handlerName: "uppercase",
	});
	try {
		const definition = findFlowNodeTypeDefinition("fixture-flow/uppercase");
		assert.equal(definition?.pluginFingerprint, "sha256:fixture");
		assert.equal(definition?.typeId, "fixture-flow/uppercase");
	} finally {
		clearPluginRegistrations(ownerPluginId);
	}
	assert.equal(findFlowNodeTypeDefinition("fixture-flow/uppercase"), undefined);
});

test("worker protocol accepts JSON line events and rejects malformed envelopes", (): void => {
	const encoded = encodeWorkerMessage({ type: "shutdown" });
	assert.equal(encoded.endsWith("\n"), true);
	assert.equal(parseWorkerMessage(JSON.stringify({ type: "cancel", id: "call-a" })).type, "cancel");
	assert.equal(parseWorkerEvent(JSON.stringify({ type: "ready", protocolVersion: 3 })).type, "ready");
	assert.throws(() => parseWorkerEvent(JSON.stringify({ value: true })), /Invalid plugin worker event/);
});

test("a recovered plugin runtime clears stale exit errors", (): void => {
	assert.deepEqual(getRuntimeRecoveryFields("ready"), { lastError: undefined, lastExitCode: null });
	assert.deepEqual(getRuntimeRecoveryFields("starting"), { lastError: undefined, lastExitCode: null });
	assert.deepEqual(getRuntimeRecoveryFields("failed"), {});
});

test("native plugin fixture registers and invokes through the worker protocol", async (): Promise<void> => {
	const backendRoot: string = resolve(".");
	const bootstrap: string = resolve("src/plugins/runtime/worker-bootstrap.js");
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bootstrap, "--plugin-worker"], {
		cwd: backendRoot,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString("utf8"); });
	try {
		child.stdin.write(encodeWorkerMessage({
			type: "initialize",
			protocolVersion: 3,
			entry: resolve(fixturePath, "index.js"),
			context: { pluginId: "fixture", sessionId: "test", workspaceId: "workspace", workspaceRoot: backendRoot, capabilities: ["tools", "skills", "hooks", "mcp"] },
		}));
		// fixture 会先发送 P2 命令，再发送原生能力注册；等待完整快照，避免依赖 CI 的 stdout 分块方式
		const registrations = await readWorkerEvents(child, 6);
		assert.equal(registrations.filter((event): boolean => event.type === "register.command").length, 1);
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

test("worker protocol cancels an active Flow node without blocking the message loop", async (): Promise<void> => {
	const bootstrap: string = resolve("src/plugins/runtime/worker-bootstrap.js");
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bootstrap, "--plugin-worker"], {
		cwd: resolve("."),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString("utf8"); });
	try {
		child.stdin.write(encodeWorkerMessage({
			type: "initialize",
			protocolVersion: 3,
			entry: resolve(flowFixturePath, "index.js"),
			context: { pluginId: "fixture", sessionId: "flow-test", capabilities: ["flowNodes"] },
		}));
		child.stdin.write(encodeWorkerMessage({ type: "invoke", id: "flow-call", kind: "flow_node", name: "flow-node:fixture/cancellable:0", args: { config: {}, inputs: {}, context: {} } }));
		child.stdin.write(encodeWorkerMessage({ type: "cancel", id: "flow-call" }));
		const events = await readWorkerEvents(child, 3);
		assert.equal(events[0]?.type, "register.flowNode");
		assert.equal(events[1]?.type, "ready");
		assert.deepEqual(events[2], { type: "result", id: "flow-call", ok: false, error: "fixture cancelled" });
	} finally {
		child.kill();
	}
	assert.equal(stderr, "");
});

test("Flow node workers access host tools only through the reverse capability channel", async (): Promise<void> => {
	const bootstrap: string = resolve("src/plugins/runtime/worker-bootstrap.js");
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bootstrap, "--plugin-worker"], {
		cwd: resolve("."),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString("utf8"); });
	try {
		child.stdin.write(encodeWorkerMessage({
			type: "initialize",
			protocolVersion: 3,
			entry: resolve(flowFixturePath, "index.js"),
			context: { pluginId: "fixture", sessionId: "flow-host-test", capabilities: ["flowNodes", "flowHostTools"] },
		}));
		const registrations = await readWorkerEvents(child, 2);
		assert.equal(registrations[0]?.type, "register.flowNode");
		assert.equal(registrations[1]?.type, "ready");
		child.stdin.write(encodeWorkerMessage({ type: "invoke", id: "flow-host-call", kind: "flow_node", name: "flow-node:fixture/cancellable:0", args: { config: { hostTool: "fixture_read", hostArgs: { path: "a.txt" } }, inputs: {}, context: {} } }));
		const [request] = await readWorkerEvents(child, 1);
		assert.deepEqual(request, { type: "host.request", requestId: "host-flow-host-call-1", invocationId: "flow-host-call", method: "tool.call", params: { name: "fixture_read", args: { path: "a.txt" } } });
		child.stdin.write(encodeWorkerMessage({ type: "host.response", requestId: String(request?.requestId), ok: true, value: { text: "safe result" } }));
		const [result] = await readWorkerEvents(child, 1);
		assert.deepEqual(result, { type: "result", id: "flow-host-call", ok: true, value: { output: { text: "safe result" } } });
	} finally {
		child.kill();
	}
	assert.equal(stderr, "");
});
