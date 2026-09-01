import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { clearDynamicMcpToolsForWorkspace, clearGlobalDynamicMcpTools, replaceDynamicMcpToolsForWorkspace, replaceGlobalDynamicMcpTools } from "../../../src/tools/dynamic-mcp-tools.js";
import { createWorkspaceToolCatalog } from "../../../src/tools/tool-catalog.js";
import { filterToolNamesForWorkspace, getDefaultWorkflowToolNames, getNoWorkspaceToolNames } from "../../../src/tools/tool-catalog.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../../../src/tools/tool-sentinels.js";
import { EXECUTION_CONTROL_TOOL_NAME } from "../../../src/tools/execution-control.js";
import { CHAT_COMPLETION_CONTROL_TOOL_NAME } from "../../../src/tools/chat-completion-control.js";
import { CONTEXT_CONTROL_TOOL_NAMES, type ContextControlContext } from "../../../src/tools/context-control.js";
import { godotRuntimeTestBridge } from "../../../src/mcp/godot/bridges/runtime-test-bridge.js";

function getFunctionToolName(tool: { type: string; function?: { name: string } | undefined }): string {
	assert.equal(tool.type, "function");
	const functionDefinition: { name: string } | undefined = tool.function;
	assert.notEqual(functionDefinition, undefined);
	if (functionDefinition === undefined) {
		throw new Error("Expected a function tool");
	}
	return functionDefinition.name;
}

function getFunctionToolProperties(tool: { type: string; function?: { parameters?: unknown } | undefined }): Record<string, unknown> {
	assert.equal(tool.type, "function");
	const parameters: unknown = tool.function?.parameters;
	assert.equal(typeof parameters, "object");
	assert.notEqual(parameters, null);
	const properties: unknown = (parameters as Record<string, unknown>).properties;
	assert.equal(typeof properties, "object");
	assert.notEqual(properties, null);
	return properties as Record<string, unknown>;
}

test("workspace tool catalog keeps dynamic MCP definitions isolated", (): void => {
	replaceDynamicMcpToolsForWorkspace("catalog-a", [{
		serverId: "a",
		serverName: "Catalog A",
		toolName: "inspect",
		planAccess: "read"
	}]);
	replaceDynamicMcpToolsForWorkspace("catalog-b", [{
		serverId: "b",
		serverName: "Catalog B",
		toolName: "mutate"
	}]);

	try {
		const catalogA = createWorkspaceToolCatalog({ workspaceId: "catalog-a" });
		const catalogB = createWorkspaceToolCatalog({ workspaceId: "catalog-b" });
		const dynamicA = catalogA.getDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL]);
		const dynamicB = catalogB.getDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL]);
		const nameA: string = getFunctionToolName(dynamicA[0]!);
		const nameB: string = getFunctionToolName(dynamicB[0]!);

		assert.notEqual(nameA, nameB);
		assert.deepEqual(catalogA.resolveMapping(nameA), { serverId: "a", toolName: "inspect" });
		assert.equal(catalogA.getPolicy(nameA)?.risk, "write");
		assert.equal(catalogA.getToolNamesForPhase("read").includes(nameA), true);
		assert.equal(catalogB.getEntry(nameA), undefined);
	} finally {
		clearDynamicMcpToolsForWorkspace("catalog-a");
		clearDynamicMcpToolsForWorkspace("catalog-b");
	}
});

test("workspace tool catalog keeps builtin metadata complete", (): void => {
	const catalog = createWorkspaceToolCatalog({ workspaceId: "workspace-a", hasGodotWorkspaceCapability: true });
	const sceneCapture = catalog.getEntry("mcp_godot_editor_capture_scene_view");
	const healthAudit = catalog.getEntry("mcp_godot_audit_project_health");
	assert.deepEqual(sceneCapture?.mapping, { serverId: "godot_editor", toolName: "capture_scene_view" });
	assert.equal(sceneCapture?.policy.risk, "read");
	assert.equal(sceneCapture?.capabilityRequirement, "sceneViewCapture");
	assert.deepEqual(healthAudit?.mapping, { serverId: "godot", toolName: "audit_project_health" });
	assert.equal(healthAudit?.policy.risk, "read");
	assert.equal(catalog.getToolNamesForPhase("read").includes("mcp_godot_audit_project_health"), true);
});

test("Godot runtime test write tools are exposed only to Studio Agent mode", (): void => {
	const owner = { readyState: WebSocket.OPEN, send(): void {}, close(): void {} } as unknown as WebSocket;
	const runtime = { readyState: WebSocket.OPEN, send(): void {}, close(): void {} } as unknown as WebSocket;
	const runtimeSession = godotRuntimeTestBridge.createSession(owner, "workspace-a:source", "C:/fixture/project", "workspace-a");
	godotRuntimeTestBridge.attachRuntime(runtime, {
		testSessionId: runtimeSession.testSessionId,
		testSessionToken: runtimeSession.token,
		runtimeInstanceId: "runtime-one",
		workspaceRoot: "C:/fixture/project",
	});
	godotRuntimeTestBridge.heartbeat(runtime, { testSessionId: runtimeSession.testSessionId, runtimeInstanceId: "runtime-one", treeRevision: 1 });
	const base = {
		workspaceId: "workspace-a",
		hasGodotWorkspaceCapability: true,
		clientType: "studio" as const,
		godotRuntimeControl: { start: async (): Promise<Record<string, unknown>> => ({ online: true }) },
	};
	const ask = createWorkspaceToolCatalog({ ...base, hookContext: { model: "fixture", approvalMode: "manual" as const, chatMode: "ask" as const } });
	const plan = createWorkspaceToolCatalog({ ...base, hookContext: { model: "fixture", approvalMode: "manual" as const, chatMode: "plan" as const } });
	const agent = createWorkspaceToolCatalog({ ...base, hookContext: { model: "fixture", approvalMode: "manual" as const, chatMode: "agent" as const } });
	const remote = createWorkspaceToolCatalog({ ...base, clientType: "studio_remote" as const, hookContext: { model: "fixture", approvalMode: "manual" as const, chatMode: "agent" as const } });

	try {
		assert.notEqual(ask.getEntry("mcp_godot_runtime_status"), undefined);
		assert.equal(ask.getEntry("mcp_godot_runtime_start"), undefined);
		assert.notEqual(ask.getEntry("mcp_godot_runtime_observe"), undefined);
		assert.equal(ask.getEntry("mcp_godot_runtime_action"), undefined);
		assert.equal(plan.getEntry("mcp_godot_runtime_action"), undefined);
		assert.notEqual(agent.getEntry("mcp_godot_runtime_action"), undefined);
		assert.notEqual(agent.getEntry("mcp_godot_runtime_start"), undefined);
		assert.notEqual(agent.getEntry("mcp_godot_runtime_status"), undefined);
		assert.equal(remote.getEntry("mcp_godot_runtime_status"), undefined);
		assert.equal(remote.getEntry("mcp_godot_runtime_start"), undefined);
		assert.equal(remote.getEntry("mcp_godot_runtime_observe"), undefined);
	} finally {
		godotRuntimeTestBridge.stopSession(owner, runtimeSession.testSessionId);
	}
});

test("Godot runtime tools remain discoverable while the visible runtime is offline", (): void => {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: "runtime-offline-workspace",
		hasGodotWorkspaceCapability: true,
		clientType: "studio",
		godotRuntimeControl: { start: async (): Promise<Record<string, unknown>> => ({ online: true }) },
		hookContext: { model: "fixture", approvalMode: "manual", chatMode: "agent" },
	});
	assert.notEqual(catalog.getEntry("mcp_godot_runtime_status"), undefined);
	assert.notEqual(catalog.getEntry("mcp_godot_runtime_start"), undefined);
	assert.notEqual(catalog.getEntry("mcp_godot_runtime_observe"), undefined);
	assert.notEqual(catalog.getEntry("mcp_godot_runtime_action"), undefined);
	assert.notEqual(catalog.getEntry("mcp_godot_runtime_wait"), undefined);
	assert.notEqual(catalog.getEntry("mcp_godot_runtime_assert"), undefined);
	assert.notEqual(catalog.getEntry("mcp_godot_runtime_screenshot"), undefined);
});

test("Godot runtime start remains discoverable when Studio launch capability is unavailable", (): void => {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: "runtime-start-unavailable-workspace",
		hasGodotWorkspaceCapability: true,
		clientType: "studio",
		hookContext: { model: "fixture", approvalMode: "manual", chatMode: "agent" },
	});

	assert.notEqual(catalog.getEntry("mcp_godot_runtime_start"), undefined);
});

test("legacy sandboxed Godot process tools are never exposed to the model", (): void => {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: "workspace-godot",
		hasGodotWorkspaceCapability: true,
		clientType: "studio",
		hookContext: { model: "fixture", approvalMode: "manual", chatMode: "agent" },
	});
	for (const toolName of ["mcp_godot_get_runtime_status", "mcp_godot_launch_editor", "mcp_godot_run_project", "mcp_godot_stop_project"]) {
		assert.equal(catalog.getEntry(toolName), undefined);
		assert.equal(getDefaultWorkflowToolNames("write").includes(toolName), false);
	}
	assert.equal(getDefaultWorkflowToolNames("read").includes("mcp_godot_get_runtime_status"), false);
	assert.equal(getDefaultWorkflowToolNames("read").includes("mcp_godot_runtime_status"), true);
	assert.equal(getDefaultWorkflowToolNames("write").includes("mcp_godot_runtime_start"), true);
});

test("workspace tool catalog exposes approval reason schema for write tools", (): void => {
	replaceDynamicMcpToolsForWorkspace("catalog-approval", [{
		serverId: "writer",
		serverName: "Writer",
		toolName: "write_file",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" }
			},
			required: ["path"]
		}
	}]);

	try {
		const catalog = createWorkspaceToolCatalog({ workspaceId: "catalog-approval", hasGodotWorkspaceCapability: true });
		const createScene = catalog.getDefinitionsForNames(["mcp_godot_create_scene"])[0];
		const readText = catalog.getDefinitionsForNames(["mcp_godot_read_text_file"])[0];
		const dynamicWrite = catalog.getDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL])[0];

		assert.ok("approvalReason" in getFunctionToolProperties(createScene!));
		assert.equal("approvalReason" in getFunctionToolProperties(readText!), false);
		assert.ok("approvalReason" in getFunctionToolProperties(dynamicWrite!));
	} finally {
		clearDynamicMcpToolsForWorkspace("catalog-approval");
	}
});

test("context controls are exposed only when the execution lane enables them", (): void => {
	const contextControl: ContextControlContext = {
		getState: () => ({ schemaVersion: 1, generation: 0, activeSummaryBlockIds: [], compactedToolResultBlockIds: [] }),
		execute: async (): Promise<Record<string, unknown>> => ({ ok: true })
	};
	const disabled = createWorkspaceToolCatalog({ contextControl, contextControlAvailable: false });
	const enabled = createWorkspaceToolCatalog({ contextControl, contextControlAvailable: true });

	for (const toolName of CONTEXT_CONTROL_TOOL_NAMES) {
		assert.equal(disabled.getEntry(toolName), undefined);
		assert.notEqual(enabled.getEntry(toolName), undefined);
	}
});

test("probe discovery defers execution control until evidence has been collected", (): void => {
	const context = {
		workspaceId: "workspace-probe",
		executionControl: { lane: "probe" as const, allowMutationEscalation: true, requireDecision: true }
	};
	const discoveryTools = createWorkspaceToolCatalog({
		...context,
		executionControlAvailable: false
	}).getDefinitionsForNames(["mcp_workspace_read_text_file"]);
	const decisionTools = createWorkspaceToolCatalog(context).getDefinitionsForNames([]);

	assert.equal(discoveryTools.some((tool) => getFunctionToolName(tool) === EXECUTION_CONTROL_TOOL_NAME), false);
	assert.equal(discoveryTools.some((tool) => getFunctionToolName(tool) === "mcp_workspace_read_text_file"), true);
	assert.equal(decisionTools.some((tool) => getFunctionToolName(tool) === EXECUTION_CONTROL_TOOL_NAME), true);
});

test("chat completion control is available only to the structured chat lane", (): void => {
	const chatTools = createWorkspaceToolCatalog({
		workspaceId: "workspace-chat",
		chatCompletion: { requireSubmission: true }
	}).getDefinitionsForNames([]);
	const ordinaryTools = createWorkspaceToolCatalog({ workspaceId: "workspace-chat" }).getDefinitionsForNames([]);

	assert.equal(chatTools.some((tool) => getFunctionToolName(tool) === CHAT_COMPLETION_CONTROL_TOOL_NAME), true);
	assert.equal(ordinaryTools.some((tool) => getFunctionToolName(tool) === CHAT_COMPLETION_CONTROL_TOOL_NAME), false);
});

test("image generation tool accepts custom aspect ratios", (): void => {
	const catalog = createWorkspaceToolCatalog();
	const imageGenerate = catalog.getDefinitionsForNames(["mcp_image_generate"])[0];
	const properties = getFunctionToolProperties(imageGenerate!);
	const aspectRatio = properties.aspectRatio as Record<string, unknown> | undefined;

	assert.equal(aspectRatio?.type, "string");
	assert.equal("enum" in (aspectRatio ?? {}), false);
	assert.match(String(aspectRatio?.description ?? ""), /2:1/u);
});

test("image inspection is a read tool for workspace and session images", (): void => {
	const catalog = createWorkspaceToolCatalog();
	const imageInspect = catalog.getEntry("mcp_image_inspect");
	assert.equal(imageInspect?.policy.risk, "read");
	assert.deepEqual(imageInspect?.phaseEligibility, ["read", "verify", "write"]);
	const properties = getFunctionToolProperties(imageInspect!.definition);
	assert.deepEqual((properties.source as Record<string, unknown>).enum, ["workspace", "session"]);
	assert.equal((properties.relativePath as Record<string, unknown>).type, "string");
	assert.equal((properties.imageId as Record<string, unknown>).type, "string");
});

test("workspace runtime filter hides Godot tools without an active workspace", (): void => {
	const names: string[] = filterToolNamesForWorkspace([
		"mcp_skills_load",
		"mcp_skills_propose_create",
		"mcp_skills_create",
		"mcp_godot_get_runtime_status",
		"mcp_godot_search_documentation",
		"mcp_image_generate",
		"mcp_image_inspect",
		"mcp_plugin_dev_prepare",
		"mcp_plugin_dev_apply",
		"mcp_plugin_dev_validate",
		"mcp_plugin_dev_install",
		"mcp_plugin_dev_test",
		"mcp_scheduled_task_create",
		"mcp_scheduled_task_delete",
		"mcp_scheduled_task_pause",
		"mcp_scheduled_task_report",
		"mcp_scheduled_task_resume",
		"mcp_scheduled_task_update",
		"mcp_scheduled_tasks_list",
		"mcp_web_search",
		CUSTOM_MCP_TOOLS_SENTINEL,
		"mcp_custom_context7_get_library_docs_12345678"
	], undefined).sort();
	assert.deepEqual(names, [
		"mcp_custom_context7_get_library_docs_12345678",
		"mcp_image_generate",
		"mcp_image_inspect",
		"mcp_godot_search_documentation",
		"mcp_plugin_dev_prepare",
		"mcp_plugin_dev_apply",
		"mcp_plugin_dev_validate",
		"mcp_plugin_dev_install",
		"mcp_plugin_dev_test",
		"mcp_scheduled_task_create",
		"mcp_scheduled_task_delete",
		"mcp_scheduled_task_pause",
		"mcp_scheduled_task_report",
		"mcp_scheduled_task_resume",
		"mcp_scheduled_task_update",
		"mcp_scheduled_tasks_list",
		"mcp_skills_create",
		"mcp_skills_load",
		"mcp_skills_propose_create",
		"mcp_web_search",
		CUSTOM_MCP_TOOLS_SENTINEL
	].sort());
	assert.deepEqual(getNoWorkspaceToolNames().sort(), [
		"mcp_browser_connect",
		"mcp_browser_propose",
		"mcp_browser_execute_step",
		"mcp_computer_request_access",
		"mcp_computer_observe",
		"mcp_computer_locate",
		"mcp_computer_screenshot",
		"mcp_computer_action",
		"mcp_browser_observe",
		"mcp_browser_navigate",
		"mcp_browser_navigation",
		"mcp_browser_scroll",
		"mcp_browser_wait",
		"mcp_browser_screenshot",
		"mcp_browser_click",
		"mcp_browser_type",
		"mcp_browser_select",
		"mcp_godot_search_documentation",
		"mcp_image_generate",
		"mcp_image_inspect",
		"mcp_plugin_dev_prepare",
		"mcp_plugin_dev_apply",
		"mcp_plugin_dev_validate",
		"mcp_plugin_dev_install",
		"mcp_plugin_dev_test",
		"mcp_scheduled_task_create",
		"mcp_scheduled_task_delete",
		"mcp_scheduled_task_pause",
		"mcp_scheduled_task_report",
		"mcp_scheduled_task_resume",
		"mcp_scheduled_task_update",
		"mcp_scheduled_tasks_list",
		"mcp_skills_create",
		"mcp_skills_load",
		"mcp_skills_propose_create",
		"mcp_web_search",
		CUSTOM_MCP_TOOLS_SENTINEL
	].sort());
	assert.deepEqual(filterToolNamesForWorkspace(getDefaultWorkflowToolNames("write"), undefined).sort(), [
		"mcp_browser_execute_step",
		"mcp_computer_action",
		"mcp_browser_click",
		"mcp_browser_select",
		"mcp_browser_type",
		"mcp_image_generate",
		"mcp_scheduled_task_create",
		"mcp_scheduled_task_delete",
		"mcp_scheduled_task_pause",
		"mcp_scheduled_task_resume",
		"mcp_scheduled_task_update",
	].sort());
});

test("workspace tool catalog hides every Godot tool for a non-Godot workspace", (): void => {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: "workspace-web",
		hasGodotWorkspaceCapability: false
	});
	const names: string[] = catalog.getEntries().map((entry) => entry.id);

	assert.equal(names.some((name: string): boolean => name.startsWith("mcp_godot_")), false);
	assert.notEqual(catalog.getEntry("mcp_workspace_read_text_file"), undefined);
	assert.notEqual(catalog.getEntry("mcp_terminal_run_command"), undefined);
});

test("workspace tool catalog exposes Godot tools only when the workspace capability is present", (): void => {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: "workspace-godot",
		hasGodotWorkspaceCapability: true
	});

	assert.notEqual(catalog.getEntry("mcp_godot_read_text_file"), undefined);
	assert.notEqual(catalog.getEntry("mcp_godot_inspect_scene_tree"), undefined);
});

test("workspace tool catalog exposes global dynamic MCP tools without workspace", (): void => {
	replaceGlobalDynamicMcpTools([{
		serverId: "context7",
		serverName: "context7",
		toolName: "get-library-docs",
		planAccess: "read"
	}]);

	try {
		const catalog = createWorkspaceToolCatalog();
		const dynamicTools = catalog.getDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL]);
		const toolName: string = getFunctionToolName(dynamicTools[0]!);

		assert.match(toolName, /^mcp_custom_context7_/u);
		assert.deepEqual(catalog.resolveMapping(toolName), { serverId: "context7", toolName: "get-library-docs" });
		assert.equal(catalog.getToolNamesForPhase("read").includes(toolName), true);
	} finally {
		clearGlobalDynamicMcpTools();
	}
});

test("workflow defaults are catalog-backed and resolve to known tools", (): void => {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: "workspace-a",
		hasGodotWorkspaceCapability: true,
		clientType: "studio",
		scheduledTaskControl: { execute: async (): Promise<Record<string, unknown>> => ({}) },
		scheduledMonitorRun: true,
		browserControl: { execute: async (): Promise<Record<string, unknown>> => ({}) }
	});
	for (const group of ["read", "verify", "write"] as const) {
		for (const toolName of getDefaultWorkflowToolNames(group)) {
			if (["mcp_browser_connect", "mcp_browser_propose", "mcp_browser_execute_step"].includes(toolName)) { assert.equal(catalog.getEntry(toolName), undefined, "Scheduled monitors cannot access external tabs"); continue; }
			if (toolName.startsWith("mcp_computer_")) {
				assert.equal(catalog.getEntry(toolName), undefined, "Scheduled monitors cannot observe the desktop");
				continue;
			}
			if (toolName.startsWith("mcp_godot_runtime_")) {
				assert.equal(catalog.getEntry(toolName), undefined, "Scheduled monitors cannot operate a Godot runtime test session");
				continue;
			}
			if (toolName === CUSTOM_MCP_TOOLS_SENTINEL) {
				continue;
			}
			if (toolName === "mcp_godot_search_documentation" && catalog.getEntry(toolName) === undefined) {
				continue;
			}
			assert.notEqual(catalog.getEntry(toolName), undefined, `${group} tool is missing from catalog: ${toolName}`);
		}
	}
});

test("terminal capability discovery is not a workflow verification tool", (): void => {
	assert.equal(getDefaultWorkflowToolNames("verify").includes("mcp_terminal_get_capabilities"), false);
});
