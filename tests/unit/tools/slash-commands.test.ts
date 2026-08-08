import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import type { ClientRequest } from "../../../src/protocol/types.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { createClientSession, type ClientSession } from "../../../src/server/client-session.js";
import { createSlashHelpText, handleSlashCommand, listSlashCommands } from "../../../src/server/slash-commands.js";

function createSocketMock(): WebSocket & { sent: unknown[] } {
	const sent: unknown[] = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(message: string): void {
			sent.push(JSON.parse(message) as unknown);
		}
	} as unknown as WebSocket & { sent: unknown[] };
}

async function withTempUserProfile(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-slash-skill-"));
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	}
}

async function withBackendMode(mode: "development" | "runtime", run: () => Promise<void> | void): Promise<void> {
	const previousMode: string | undefined = process.env.DAEDALUS_BACKEND_MODE;
	process.env.DAEDALUS_BACKEND_MODE = mode;
	try {
		await run();
	} finally {
		if (previousMode === undefined) {
			delete process.env.DAEDALUS_BACKEND_MODE;
		} else {
			process.env.DAEDALUS_BACKEND_MODE = previousMode;
		}
	}
}

test("slash command list hides test commands outside development mode", async (): Promise<void> => {
	await withBackendMode("runtime", (): void => {
		const commands = listSlashCommands();
		const commandNames = commands.map((command) => command.command);

		assert.deepEqual(commandNames, [
			"/help",
			"/context",
			"/approvals",
			"/ask",
			"/agent",
			"/workflow",
			"/plan",
			"/goal",
			"/skills",
			"/skill",
			"/create-skill",
			"/reset",
			"/init"
		]);

		for (const command of commands) {
			assert.equal(command.command.startsWith("/"), true);
			assert.equal(command.usage.startsWith(command.command), true);
			assert.equal(command.insertText.startsWith(command.command), true);
			assert.equal(command.description.length > 0, true);
		}
	});
});

test("slash command list exposes test commands in development mode", async (): Promise<void> => {
	await withBackendMode("development", (): void => {
		const commands = listSlashCommands();
		const commandNames = commands.map((command) => command.command);

		assert.deepEqual(commandNames, [
			"/help",
			"/context",
			"/approvals",
			"/test-approval",
			"/test-message-queue",
			"/test-todo-list",
			"/ask",
			"/agent",
			"/workflow",
			"/plan",
			"/goal",
			"/skills",
			"/skill",
			"/create-skill",
			"/reset",
			"/init"
		]);

		for (const command of commands) {
			assert.equal(command.command.startsWith("/"), true);
			assert.equal(command.usage.startsWith(command.command), true);
			assert.equal(command.insertText.startsWith(command.command), true);
			assert.equal(command.description.length > 0, true);
		}
	});
});

test("slash command help text is generated from the visible command list", async (): Promise<void> => {
	await withBackendMode("development", (): void => {
		const helpText: string = createSlashHelpText();

		for (const command of listSlashCommands()) {
			assert.match(helpText, new RegExp(command.command.replace("/", "\\/")));
			assert.match(helpText, new RegExp(command.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
	});
});

test("command.list is accepted by the client request schema", (): void => {
	const parsed = clientRequestSchema.parse({
		type: "request",
		id: "command-list-test",
		method: "command.list",
		params: {}
	});

	assert.equal(parsed.method, "command.list");
});

test("test approval command includes a clear user-facing reason", (): void => {
	const source: string = readFileSync(new URL("../../../src/server/slash-commands.ts", import.meta.url), "utf8");

	assert.match(source, /Create a temporary markdown file to test the Studio approval UI\./);
});

test("/skill streams and responds even without an active workspace", async (): Promise<void> => {
	await withTempUserProfile(async (): Promise<void> => {
		const socket = createSocketMock();
		const session: ClientSession = createClientSession(undefined);
		const request: ClientRequest = {
			type: "request",
			id: "slash-skill-no-workspace",
			method: "ai.chat",
			params: {
				message: "/skill",
				options: { stream: true }
			}
		} as ClientRequest;

		const result = await handleSlashCommand({
			socket,
			request,
			session,
			mcpHost: {} as McpHost,
			createSessionInfo: (): Record<string, unknown> => ({ ok: true })
		});

		assert.deepEqual(result, { type: "handled" });
		assert.equal(socket.sent.some((message): boolean => (
			(message as { event?: string; data?: { stage?: string } }).event === "agent.run.state"
			&& (message as { data?: { stage?: string } }).data?.stage === "executing"
		)), true);
		assert.equal(socket.sent.some((message): boolean => (message as { event?: string }).event === "agent.message.done"), true);
		assert.equal(socket.sent.some((message): boolean => (
			(message as { event?: string; data?: { stage?: string } }).event === "agent.run.state"
			&& (message as { data?: { stage?: string } }).data?.stage === "completed"
		)), true);
		const response = socket.sent.find((message): boolean => (message as { type?: string }).type === "response") as { ok?: boolean; result?: { text?: string } } | undefined;
		assert.equal(response?.ok, true);
		assert.match(response?.result?.text ?? "", /Skill 现在按消息激活/u);
		assert.match(response?.result?.text ?? "", /builtin:skill-creator/u);
	});
});

test("test slash commands are rejected in runtime mode", async (): Promise<void> => {
	await withBackendMode("runtime", async (): Promise<void> => {
		const socket = createSocketMock();
		const session: ClientSession = createClientSession(undefined);
		const request: ClientRequest = {
			type: "request",
			id: "slash-test-runtime",
			method: "ai.chat",
			params: {
				message: "/test-message-queue",
				options: { stream: true }
			}
		} as ClientRequest;

		const result = await handleSlashCommand({
			socket,
			request,
			session,
			mcpHost: {} as McpHost,
			createSessionInfo: (): Record<string, unknown> => ({ ok: true })
		});

		assert.deepEqual(result, { type: "handled" });
		assert.equal(session.queuedMessages.length, 0);
		const response = socket.sent.find((message): boolean => (message as { type?: string }).type === "response") as { result?: { text?: string } } | undefined;
		assert.match(response?.result?.text ?? "", /未知指令：`\/test-message-queue`/u);
		assert.doesNotMatch(response?.result?.text ?? "", /\/test-todo-list/u);
	});
});

test("/test-message-queue creates harmless queue UI items in development mode", async (): Promise<void> => {
	await withBackendMode("development", async (): Promise<void> => {
		const socket = createSocketMock();
		const session: ClientSession = createClientSession(undefined);
		const request: ClientRequest = {
			type: "request",
			id: "slash-test-message-queue",
			method: "ai.chat",
			params: {
				message: "/test-message-queue",
				options: { stream: true }
			}
		} as ClientRequest;

		const result = await handleSlashCommand({
			socket,
			request,
			session,
			mcpHost: {} as McpHost,
			createSessionInfo: (): Record<string, unknown> => ({ ok: true })
		});

		assert.deepEqual(result, { type: "handled" });
		assert.equal(session.queuedMessages.length, 3);
		assert.deepEqual(session.queuedMessages.map((item) => item.status), ["pending", "pending", "pending"]);
		assert.equal(socket.sent.some((message): boolean => (message as { event?: string }).event === "message.queue.updated"), true);
		assert.equal(socket.sent.some((message): boolean => (message as { event?: string }).event === "session.workbench.updated"), true);
	});
});

test("/test-todo-list sends a harmless workflow todo snapshot in development mode", async (): Promise<void> => {
	await withBackendMode("development", async (): Promise<void> => {
		const socket = createSocketMock();
		const session: ClientSession = createClientSession(undefined);
		session.sessionId = "session-test-todo-list";
		const request: ClientRequest = {
			type: "request",
			id: "slash-test-todo-list",
			method: "ai.chat",
			params: {
				message: "/test-todo-list",
				options: { stream: true }
			}
		} as ClientRequest;

		const result = await handleSlashCommand({
			socket,
			request,
			session,
			mcpHost: {} as McpHost,
			createSessionInfo: (): Record<string, unknown> => ({ ok: true })
		});

		assert.deepEqual(result, { type: "handled" });
		const stateEvent = [...socket.sent].reverse().find((message): boolean => {
			const event = message as { event?: string; data?: { todo?: unknown } };
			return event.event === "agent.run.state" && event.data?.todo !== null;
		}) as { protocolVersion?: number; data?: { todo?: { phases?: unknown[] } } } | undefined;
		assert.equal(stateEvent?.protocolVersion, 3);
		assert.equal(Array.isArray(stateEvent?.data?.todo?.phases), true);
		assert.equal(stateEvent?.data?.todo?.phases?.length, 4);
		assert.equal(socket.sent.some((message): boolean => (message as { event?: string }).event === "agent.run.snapshot"), false);
	});
});

test("mode slash commands strip their prefix and forward the requested chat mode", async (): Promise<void> => {
	const socket = createSocketMock();
	const session: ClientSession = createClientSession(undefined);
	const request: ClientRequest = {
		type: "request",
		id: "slash-plan",
		method: "ai.chat",
		params: {
			message: "/plan 重构认证流程",
			mode: "ask",
			options: { stream: true }
		}
	} as ClientRequest;

	const result = await handleSlashCommand({
		socket,
		request,
		session,
		mcpHost: {} as McpHost,
		createSessionInfo: (): Record<string, unknown> => ({ ok: true })
	});

	assert.deepEqual(result, {
		type: "ai",
		params: {
			...request.params,
			mode: "plan",
			message: "重构认证流程"
		}
	});
});

test("removed workflow slash command is handled without starting a run", async (): Promise<void> => {
	const socket = createSocketMock();
	const session: ClientSession = createClientSession(undefined);
	const request: ClientRequest = {
		type: "request",
		id: "slash-workflow",
		method: "ai.chat",
		params: {
			message: "/workflow Refactor the authentication flow",
			mode: "ask",
			options: { stream: true, workflow: "single" }
		}
	} as ClientRequest;

	const result = await handleSlashCommand({
		socket,
		request,
		session,
		mcpHost: {} as McpHost,
		createSessionInfo: (): Record<string, unknown> => ({ ok: true })
	});

	assert.deepEqual(result, { type: "handled" });
});
