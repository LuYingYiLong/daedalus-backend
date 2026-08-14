import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { WorkflowTodoItem, WorkflowTodoSnapshot, WorkflowTodoStatus } from "../workflow/types.js";

export const TODO_CONTROL_RESULT_MARKER = "[[daedalus_todo_control]]";
export const TODO_UPDATE_TOOL_NAME = "daedalus_update_todo_list";

export type AgentTodoStatus = "pending" | "in_progress" | "completed";

export type AgentTodoListInput = {
	title: string;
	items: Array<{
		id: string;
		text: string;
		status: AgentTodoStatus;
	}>;
};

export type TodoControlContext = {
	execute(input: AgentTodoListInput): Promise<Record<string, unknown>>;
};

const todoItemSchema = z.object({
	id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._:-]*$/iu),
	text: z.string().trim().min(1).max(300),
	status: z.enum(["pending", "in_progress", "completed"])
}).strict();

export const agentTodoListInputSchema = z.object({
	title: z.string().trim().min(1).max(200),
	items: z.array(todoItemSchema).min(1).max(12)
}).strict().superRefine((value, context): void => {
	const ids: Set<string> = new Set();
	let inProgressCount: number = 0;
	for (let index: number = 0; index < value.items.length; index += 1) {
		const item = value.items[index]!;
		if (ids.has(item.id)) {
			context.addIssue({
				code: "custom",
				path: ["items", index, "id"],
				message: `Duplicate todo id: ${item.id}`
			});
		}
		ids.add(item.id);
		if (item.status === "in_progress") {
			inProgressCount += 1;
		}
	}
	if (inProgressCount > 1) {
		context.addIssue({
			code: "custom",
			path: ["items"],
			message: "At most one todo item may be in progress."
		});
	}
});

export const TODO_UPDATE_TOOL_DEFINITION: ChatCompletionTool = {
	type: "function",
	function: {
		name: TODO_UPDATE_TOOL_NAME,
		description: "Create or replace the visible Daedalus task list for a genuinely complex free Agent Loop task. When a task has more than three meaningful steps, use this together with the policy-governed workflow read, verify, and write tools while keeping the execution flow flexible. Call it after a visible prose prelude; it is display-only and never grants permissions or determines task completion.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["title", "items"],
			properties: {
				title: { type: "string", minLength: 1, maxLength: 200 },
				items: {
					type: "array",
					minItems: 1,
					maxItems: 12,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["id", "text", "status"],
						properties: {
							id: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
							text: { type: "string", minLength: 1, maxLength: 300 },
							status: { type: "string", enum: ["pending", "in_progress", "completed"] }
						}
					}
				}
			}
		}
	}
};

function mapAgentTodoStatus(status: AgentTodoStatus): WorkflowTodoStatus {
	if (status === "in_progress") return "running";
	if (status === "completed") return "done";
	return "pending";
}

export function parseAgentTodoListInput(value: unknown): AgentTodoListInput {
	return agentTodoListInputSchema.parse(value);
}

export function createAgentTodoSnapshot(
	runId: string,
	input: AgentTodoListInput,
	previousRevision: number = 0
): WorkflowTodoSnapshot {
	const todos: WorkflowTodoItem[] = input.items.map((item): WorkflowTodoItem => ({
		id: item.id,
		phaseId: item.id,
		text: item.text,
		status: mapAgentTodoStatus(item.status)
	}));
	return {
		workflowId: `agent-loop:${runId}`,
		title: input.title,
		source: "agent_loop",
		revision: previousRevision + 1,
		phases: todos.map((todo: WorkflowTodoItem) => ({
			id: todo.id,
			title: todo.text,
			status: todo.status
		})),
		todos
	};
}

export function completeAgentTodoSnapshot(snapshot: WorkflowTodoSnapshot | null): WorkflowTodoSnapshot | null {
	if (snapshot === null || snapshot.source !== "agent_loop") return snapshot;
	const hasIncompleteItem: boolean = snapshot.phases.some((phase): boolean => phase.status !== "done")
		|| snapshot.todos.some((todo: WorkflowTodoItem): boolean => todo.status !== "done");
	if (!hasIncompleteItem) return snapshot;
	return {
		...snapshot,
		revision: (snapshot.revision ?? 0) + 1,
		phases: snapshot.phases.map((phase) => ({ ...phase, status: "done" })),
		todos: snapshot.todos.map((todo: WorkflowTodoItem): WorkflowTodoItem => ({ ...todo, status: "done" }))
	};
}

export function serializeTodoControlResult(result: Record<string, unknown>): string {
	return `${TODO_CONTROL_RESULT_MARKER}\n${JSON.stringify(result)}`;
}

export function isTodoControlResult(content: string): boolean {
	return content.startsWith(TODO_CONTROL_RESULT_MARKER);
}
