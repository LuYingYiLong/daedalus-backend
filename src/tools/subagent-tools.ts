import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const SUBAGENT_SPAWN_TOOL_NAME = "daedalus_subagent_spawn" as const;
export const SUBAGENT_WAIT_TOOL_NAME = "daedalus_subagent_wait" as const;
export const SUBAGENT_STATUS_TOOL_NAME = "daedalus_subagent_status" as const;
export const SUBAGENT_CANCEL_TOOL_NAME = "daedalus_subagent_cancel" as const;
export const SUBAGENT_MERGE_PREVIEW_TOOL_NAME = "daedalus_subagent_merge_preview" as const;

export const SUBAGENT_TOOL_NAMES = [
	SUBAGENT_SPAWN_TOOL_NAME,
	SUBAGENT_WAIT_TOOL_NAME,
	SUBAGENT_STATUS_TOOL_NAME,
	SUBAGENT_CANCEL_TOOL_NAME,
	SUBAGENT_MERGE_PREVIEW_TOOL_NAME
] as const;

export type SubagentToolName = typeof SUBAGENT_TOOL_NAMES[number];

export const SUBAGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(SUBAGENT_TOOL_NAMES);

/** 仅注入可编排子图的父 Agent run，子 Agent 不获得此边界。 */
export type SubagentControlContext = {
	execute(
		toolName: SubagentToolName,
		args: Record<string, unknown>,
		abortSignal?: AbortSignal | undefined
	): Promise<Record<string, unknown>>;
};

const NODE_ID_SCHEMA: Record<string, unknown> = {
	type: "string",
	minLength: 1,
	description: "Stable node id unique within the graph. Reuse the same id when retrying an uncertain spawn call."
};

const GRAPH_ID_SCHEMA: Record<string, unknown> = {
	type: "string",
	minLength: 1,
	description: "Subagent graph id returned by daedalus_subagent_spawn."
};

export const SUBAGENT_TOOL_DEFINITIONS: readonly ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: SUBAGENT_SPAWN_TOOL_NAME,
			description: "Create a recoverable subagent graph or append new nodes to an existing graph. Give every node a short human-readable name for the Subagent panel. Dependencies must reference existing nodes or nodes in this request. This changes persisted execution state and remains subject to tool approval.",
			parameters: {
				type: "object",
				properties: {
					graphId: {
						...GRAPH_ID_SCHEMA,
						description: "Existing graph id when appending nodes. Omit to create a graph for the current parent run."
					},
					nodes: {
						type: "array",
						minItems: 1,
						description: "Nodes to create. A node starts only after all dependsOn nodes complete successfully.",
						items: {
							type: "object",
							properties: {
								nodeId: NODE_ID_SCHEMA,
								name: { type: "string", minLength: 1, maxLength: 120, description: "Short human-readable name shown in the Subagent panel." },
								role: {
									type: "string",
									enum: ["researcher", "planner", "implementer", "tester", "reviewer"]
								},
								objective: { type: "string", minLength: 1 },
								dependsOn: {
									type: "array",
									items: NODE_ID_SCHEMA,
									uniqueItems: true,
									default: []
								},
								contextRefs: {
									type: "array",
									items: {
										type: "object",
										properties: {
											kind: { type: "string", enum: ["message", "context_block", "artifact", "source_folder"] },
											id: { type: "string", minLength: 1 }
										},
										required: ["kind", "id"],
										additionalProperties: false
									},
									uniqueItems: true,
									description: "Explicit message, artifact, or prior-result references. The full parent history is not copied automatically."
								},
								toolScope: {
									type: "object",
									properties: {
										capabilities: {
											type: "array",
											items: { type: "string", enum: ["read", "verify", "propose", "write", "destructive", "execute"] },
											uniqueItems: true
										},
										toolNames: {
											type: "array",
											items: { type: "string", minLength: 1 },
											uniqueItems: true
										},
										sourceFolderIds: {
											type: "array",
											items: { type: "string", minLength: 1 },
											uniqueItems: true
										}
									},
									required: ["capabilities", "toolNames", "sourceFolderIds"],
									additionalProperties: false,
									description: "Explicit child capabilities, tool allowlist, and visible source folders. Role policy may narrow this scope further."
								},
								workspaceMode: {
									type: "string",
									enum: ["shared_read_only", "managed_worktree"],
									description: "Implementer nodes require managed_worktree; non-writing roles normally use shared_read_only."
								},
								retryPolicy: {
									type: "object",
									properties: {
										mode: { type: "string", enum: ["transient_only"] },
										maxRetries: { type: "integer", minimum: 0, maximum: 3, default: 1 }
									},
									required: ["mode", "maxRetries"],
									additionalProperties: false,
									description: "Optional automatic retry policy. Defaults to one retry for transient provider errors; writing nodes never auto-retry."
								}
							},
							required: ["nodeId", "name", "role", "objective", "toolScope", "workspaceMode"],
							additionalProperties: false
						}
					}
				},
				required: ["nodes"],
				additionalProperties: false
			}
		}
	},
	{
		type: "function",
		function: {
			name: SUBAGENT_WAIT_TOOL_NAME,
			description: "Wait for selected subagent nodes or the whole graph to change or reach a terminal state, then return a structured snapshot.",
			parameters: {
				type: "object",
				properties: {
					graphId: GRAPH_ID_SCHEMA,
					nodeIds: { type: "array", items: NODE_ID_SCHEMA, uniqueItems: true },
					afterRevision: { type: "integer", minimum: 0, description: "Return only after the graph revision exceeds this value, or the wait times out." },
					timeoutMs: { type: "integer", minimum: 0, maximum: 60000, description: "Bounded wait duration. Defaults to the runtime's safe value." }
				},
				required: ["graphId"],
				additionalProperties: false
			}
		}
	},
	{
		type: "function",
		function: {
			name: SUBAGENT_STATUS_TOOL_NAME,
			description: "Read a subagent graph snapshot, including node, result, approval, and merge state visible to the parent run.",
			parameters: {
				type: "object",
				properties: {
					graphId: GRAPH_ID_SCHEMA,
					nodeIds: { type: "array", items: NODE_ID_SCHEMA, uniqueItems: true },
					includeResults: { type: "boolean", default: true }
				},
				required: ["graphId"],
				additionalProperties: false
			}
		}
	},
	{
		type: "function",
		function: {
			name: SUBAGENT_CANCEL_TOOL_NAME,
			description: "Cancel selected subagent nodes, or cancel the whole graph when nodeIds is omitted. Independent completed nodes are retained. This is a destructive execution-state change and requires approval under the active policy.",
			parameters: {
				type: "object",
				properties: {
					graphId: GRAPH_ID_SCHEMA,
					nodeIds: { type: "array", minItems: 1, items: NODE_ID_SCHEMA, uniqueItems: true },
					reason: { type: "string", minLength: 1, description: "Why cancellation is required." }
				},
				required: ["graphId", "reason"],
				additionalProperties: false
			}
		}
	},
	{
		type: "function",
		function: {
			name: SUBAGENT_MERGE_PREVIEW_TOOL_NAME,
			description: "Preview a completed managed-worktree node's diff and merge conflicts. This never applies the merge or changes the parent workspace.",
			parameters: {
				type: "object",
				properties: {
					graphId: GRAPH_ID_SCHEMA,
					nodeId: NODE_ID_SCHEMA
				},
				required: ["graphId", "nodeId"],
				additionalProperties: false
			}
		}
	}
];
