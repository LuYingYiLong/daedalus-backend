import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession, QueuedMessage, QueuedMessageStatus } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	emitMessageQueueUpdated,
	enqueueMessage,
	persistMessageQueueEvent,
	removeQueuedMessage,
	reorderQueuedMessages,
	type QueueMutationResult,
	serializeMessageQueue,
	serializeQueuedMessage,
	setQueuedMessageStatus,
	updateQueuedMessage
} from "../message-queue.js";
import { bumpWorkbenchRevision, emitWorkbenchUpdated, serializeWorkbench } from "../workbench.js";
import { getCurrentAgentGoal, pauseAgentGoal } from "../goal-controller.js";
import { getClientConnection } from "../client-connections.js";

function sendQueueResult(socket: WebSocket, request: ClientRequest, session: ClientSession, extra: Record<string, unknown> = {}): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: true,
		result: {
			...extra,
			messageQueue: serializeMessageQueue(session),
			workbench: serializeWorkbench(session)
		}
	});
}

function parseQueueId(value: unknown): number {
	const queueId: number = typeof value === "number" ? value : Number(value);
	return Number.isInteger(queueId) && queueId > 0 ? queueId : 0;
}

function scheduleQueueDrain(socket: WebSocket, requestId: string, session: ClientSession, mcpHost: McpHost): void {
	void import("../chat-orchestrator.js").then(({ drainMessageQueue }) => {
		return drainMessageQueue(socket, requestId, session, mcpHost);
	}).catch((error: unknown): void => {
		console.error("[message.queue] drain failed", error);
	});
}

export async function handleMessageQueueRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "message.queue.list":
		sendQueueResult(socket, request, session);
		break;

	case "message.queue.add": {
		if (request.params.scheduledTaskOrigin !== undefined && getClientConnection(socket)?.clientType !== "studio_scheduler") {
			throw new Error("scheduled_task_queue_origin_not_allowed");
		}
		const item: QueuedMessage = enqueueMessage(session, request.params);
		if (item.mode !== "goal" && session.sessionId !== undefined) {
			const activeGoal = await getCurrentAgentGoal(session.sessionId);
			if (activeGoal !== null && activeGoal.stage !== "paused" && activeGoal.stage !== "pausing") {
				await pauseAgentGoal(socket, session, activeGoal.goalId, "user_interruption");
			}
		}
		await persistMessageQueueEvent(session, request.id, "message.queue.added", {
			type: "message.queue.added",
			item: serializeQueuedMessage(item)
		});
		bumpWorkbenchRevision(session);
		sendQueueResult(socket, request, session, {
			queueAdded: true,
			item: serializeQueuedMessage(item)
		});
		emitMessageQueueUpdated(socket, request.id, session);
		emitWorkbenchUpdated(socket, request.id, session);
		scheduleQueueDrain(socket, request.id, session, mcpHost);
		break;
	}

	case "message.queue.update": {
		const result: QueueMutationResult = updateQueuedMessage(
			session,
			parseQueueId(request.params.queueId),
			request.params
		);
		if (result.item === undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "queue_item_not_found", message: "Queued message not found." }
			});
			break;
		}
		if (result.errorCode !== undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: result.errorCode,
					message: result.errorMessage ?? "Queued message cannot be updated."
				}
			});
			break;
		}
		if (result.changed) {
			await persistMessageQueueEvent(session, request.id, "message.queue.updated", {
				type: "message.queue.updated",
				item: serializeQueuedMessage(result.item)
			});
			bumpWorkbenchRevision(session);
		}
		sendQueueResult(socket, request, session, {
			queueUpdated: result.changed,
			item: serializeQueuedMessage(result.item)
		});
		if (result.changed) {
			emitMessageQueueUpdated(socket, request.id, session);
			emitWorkbenchUpdated(socket, request.id, session);
		}
		break;
	}

	case "message.queue.remove": {
		const queueId: number = parseQueueId(request.params.queueId);
		const removed: boolean = removeQueuedMessage(session, queueId);
		if (removed) {
			await persistMessageQueueEvent(session, request.id, "message.queue.removed", {
				type: "message.queue.removed",
				queueId,
				removedAt: new Date().toISOString()
			});
			bumpWorkbenchRevision(session);
		}
		sendQueueResult(socket, request, session, {
			queueRemoved: removed,
			removed
		});
		if (removed) {
			emitMessageQueueUpdated(socket, request.id, session);
			emitWorkbenchUpdated(socket, request.id, session);
		}
		break;
	}

	case "message.queue.status": {
		const queueId: number = parseQueueId(request.params.queueId);
		const result: QueueMutationResult = setQueuedMessageStatus(
			session,
			queueId,
			request.params.status as QueuedMessageStatus
		);
		if (result.item === undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "queue_item_not_found", message: "Queued message not found." }
			});
			break;
		}
		if (result.changed) {
			await persistMessageQueueEvent(session, request.id, "message.queue.status", {
				type: "message.queue.status",
				queueId,
				status: request.params.status,
				updatedAt: result.item.updatedAt
			});
			bumpWorkbenchRevision(session);
		}
		sendQueueResult(socket, request, session, {
			queueStatusUpdated: result.changed,
			item: serializeQueuedMessage(result.item)
		});
		if (result.changed) {
			emitMessageQueueUpdated(socket, request.id, session);
			emitWorkbenchUpdated(socket, request.id, session);
		}
		break;
	}

	case "message.queue.reorder": {
		const result: QueueMutationResult = reorderQueuedMessages(session, request.params.queueIds);
		if (result.errorCode !== undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: result.errorCode,
					message: result.errorMessage ?? "Invalid queue order."
				}
			});
			break;
		}
		if (result.changed) {
			await persistMessageQueueEvent(session, request.id, "message.queue.reordered", {
				type: "message.queue.reordered",
				queueIds: session.queuedMessages.map((message: QueuedMessage): number => message.id),
				reorderedAt: new Date().toISOString()
			});
			bumpWorkbenchRevision(session);
		}
		sendQueueResult(socket, request, session, {
			queueReordered: result.changed
		});
		if (result.changed) {
			emitMessageQueueUpdated(socket, request.id, session);
			emitWorkbenchUpdated(socket, request.id, session);
		}
		break;
	}

		default:
			throw new Error(`Unsupported message queue method: ${request.method}`);
	}
}
