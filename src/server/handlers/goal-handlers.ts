import type WebSocket from "ws";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientRequest } from "../../protocol/types.js";
import type { ClientSession } from "../client-session.js";
import { getClientConnection } from "../client-connections.js";
import {
	cancelAgentGoal,
	dismissAgentGoal,
	emitAgentGoalState,
	extendAgentGoalBudget,
	getCurrentAgentGoal,
	getCurrentAgentGoalTelemetry,
	pauseAgentGoal,
	resumeAgentGoal
} from "../goal-controller.js";
import { sendJson } from "../send-json.js";
import { applyAgentGoalRollback, previewAgentGoalRollback } from "../goal-checkpoints.js";
import { readAgentGoalState } from "../../session/agent-goal-store.js";

async function assertGoalOwnership(session: ClientSession, goalId: string): Promise<void> {
	const goal = await readAgentGoalState(goalId);
	if (goal === null) throw Object.assign(new Error(`Unknown goal: ${goalId}.`), { code: "goal_not_found" });
	if (session.sessionId === undefined || goal.sessionId !== session.sessionId) {
		throw Object.assign(new Error("The Goal does not belong to the active session."), { code: "goal_session_mismatch" });
	}
}

function sendError(socket: WebSocket, request: ClientRequest, code: string, message: string): void {
	sendJson(socket, { type: "response", id: request.id, ok: false, error: { code, message } });
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code ?? "goal_error")
		: "goal_error";
}

export async function handleGoalRequest(
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	_mcpHost: McpHost
): Promise<void> {
	if (getClientConnection(socket)?.clientType !== "studio") {
		sendError(socket, request, "goal_mode_studio_only", `${request.method} is only available to Daedalus Studio.`);
		return;
	}
	try {
		let result: unknown;
		switch (request.method) {
		case "agent.goal.current":
			if (session.sessionId !== request.params.sessionId) {
				throw Object.assign(new Error("The requested Goal session is not active."), { code: "goal_session_mismatch" });
			}
			result = await getCurrentAgentGoalTelemetry(request.params.sessionId);
			break;
		case "agent.goal.pause":
			await assertGoalOwnership(session, request.params.goalId);
			result = await pauseAgentGoal(socket, session, request.params.goalId);
			break;
		case "agent.goal.resume":
			await assertGoalOwnership(session, request.params.goalId);
			result = await resumeAgentGoal({
				socket,
				session,
				mcpHost: _mcpHost,
				goalId: request.params.goalId,
				runChat: async (targetSocket, targetRequest, targetSession, targetMcpHost): Promise<void> => {
					const { handleChatRequest } = await import("../chat-orchestrator.js");
					await handleChatRequest(targetSocket, targetRequest, targetSession, targetMcpHost);
				}
			});
			break;
		case "agent.goal.cancel":
			await assertGoalOwnership(session, request.params.goalId);
			result = await cancelAgentGoal(socket, session, request.params.goalId);
			break;
		case "agent.goal.dismiss":
			await assertGoalOwnership(session, request.params.goalId);
			result = await dismissAgentGoal(request.params.goalId);
			break;
		case "agent.goal.extendBudget":
			await assertGoalOwnership(session, request.params.goalId);
			result = await extendAgentGoalBudget(socket, session, request.params.goalId, request.params);
			break;
		case "agent.goal.rollback.preview":
			await assertGoalOwnership(session, request.params.goalId);
			result = await previewAgentGoalRollback(request.params.goalId);
			break;
		case "agent.goal.rollback.apply":
			await assertGoalOwnership(session, request.params.goalId);
			result = await applyAgentGoalRollback(request.params.goalId, request.params.fingerprint);
			{
				const updatedGoal = await readAgentGoalState(request.params.goalId);
				if (updatedGoal !== null) emitAgentGoalState(socket, session, updatedGoal);
			}
			break;
		default:
			return;
		}
		sendJson(socket, { type: "response", id: request.id, ok: true, result });
	} catch (error: unknown) {
		sendError(socket, request, errorCode(error), error instanceof Error ? error.message : String(error));
	}
}
