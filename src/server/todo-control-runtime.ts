import type WebSocket from "ws";
import type { AgentTodoListInput, TodoControlContext } from "../tools/todo-control.js";
import { createAgentTodoSnapshot } from "../tools/todo-control.js";
import type { WorkflowTodoSnapshot } from "../workflow/types.js";
import type { ClientSession } from "./client-session.js";
import { getAgentRun, updateAgentRunTodo } from "./agent-run-controller.js";

export function createAgentTodoControl(params: {
	socket: WebSocket;
	session: ClientSession;
	runId: string;
}): TodoControlContext {
	return {
		async execute(input: AgentTodoListInput): Promise<Record<string, unknown>> {
			const run = getAgentRun(params.session, params.runId);
			if (run === undefined || run.lane !== "agent_loop" || run.terminal !== null) {
				throw new Error("Agent Todo control is not available for the current run.");
			}
			const previousRevision: number = run.todo?.source === "agent_loop"
				? (run.todo.revision ?? 0)
				: 0;
			const snapshot: WorkflowTodoSnapshot = createAgentTodoSnapshot(params.runId, input, previousRevision);
			updateAgentRunTodo(params.socket, params.session, params.runId, snapshot);
			return {
				ok: true,
				workflowId: snapshot.workflowId,
				revision: snapshot.revision,
				itemCount: snapshot.todos.length,
				summary: "Task list updated"
			};
		}
	};
}
