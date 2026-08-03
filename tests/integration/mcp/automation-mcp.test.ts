import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { WebSocketServer, WebSocket } from "ws";
import { AUTOMATION_MCP_TOOL_NAMES, createAutomationConfig } from "../../../src/mcp/automation/config.js";
import { AutomationRpcClient } from "../../../src/mcp/automation/rpc-client.js";
import {
	extractApprovalPaths,
	isApprovalAllowed,
	redactAutomationResult,
	selectMatchingApproval,
	type ApprovalCandidate
} from "../../../src/mcp/automation/security.js";
import { buildGlobalMcpServerConfigs, buildMcpServerConfigs } from "../../../src/mcp/mcp-config.js";
import { getToolDefinitions } from "../../../src/tools/builtin-tool-definitions.js";
import { resolveToolMapping } from "../../../src/tools/tool-mapping.js";

const EXPECTED_AUTOMATION_TOOLS = [
	"daedalus_backend_health",
	"daedalus_configure_environment",
	"daedalus_create_session",
	"daedalus_open_session",
	"daedalus_get_session_info",
	"daedalus_send_chat",
	"daedalus_wait_for_event",
	"daedalus_wait_for_run",
	"daedalus_get_session_events",
	"daedalus_get_plan",
	"daedalus_submit_clarification",
	"daedalus_revise_plan",
	"daedalus_approve_plan",
	"daedalus_list_pending_approvals",
	"daedalus_approve_matching_tool",
	"daedalus_get_file_edit_batch",
	"daedalus_assert_session_state"
] as const;

test("automation MCP manifest is explicit and not exposed through product MCP/tool lists", (): void => {
	assert.deepEqual(AUTOMATION_MCP_TOOL_NAMES, EXPECTED_AUTOMATION_TOOLS);

	const internalMcpNames = buildMcpServerConfigs().map((server): string => server.name);
	assert.ok(!internalMcpNames.includes("automation"));
	assert.ok(!internalMcpNames.includes("godot-daedalus-automation-mcp"));

	const llmToolNames = getToolDefinitions()
		.filter((tool): boolean => tool.type === "function" && "function" in tool)
		.map((tool): string => (tool as { function: { name: string } }).function.name);
	for (const name of EXPECTED_AUTOMATION_TOOLS) {
		assert.ok(!llmToolNames.includes(name), `automation tool leaked into LLM definitions: ${name}`);
		assert.throws((): void => {
			resolveToolMapping(name);
		}, /Unknown tool/);
	}
});

test("terminal and documentation MCPs are global internal servers instead of workspace servers", (): void => {
	const globalServerIds = buildGlobalMcpServerConfigs().map((server): string => server.id);
	const workspaceServerIds = buildMcpServerConfigs({
		id: "workspace-terminal-test",
		name: "workspace-terminal-test",
		kind: "godot",
		rootPath: process.cwd(),
		icon: 0,
		color: 0,
		sourceFolders: [{ id: "primary", path: process.cwd(), capabilities: { git: false, godot: false } }],
		primarySourceFolderId: "primary"
	}).map((server): string => server.id);

	assert.ok(globalServerIds.includes("terminal"));
	assert.ok(!workspaceServerIds.includes("terminal"));
	assert.ok(globalServerIds.includes("godot_documentation"));
	assert.ok(!workspaceServerIds.includes("godot_documentation"));
	assert.ok(globalServerIds.includes("skills"));
	assert.ok(workspaceServerIds.includes("skills"));
});

test("multi-root workspaces create source-scoped MCP sessions without changing LLM tool names", (): void => {
	const workspace = {
		id: "workspace-multi-root",
		name: "Multi root",
		kind: "godot" as const,
		rootPath: process.cwd(),
		icon: 5 as const,
		color: 4 as const,
		sourceFolders: [
			{ id: "primary", path: process.cwd(), capabilities: { git: true, godot: false } },
			{ id: "tools", path: path.resolve(process.cwd(), "tests"), capabilities: { git: false, godot: false } }
		],
		primarySourceFolderId: "primary"
	};
	const configs = buildMcpServerConfigs(workspace);
	const serverIds: string[] = configs.map((config): string => config.id);

	assert.ok(serverIds.includes("workspace"));
	assert.ok(serverIds.includes("workspace:tools"));
	assert.ok(serverIds.includes("skills"));
	assert.ok(serverIds.includes("skills:tools"));
	assert.equal(configs.find((config) => config.id === "workspace:tools")?.env?.WORKSPACE_ROOT, path.resolve(process.cwd(), "tests"));

	const toolDefinitions = getToolDefinitions();
	const workspaceTool = toolDefinitions.find((tool) => tool.type === "function"
		&& "function" in tool
		&& tool.function.name === "mcp_workspace_read_text_file");
	const imageGenerateTool = toolDefinitions.find((tool) => tool.type === "function"
		&& "function" in tool
		&& tool.function.name === "mcp_image_generate");
	assert.ok(workspaceTool !== undefined && workspaceTool.type === "function");
	assert.ok(imageGenerateTool !== undefined && imageGenerateTool.type === "function");
	if (workspaceTool !== undefined && workspaceTool.type === "function") {
		const properties = (workspaceTool.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
		assert.ok("sourceFolderId" in properties);
	}
	if (imageGenerateTool !== undefined && imageGenerateTool.type === "function") {
		const properties = (imageGenerateTool.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
		assert.ok(!("sourceFolderId" in properties));
	}
});

test("automation MCP config requires explicit enable flag and supports backend overrides", (): void => {
	const disabled = createAutomationConfig({
		DAEDALUS_AUTOMATION_BACKEND_URL: "ws://127.0.0.1:40000"
	}, []);
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.backendUrl, "ws://127.0.0.1:40000");

	const enabled = createAutomationConfig({
		DAEDALUS_AUTOMATION_MCP: "1",
		DAEDALUS_AUTOMATION_ALLOWED_TOOLS: "mcp_godot_create_text_file,mcp_godot_apply_scene_patch",
		DAEDALUS_AUTOMATION_ALLOWED_PATH_PREFIXES: "scripts/daedalus_smoke_,scenes/daedalus_smoke_"
	}, ["--backend-url", "ws://localhost:38181"]);
	assert.equal(enabled.enabled, true);
	assert.equal(enabled.backendUrl, "ws://localhost:38181");
	assert.equal(enabled.requestTimeoutMs, 120000);
	assert.deepEqual(enabled.allowedTools, ["mcp_godot_create_text_file", "mcp_godot_apply_scene_patch"]);
});

test("automation approval whitelist rejects unknown, destructive and out-of-scope paths", (): void => {
	const whitelist = {
		allowedTools: ["mcp_godot_create_text_file", "mcp_godot_apply_scene_patch"],
		allowedPathPrefixes: ["scripts/daedalus_smoke_", "scenes/daedalus_smoke_"]
	};
	const allowed: ApprovalCandidate = {
		approvalId: "approval-1",
		toolName: "mcp_godot_create_text_file",
		risk: "write",
		args: { resourcePath: "res://scripts/daedalus_smoke_plan.gd" }
	};
	const unknownTool: ApprovalCandidate = {
		approvalId: "approval-2",
		toolName: "mcp_godot_delete_file",
		risk: "write",
		args: { resourcePath: "scripts/daedalus_smoke_plan.gd" }
	};
	const outOfScope: ApprovalCandidate = {
		approvalId: "approval-3",
		toolName: "mcp_godot_create_text_file",
		risk: "write",
		args: { resourcePath: "scripts/player.gd" }
	};
	const traversal: ApprovalCandidate = {
		approvalId: "approval-4",
		toolName: "mcp_godot_create_text_file",
		risk: "write",
		args: { resourcePath: "../scripts/daedalus_smoke_plan.gd" }
	};
	const destructive: ApprovalCandidate = {
		approvalId: "approval-5",
		toolName: "mcp_godot_create_text_file",
		risk: "destructive",
		args: { resourcePath: "scripts/daedalus_smoke_plan.gd" }
	};

	assert.equal(isApprovalAllowed(allowed, whitelist), true);
	assert.deepEqual(extractApprovalPaths(allowed), ["scripts/daedalus_smoke_plan.gd"]);
	assert.equal(isApprovalAllowed(unknownTool, whitelist), false);
	assert.equal(isApprovalAllowed(outOfScope, whitelist), false);
	assert.equal(isApprovalAllowed(traversal, whitelist), false);
	assert.equal(isApprovalAllowed(destructive, whitelist), false);
	assert.equal(selectMatchingApproval([outOfScope, allowed], whitelist)?.approvalId, "approval-1");
});

test("automation result redaction removes secret-like values", (): void => {
	const redacted = redactAutomationResult({
		provider: {
			apiKey: "sk-live-secret",
			nested: {
				Authorization: "Bearer token",
				model: "deepseek-v4-pro"
			}
		},
		normal: "visible"
	});

	assert.deepEqual(redacted, {
		provider: {
			apiKey: "[redacted]",
			nested: {
				Authorization: "[redacted]",
				model: "deepseek-v4-pro"
			}
		},
		normal: "visible"
	});
});

test("automation RPC client sends hello, waits for events and times out predictably", async (): Promise<void> => {
	const server = new WebSocketServer({ port: 0 });
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	const backendUrl = `ws://127.0.0.1:${address.port}`;
	const receivedMethods: string[] = [];
	const receivedProtocolVersions: number[] = [];

	server.on("connection", (socket: WebSocket): void => {
		socket.on("message", (raw: Buffer): void => {
			const request = JSON.parse(raw.toString()) as { protocolVersion: number; id: string; method: string; params?: unknown };
			receivedMethods.push(request.method);
			receivedProtocolVersions.push(request.protocolVersion);
			if (request.method === "ai.chat") {
				socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { accepted: true } }));
				setTimeout((): void => {
					socket.send(JSON.stringify({
						type: "event",
						event: "plan.generated",
						requestId: request.id,
						data: {
							planId: "plan-smoke"
						}
					}));
				}, 10);
				return;
			}
			socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { method: request.method } }));
		});
	});

	const config = createAutomationConfig({
		DAEDALUS_AUTOMATION_MCP: "1",
		DAEDALUS_AUTOMATION_BACKEND_URL: backendUrl
	}, []);
	const client = new AutomationRpcClient(config);
	try {
		const requestId = await client.sendRequestNoWait("ai.chat", { message: "plan", mode: "plan" });
		const event = await client.waitForEvent({
			eventName: "plan.generated",
			requestId,
			planId: "plan-smoke",
			timeoutMs: 1000
		});
		assert.equal(event.raw.event, "plan.generated");
		assert.ok(receivedMethods.includes("client.hello"));
		assert.ok(receivedMethods.includes("ai.chat"));
		assert.ok(receivedProtocolVersions.length > 0);
		assert.ok(receivedProtocolVersions.every((version: number): boolean => version === 3));

		await assert.rejects(
			client.waitForEvent({ eventName: "never.happens", timeoutMs: 20 }),
			/Timed out waiting for event/
		);
	} finally {
		await client.close();
		await new Promise<void>((resolve): void => server.close((): void => resolve()));
	}
});

test("automation RPC client waits for run idle and detects failed assistant timeline block", async (): Promise<void> => {
	const server = new WebSocketServer({ port: 0 });
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	const backendUrl = `ws://127.0.0.1:${address.port}`;

	server.on("connection", (socket: WebSocket): void => {
		socket.on("message", (raw: Buffer): void => {
			const request = JSON.parse(raw.toString()) as { id: string; method: string; params?: unknown };
			if (request.method === "client.hello") {
				socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { accepted: true } }));
				setTimeout((): void => {
					socket.send(JSON.stringify({
						type: "event",
						event: "session.workbench.updated",
						requestId: "run-1",
						data: {
							workbench: {
								sessionId: "session-smoke",
								revision: 2,
								activeRun: {
									status: "streaming",
									requestId: "run-1"
								}
							}
						}
					}));
				}, 10);
				setTimeout((): void => {
					socket.send(JSON.stringify({
						type: "event",
						event: "session.workbench.updated",
						requestId: "run-1",
						data: {
							workbench: {
								sessionId: "session-smoke",
								revision: 3,
								activeRun: {
									status: "idle"
								}
							}
						}
					}));
				}, 20);
				return;
			}
			if (request.method === "session.timeline") {
				socket.send(JSON.stringify({
					type: "response",
					id: request.id,
					ok: true,
					result: {
						sessionId: "session-smoke",
						timelineBlocks: [{
							id: "assistant-run-1",
							type: "assistant",
							requestId: "run-1",
							content: "Backend returned error",
							status: "failed",
							bodyParts: [{
								type: "status",
								status: "error",
								code: "provider_error",
								title: "Provider error",
								details: "LLM returned empty response"
							}]
						}]
					}
				}));
				return;
			}
			socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { method: request.method } }));
		});
	});

	const config = createAutomationConfig({
		DAEDALUS_AUTOMATION_MCP: "1",
		DAEDALUS_AUTOMATION_BACKEND_URL: backendUrl
	}, []);
	const client = new AutomationRpcClient(config);
	try {
		const result = await client.waitForRun({
			requestId: "run-1",
			timeoutMs: 1000,
			includeTimeline: true
		});
		assert.equal(result.completed, false);
		assert.equal(result.failed, true);
		assert.equal(result.activeRunStatus, "idle");
		assert.equal(result.finalWorkbenchRevision, 3);
		assert.equal(result.assistantStatus, "failed");
		assert.equal(result.errorStatuses.some((status): boolean => status.code === "provider_error"), true);
		assert.equal(result.timelineBlocks?.length, 1);
	} finally {
		await client.close();
		await new Promise<void>((resolve): void => server.close((): void => resolve()));
	}
});
