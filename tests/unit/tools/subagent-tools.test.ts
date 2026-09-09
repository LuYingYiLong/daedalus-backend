import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionMessageToolCall, ChatCompletionTool } from "openai/resources/chat/completions";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { normalizeKnownToolName } from "../../../src/providers/deepseek-loose-tools.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";
import { getToolDefinitionsForNames } from "../../../src/tools/builtin-tool-definitions.js";
import {
	SUBAGENT_CANCEL_TOOL_NAME,
	SUBAGENT_MERGE_PREVIEW_TOOL_NAME,
	SUBAGENT_SPAWN_TOOL_NAME,
	SUBAGENT_STATUS_TOOL_NAME,
	SUBAGENT_TOOL_NAMES,
	SUBAGENT_WAIT_TOOL_NAME,
	type SubagentToolName
} from "../../../src/tools/subagent-tools.js";
import { createWorkspaceToolCatalog } from "../../../src/tools/tool-catalog.js";
import { dispatchToolCalls } from "../../../src/tools/tool-dispatcher.js";
import { describeToolEvent } from "../../../src/tools/tool-event-describer.js";
import { resolveToolMapping } from "../../../src/tools/tool-mapping.js";
import { evaluateToolCall, getToolPolicy } from "../../../src/tools/tool-policy.js";

function getFunctionParameters(tool: ChatCompletionTool | undefined): Record<string, unknown> {
	assert.equal(tool?.type, "function");
	const parameters: unknown = tool?.type === "function" ? tool.function.parameters : undefined;
	assert.equal(typeof parameters, "object");
	assert.notEqual(parameters, null);
	return parameters as Record<string, unknown>;
}

function toolCall(name: SubagentToolName, args: Record<string, unknown>): ChatCompletionMessageToolCall {
	return {
		id: `call-${name}`,
		type: "function",
		function: { name, arguments: JSON.stringify(args) }
	};
}

test("subagent definitions expose strict graph orchestration schemas", (): void => {
	const definitions = getToolDefinitionsForNames(SUBAGENT_TOOL_NAMES);
	assert.equal(definitions.length, SUBAGENT_TOOL_NAMES.length);

	const spawn = definitions.find((tool): boolean => tool.type === "function" && tool.function.name === SUBAGENT_SPAWN_TOOL_NAME);
	const spawnParameters = getFunctionParameters(spawn);
	assert.deepEqual(spawnParameters.required, ["nodes"]);
	assert.equal(spawnParameters.additionalProperties, false);
	const spawnProperties = spawnParameters.properties as Record<string, Record<string, unknown>>;
	const nodeItems = spawnProperties.nodes?.items as Record<string, unknown>;
	assert.deepEqual(nodeItems.required, ["nodeId", "name", "role", "objective", "toolScope", "workspaceMode"]);
	assert.equal(nodeItems.additionalProperties, false);
	const nodeProperties = nodeItems.properties as Record<string, Record<string, unknown>>;
	assert.deepEqual(nodeProperties.workspaceMode?.enum, ["shared_read_only", "managed_worktree"]);
	assert.equal(nodeProperties.toolScope?.type, "object");
	assert.equal(nodeProperties.contextRefs?.type, "array");

	const cancel = definitions.find((tool): boolean => tool.type === "function" && tool.function.name === SUBAGENT_CANCEL_TOOL_NAME);
	const cancelProperties = (getFunctionParameters(cancel).properties ?? {}) as Record<string, unknown>;
	assert.ok("approvalReason" in cancelProperties);
	assert.ok("approvalReason" in spawnProperties);

	const preview = definitions.find((tool): boolean => tool.type === "function" && tool.function.name === SUBAGENT_MERGE_PREVIEW_TOOL_NAME);
	const previewProperties = (getFunctionParameters(preview).properties ?? {}) as Record<string, unknown>;
	assert.equal("approvalReason" in previewProperties, false);
});

test("subagent catalog entries are visible only when a parent runtime adapter is present", (): void => {
	const unavailable = createWorkspaceToolCatalog({ workspaceId: "workspace-a" });
	for (const name of SUBAGENT_TOOL_NAMES) assert.equal(unavailable.getEntry(name), undefined);

	const available = createWorkspaceToolCatalog({
		workspaceId: "workspace-a",
		subagentControl: { execute: async (): Promise<Record<string, unknown>> => ({ ok: true }) }
	});
	for (const name of SUBAGENT_TOOL_NAMES) assert.notEqual(available.getEntry(name), undefined);
	assert.deepEqual(
		available.getDefinitionsForNames([]).map((tool): string => tool.type === "function" ? tool.function.name : ""),
		[...SUBAGENT_TOOL_NAMES]
	);
	assert.deepEqual(available.resolveMapping(SUBAGENT_STATUS_TOOL_NAME), {
		serverId: "internal",
		toolName: "subagent_status"
	});
});

test("subagent policy preserves approval boundaries", (): void => {
	assert.equal(getToolPolicy(SUBAGENT_SPAWN_TOOL_NAME)?.risk, "write");
	assert.equal(getToolPolicy(SUBAGENT_WAIT_TOOL_NAME)?.risk, "read");
	assert.equal(getToolPolicy(SUBAGENT_STATUS_TOOL_NAME)?.risk, "read");
	assert.equal(getToolPolicy(SUBAGENT_CANCEL_TOOL_NAME)?.risk, "destructive");
	assert.equal(getToolPolicy(SUBAGENT_MERGE_PREVIEW_TOOL_NAME)?.risk, "propose");
	assert.equal(evaluateToolCall("manual", SUBAGENT_SPAWN_TOOL_NAME, {}).action, "request_approval");
	assert.equal(evaluateToolCall("auto-safe", SUBAGENT_CANCEL_TOOL_NAME, {}).action, "request_approval");
	assert.equal(evaluateToolCall("manual", SUBAGENT_MERGE_PREVIEW_TOOL_NAME, {}).action, "allow");
});

test("subagent mappings and loose XML aliases resolve to the internal adapter", (): void => {
	assert.deepEqual(resolveToolMapping(SUBAGENT_SPAWN_TOOL_NAME), {
		serverId: "internal",
		toolName: "subagent_spawn"
	});
	assert.equal(normalizeKnownToolName("subagent_spawn"), SUBAGENT_SPAWN_TOOL_NAME);
	assert.equal(normalizeKnownToolName(SUBAGENT_MERGE_PREVIEW_TOOL_NAME), SUBAGENT_MERGE_PREVIEW_TOOL_NAME);
});

test("subagent event descriptions distinguish state changes from reads and previews", (): void => {
	const spawn = describeToolEvent(SUBAGENT_SPAWN_TOOL_NAME, {
		nodes: [{
			nodeId: "research",
			name: "Research",
			role: "researcher",
			objective: "Inspect",
			contextRefs: [],
			toolScope: { capabilities: ["read"], toolNames: [], sourceFolderIds: [] },
			workspaceMode: "shared_read_only"
		}]
	});
	assert.equal(spawn.category, "write");
	assert.equal(spawn.target.label, "research");

	const status = describeToolEvent(SUBAGENT_STATUS_TOOL_NAME, { graphId: "graph-1" });
	assert.equal(status.category, "read");
	assert.equal(status.target.label, "graph-1");

	const preview = describeToolEvent(SUBAGENT_MERGE_PREVIEW_TOOL_NAME, { graphId: "graph-1", nodeId: "implementation" });
	assert.equal(preview.category, "propose");
	assert.equal(preview.target.label, "implementation");
});

test("dispatcher routes subagent tools through the parent runtime adapter", async (): Promise<void> => {
	const calls: Array<{ name: SubagentToolName; args: Record<string, unknown> }> = [];
	const results = await dispatchToolCalls(
		{ getActiveWorkspaceId: (): undefined => undefined } as McpHost,
		[toolCall(SUBAGENT_STATUS_TOOL_NAME, { graphId: "graph-1" })],
		1,
		new ApprovalGateway("full-trust"),
		undefined,
		undefined,
		{
			subagentControl: {
				execute: async (name, args): Promise<Record<string, unknown>> => {
					calls.push({ name, args });
					return { ok: true, graphId: args.graphId };
				}
			}
		}
	);

	assert.deepEqual(calls, [{ name: SUBAGENT_STATUS_TOOL_NAME, args: { graphId: "graph-1" } }]);
	const content: unknown = results[0]?.content;
	assert.equal(typeof content, "string");
	assert.deepEqual(JSON.parse(content as string), { ok: true, graphId: "graph-1" });
});
