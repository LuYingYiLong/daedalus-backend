import type WebSocket from "ws";
import type { ScheduledTaskControlContext } from "../tools/scheduled-task-tools.js";
import { getClientConnection } from "./client-connections.js";
import { studioScheduledTaskRuntime } from "./studio-scheduled-task-runtime.js";

export function getStudioScheduledTaskControl(socket: WebSocket, sessionId: string | undefined): ScheduledTaskControlContext | undefined {
	const connection = getClientConnection(socket);
	if (sessionId === undefined) return undefined;
	if (connection?.clientType === "studio" && connection.capabilities.scheduledTasks === true) {
		return studioScheduledTaskRuntime.createControl(socket, sessionId);
	}
	if (connection?.clientType === "studio_scheduler" && connection.capabilities.scheduledTaskReport === true) {
		return studioScheduledTaskRuntime.createControl(socket, sessionId);
	}
	return undefined;
}
