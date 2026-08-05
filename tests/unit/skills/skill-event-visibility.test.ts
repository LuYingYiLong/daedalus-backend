import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createClientSession } from "../../../src/server/client-session.js";
import { createAgentToolEventForwarder } from "../../../src/server/workflow/tool-events.js";
import { describeToolEvent } from "../../../src/tools/tool-event-describer.js";
import { EXECUTION_CONTROL_TOOL_NAME } from "../../../src/tools/execution-control.js";

type SocketMock = WebSocket & { sent: Array<Record<string, unknown>> };

function createSocket(): SocketMock {
	const sent: Array<Record<string, unknown>> = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(message: string): void {
			sent.push(JSON.parse(message) as Record<string, unknown>);
		}
	} as SocketMock;
}

test("skill loading stays internal and does not emit timeline events", (): void => {
	const socket = createSocket();
	const forward = createAgentToolEventForwarder(
		socket,
		"request-skill-load",
		createClientSession(undefined),
		"run-skill-load",
		"step-skill-load"
	);
	const args: Record<string, unknown> = { ref: "project:scene-builder" };

	forward({
		type: "tool.call",
		step: 1,
		toolCallId: "tool-skill-load",
		toolName: "mcp_skills_load",
		args,
		...describeToolEvent("mcp_skills_load", args)
	});
	forward({
		type: "tool.progress",
		step: 1,
		toolCallId: "tool-skill-load",
		toolName: "mcp_skills_load",
		status: "message",
		title: "Loading skill",
		details: "Reading instructions",
		code: "skill_loading"
	});
	forward({
		type: "tool.result",
		step: 1,
		toolCallId: "tool-skill-load",
		toolName: "mcp_skills_load",
		resultChars: 128,
		truncated: false,
		summary: "Loaded skill"
	});
	forward({
		type: "tool.error",
		step: 1,
		toolCallId: "tool-skill-load",
		toolName: "mcp_skills_load",
		message: "Skill could not be loaded"
	});

	assert.deepEqual(socket.sent, []);
});

test("execution decisions stay internal and cannot leave a running tool part", (): void => {
	const socket = createSocket();
	const forward = createAgentToolEventForwarder(
		socket,
		"request-decision",
		createClientSession(undefined),
		"run-decision",
		"step-decision"
	);
	const args: Record<string, unknown> = {};
	forward({
		type: "tool.preparing",
		step: 1,
		toolCallId: "tool-decision",
		toolName: EXECUTION_CONTROL_TOOL_NAME,
		args,
		...describeToolEvent(EXECUTION_CONTROL_TOOL_NAME, args)
	});
	forward({
		type: "tool.call",
		step: 1,
		toolCallId: "tool-decision",
		toolName: EXECUTION_CONTROL_TOOL_NAME,
		args,
		...describeToolEvent(EXECUTION_CONTROL_TOOL_NAME, args)
	});

	assert.deepEqual(socket.sent, []);
});
