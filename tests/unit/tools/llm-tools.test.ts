import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	getToolDefinitions,
	getToolDefinitionsForNames
} from "../../../src/tools/builtin-tool-definitions.js";
import {
	getDynamicMcpToolMetadata,
	getPlanSafeDynamicMcpToolNames,
	isPlanSafeDynamicMcpToolName,
	clearGlobalDynamicMcpTools,
	clearDynamicMcpToolsForWorkspace,
	replaceGlobalDynamicMcpTools,
	replaceDynamicMcpToolsForWorkspace
} from "../../../src/tools/dynamic-mcp-tools.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../../../src/tools/tool-sentinels.js";
import { resolveToolMapping } from "../../../src/tools/tool-mapping.js";

type FunctionTool = ReturnType<typeof getToolDefinitions>[number] & {
	type: "function";
	function: {
		name: string;
		parameters?: unknown;
	};
};

const WORKSPACE_ID: string = "llm-tools-workspace";

afterEach((): void => {
	clearGlobalDynamicMcpTools();
	clearDynamicMcpToolsForWorkspace(WORKSPACE_ID);
});

function isFunctionTool(tool: ReturnType<typeof getToolDefinitions>[number]): tool is FunctionTool {
	return tool.type === "function" && "function" in tool;
}

function getToolNames(workspaceId?: string | undefined): string[] {
	return getToolDefinitions(workspaceId)
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
}

function getToolProperties(toolName: string, workspaceId?: string | undefined): Record<string, unknown> {
	const tool: FunctionTool | undefined = getToolDefinitionsForNames([toolName], workspaceId)
		.filter(isFunctionTool)
		.find((item: FunctionTool): boolean => item.function.name === toolName);
	assert.notEqual(tool, undefined);
	const parameters: unknown = tool?.function.parameters;
	assert.equal(typeof parameters, "object");
	assert.notEqual(parameters, null);
	const properties: unknown = (parameters as Record<string, unknown>).properties;
	assert.equal(typeof properties, "object");
	assert.notEqual(properties, null);
	return properties as Record<string, unknown>;
}

test("builtin tool definitions expose representative Godot tools", (): void => {
	const names: string[] = getToolNames();

	assert.ok(names.includes("mcp_godot_read_text_file"));
	assert.ok(names.includes("mcp_godot_propose_replace_text_in_file"));
	assert.ok(names.includes("mcp_godot_apply_scene_patch"));
	assert.ok(names.includes("mcp_godot_audit_project_health"));
	assert.ok(names.includes("mcp_godot_get_import_metadata"));
	assert.ok(names.includes("mcp_terminal_get_job_status"));
	assert.ok(names.includes("mcp_terminal_cancel_job"));
	assert.ok(names.includes("mcp_web_search"));
});

test("approval-gated write tools expose approval reason metadata", (): void => {
	assert.ok("approvalReason" in getToolProperties("mcp_godot_create_text_file"));
	assert.ok("approvalReason" in getToolProperties("mcp_godot_create_scene"));
	assert.ok("approvalReason" in getToolProperties("mcp_godot_delete_file"));
	assert.equal("approvalReason" in getToolProperties("mcp_godot_read_text_file"), false);
	assert.equal("approvalReason" in getToolProperties("mcp_godot_propose_create_text_file"), false);
	assert.equal("approvalReason" in getToolProperties("mcp_godot_propose_create_scene"), false);
});

test("dynamic MCP tools are included only through the custom sentinel", (): void => {
	replaceDynamicMcpToolsForWorkspace(WORKSPACE_ID, [
		{
			serverId: "custom-server",
			serverName: "Custom Server",
			toolName: "make_level",
			description: "创建测试关卡",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string" }
				},
				required: ["name"]
			}
		}
	]);

	const withoutSentinel: string[] = getToolDefinitionsForNames(["mcp_godot_read_text_file"], WORKSPACE_ID)
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
	const withSentinel: string[] = getToolDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL], WORKSPACE_ID)
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
	const dynamicName: string | undefined = withSentinel.find((name: string): boolean => name.startsWith("mcp_custom_"));

	assert.deepEqual(withoutSentinel, ["mcp_godot_read_text_file"]);
	assert.notEqual(dynamicName, undefined);
	assert.equal(getDynamicMcpToolMetadata(dynamicName ?? "", WORKSPACE_ID)?.toolName, "make_level");
});

test("global dynamic MCP tools are available without workspace", (): void => {
	replaceGlobalDynamicMcpTools([
		{
			serverId: "context7",
			serverName: "context7",
			toolName: "get-library-docs",
			description: "Fetch current library documentation"
		}
	]);

	const dynamicNames: string[] = getToolDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL])
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
	const contextName: string | undefined = dynamicNames.find((name: string): boolean => name.startsWith("mcp_custom_context7"));

	assert.notEqual(contextName, undefined);
	assert.deepEqual(resolveToolMapping(contextName ?? ""), {
		serverId: "context7",
		toolName: "get-library-docs"
	});
	assert.equal(getDynamicMcpToolMetadata(contextName ?? "")?.serverId, "context7");
});

test("workspace dynamic MCP tools include global tools", (): void => {
	replaceGlobalDynamicMcpTools([
		{
			serverId: "context7",
			serverName: "context7",
			toolName: "get-library-docs"
		}
	]);
	replaceDynamicMcpToolsForWorkspace(WORKSPACE_ID, [
		{
			serverId: "workspace-local",
			serverName: "Workspace Local",
			toolName: "inspect"
		}
	]);

	const dynamicNames: string[] = getToolDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL], WORKSPACE_ID)
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);

	assert.equal(dynamicNames.some((name: string): boolean => getDynamicMcpToolMetadata(name, WORKSPACE_ID)?.serverId === "context7"), true);
	assert.equal(dynamicNames.some((name: string): boolean => getDynamicMcpToolMetadata(name, WORKSPACE_ID)?.serverId === "workspace-local"), true);
});

test("tool mapping resolves builtin and dynamic tools", (): void => {
	assert.deepEqual(resolveToolMapping("mcp_godot_read_text_file"), {
		serverId: "godot",
		toolName: "read_text_file"
	});
	assert.deepEqual(resolveToolMapping("mcp_godot_audit_project_health"), {
		serverId: "godot",
		toolName: "audit_project_health"
	});
	assert.deepEqual(resolveToolMapping("mcp_godot_search_documentation"), {
		serverId: "godot_documentation",
		toolName: "search_documentation"
	});
	assert.deepEqual(resolveToolMapping("mcp_terminal_get_job_status"), {
		serverId: "terminal",
		toolName: "get_terminal_job_status"
	});
	assert.deepEqual(resolveToolMapping("mcp_web_search"), {
		serverId: "web_search",
		toolName: "search"
	});

	replaceDynamicMcpToolsForWorkspace(WORKSPACE_ID, [
		{
			serverId: "external",
			serverName: "External",
			toolName: "write_asset"
		}
	]);

	const dynamicName: string | undefined = getToolDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL], WORKSPACE_ID)
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name)
		.find((name: string): boolean => name.startsWith("mcp_custom_"));

	assert.notEqual(dynamicName, undefined);
	assert.deepEqual(resolveToolMapping(dynamicName ?? "", WORKSPACE_ID), {
		serverId: "external",
		toolName: "write_asset"
	});
});

test("dynamic MCP tools expose plan-safe metadata only when explicitly marked read", (): void => {
	replaceDynamicMcpToolsForWorkspace(WORKSPACE_ID, [
		{
			serverId: "context7",
			serverName: "context7",
			toolName: "resolve-library-id",
			planAccess: "read"
		},
		{
			serverId: "writer",
			serverName: "Writer",
			toolName: "write_file"
		}
	]);

	const dynamicNames: string[] = getToolDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL], WORKSPACE_ID)
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
	const planSafeNames: string[] = getPlanSafeDynamicMcpToolNames(WORKSPACE_ID);
	const contextName: string | undefined = dynamicNames.find((name: string): boolean => getDynamicMcpToolMetadata(name, WORKSPACE_ID)?.serverId === "context7");
	const writerName: string | undefined = dynamicNames.find((name: string): boolean => getDynamicMcpToolMetadata(name, WORKSPACE_ID)?.serverId === "writer");

	assert.notEqual(contextName, undefined);
	assert.notEqual(writerName, undefined);
	assert.deepEqual(planSafeNames, [contextName]);
	assert.equal(isPlanSafeDynamicMcpToolName(contextName ?? "", WORKSPACE_ID), true);
	assert.equal(isPlanSafeDynamicMcpToolName(writerName ?? "", WORKSPACE_ID), false);
});
