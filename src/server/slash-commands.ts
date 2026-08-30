import type WebSocket from "ws";
import type { AiChatParams, ClientRequest } from "../protocol/types.js";
import { listSkillSummaries } from "../skills/catalog.js";
import type { SkillWorkspace } from "../skills/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ClientSession } from "./client-session.js";
import { sendJson } from "./send-json.js";
import { appendApprovalEvent } from "../session/session-store.js";
import { createPersistedApprovalRequestedData } from "../session/approval-persistence.js";
import { getBackendRuntimeMode } from "./backend-runtime.js";
import { enqueueMessage, emitMessageQueueUpdated, persistMessageQueueEvent, serializeQueuedMessage } from "./message-queue.js";
import { bumpWorkbenchRevision, emitWorkbenchUpdated } from "./workbench.js";
import { sendSessionEvent, waitForSessionEventPersistence } from "./session-events.js";
import { createGlobalSkillWorkspace } from "../skills/runtime.js";
import { beginAgentRun, updateAgentRun } from "./agent-run-controller.js";
import type { WorkflowTodoSnapshot } from "../workflow/types.js";
import { getPluginP2Snapshot } from "../plugins/p2/registry.js";

export type SlashCommandDefinition = {
	command: string;
	usage: string;
	insertText: string;
	description: string;
	requiresArgument: boolean;
	examples: string[];
};

export type SlashCommandResult =
	| { type: "handled" }
	| { type: "ai"; params: AiChatParams }
	| { type: "none" };

export type SessionInfoFactory = (session: ClientSession, mcpHost: McpHost) => Record<string, unknown>;

const BASE_SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
	{
		command: "/help",
		usage: "/help",
		insertText: "/help",
		description: "显示指令帮助。",
		requiresArgument: false,
		examples: ["/help"]
	},
	{
		command: "/context",
		usage: "/context",
		insertText: "/context",
		description: "显示当前模型、上下文窗口、MCP 和审批信息。",
		requiresArgument: false,
		examples: ["/context"]
	},
	{
		command: "/approvals",
		usage: "/approvals",
		insertText: "/approvals",
		description: "显示待审批工具调用。",
		requiresArgument: false,
		examples: ["/approvals"]
	},
	{
		command: "/ask",
		usage: "/ask [Message]",
		insertText: "/ask ",
		description: "切换到 Ask 模式并发送消息。",
		requiresArgument: true,
		examples: ["/ask 这是什么意思"]
	},
	{
		command: "/agent",
		usage: "/agent [Message]",
		insertText: "/agent ",
		description: "切换到 Agent 模式并发送消息。",
		requiresArgument: true,
		examples: ["/agent 修复这个错误"]
	},
	{
		command: "/workflow",
		usage: "/workflow [Task]",
		insertText: "/workflow ",
		description: "以完整多阶段 Workflow 执行当前工作区任务。",
		requiresArgument: true,
		examples: ["/workflow 重构认证模块并补齐测试"]
	},
	{
		command: "/plan",
		usage: "/plan [Message]",
		insertText: "/plan ",
		description: "切换到 Plan 模式并发送消息。",
		requiresArgument: true,
		examples: ["/plan 规划登录系统重构"]
	},
	{
		command: "/goal",
		usage: "/goal [Traget]",
		insertText: "/goal ",
		description: "切换到 Goal 模式并开始执行目标。",
		requiresArgument: true,
		examples: ["/goal 完成登录流程并验证"]
	},
	{
		command: "/skills",
		usage: "/skills",
		insertText: "/skills",
		description: "列出可用 skills。",
		requiresArgument: false,
		examples: ["/skills"]
	},
	{
		command: "/skill",
		usage: "/skill",
		insertText: "/skill",
		description: "说明如何通过 @ 在当前消息激活 skill。",
		requiresArgument: false,
		examples: ["/skill"]
	},
	{
		command: "/create-skill",
		usage: "/create-skill [--personal] [需求]",
		insertText: "/create-skill ",
		description: "让 AI 创建项目或个人 skill。",
		requiresArgument: false,
		examples: ["/create-skill 创建场景性能审查流程", "/create-skill --personal 创建通用代码审查流程"]
	},
	{
		command: "/reset",
		usage: "/reset",
		insertText: "/reset",
		description: "清空当前会话历史。",
		requiresArgument: false,
		examples: ["/reset"]
	},
	{
		command: "/init",
		usage: "/init [Requirement]",
		insertText: "/init ",
		description: "检查当前 Godot 项目，并请求生成项目根目录 AGENTS.md。",
		requiresArgument: false,
		examples: ["/init", "/init 请保留现有项目约束"]
	}
] as const;

const CHAT_MODE_BY_SLASH_COMMAND: Readonly<Record<string, AiChatParams["mode"]>> = {
	"/ask": "ask",
	"/agent": "agent",
	"/plan": "plan",
	"/goal": "goal"
};

function getChatModeForSlashCommand(command: string): AiChatParams["mode"] | null {
	return CHAT_MODE_BY_SLASH_COMMAND[command] ?? null;
}

const DEV_SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
	{
		command: "/test-approval",
		usage: "/test-approval",
		insertText: "/test-approval",
		description: "创建一个用于 Studio UI 调试的待审批文件写入。",
		requiresArgument: false,
		examples: ["/test-approval"]
	},
	{
		command: "/test-message-queue",
		usage: "/test-message-queue",
		insertText: "/test-message-queue",
		description: "创建几条不会自动执行的 Studio 消息队列测试项。",
		requiresArgument: false,
		examples: ["/test-message-queue"]
	},
	{
		command: "/test-todo-list",
		usage: "/test-todo-list",
		insertText: "/test-todo-list",
		description: "发送一个不会执行工具的 Studio Todo 浮层测试快照。",
		requiresArgument: false,
		examples: ["/test-todo-list"]
	}
] as const;

function isDevelopmentSlashCommandEnabled(): boolean {
	return getBackendRuntimeMode() === "development";
}

function getVisibleSlashCommands(): readonly SlashCommandDefinition[] {
	return isDevelopmentSlashCommandEnabled()
		? [...BASE_SLASH_COMMANDS.slice(0, 3), ...DEV_SLASH_COMMANDS, ...BASE_SLASH_COMMANDS.slice(3)]
		: BASE_SLASH_COMMANDS;
}

export function listSlashCommands(): SlashCommandDefinition[] {
	return getVisibleSlashCommands().map((command: SlashCommandDefinition): SlashCommandDefinition => ({
		...command,
		examples: [...command.examples]
	}));
}

export function createSlashCommandListResult(): { commands: SlashCommandDefinition[] } {
	return {
		commands: listSlashCommands()
	};
}

export async function createSlashCommandListResultWithPlugins(): Promise<{ commands: SlashCommandDefinition[] }> {
	const base = createSlashCommandListResult();
	const pluginCommands = (await getPluginP2Snapshot()).commands.map((command): SlashCommandDefinition => ({
		command: command.command,
		usage: command.usage ?? command.command,
		insertText: `${command.command} `,
		description: `${command.description}（插件）`,
		requiresArgument: (command.arguments?.length ?? 0) > 0,
		examples: [command.usage ?? command.command]
	}));
	return { commands: [...base.commands, ...pluginCommands] };
}

export function createSlashHelpText(): string {
	return [
		"## 可用指令",
		...getVisibleSlashCommands().map((command: SlashCommandDefinition): string => {
			return `- \`${command.usage}\`：${command.description}`;
		})
	].join("\n");
}

function formatSessionInfo(session: ClientSession, mcpHost: McpHost, createSessionInfo: SessionInfoFactory): string {
	const info: Record<string, unknown> = createSessionInfo(session, mcpHost);
	return [
		"## 当前上下文",
		`- Provider configured: ${String(info.providerConfigured)}`,
		`- Model: ${String(info.model)}`,
		"- Active skill: per-message (@skill)",
		`- History messages: ${String(info.historyMessagesStored)}`,
		`- Context window: ${String(info.contextWindowTokens)} tokens`,
		`- Default output reserve: ${String(info.defaultOutputReserveTokens)} tokens`,
		`- Safety margin: ${String(info.safetyMarginTokens)} tokens`,
		`- Approval mode: ${String(info.approvalMode)}`,
		`- Pending approvals: ${String(info.pendingApprovals)}`,
		`- MCP servers: ${JSON.stringify(info.mcpServers)}`,
		`- Workspace root: ${String(info.workspaceRoot ?? "")}`
	].join("\n");
}

function formatPendingApprovals(session: ClientSession): string {
	const pending = session.approvalGateway.listPending();
	if (pending.length === 0) {
		return "当前没有待审批工具调用。";
	}

	return [
		"## 待审批工具调用",
		...pending.map((approval): string => [
			`- ${approval.approvalId}`,
			`  - Tool: ${approval.llmToolName}`,
			`  - Reason: ${approval.reason}`,
			`  - Args: \`${JSON.stringify(approval.args)}\``
		].join("\n"))
	].join("\n");
}

async function createTestApproval(socket: WebSocket, request: ClientRequest, session: ClientSession): Promise<string> {
	const workspaceId: string | undefined = session.activeWorkspace?.id;
	if (workspaceId === undefined) {
		return "当前会话没有工作区，无法创建文件写入审批。请选择一个工作区后再运行 `/test-approval`。";
	}

	const suffix: string = Date.now().toString(36);
	const pending = session.approvalGateway.requestApproval(
		"mcp_godot_create_text_file",
		{
			relativePath: `daedalus-approval-test-${suffix}.md`,
			content: "# Daedalus approval test\n\nThis file is created only if the pending approval is approved.\n"
		},
		`slash-test-approval-${suffix}`,
		"Create a temporary markdown file to test the Studio approval UI.",
		workspaceId,
		session.editorInstanceId,
		session.sessionId
	);

	if (session.sessionId !== undefined) {
		await appendApprovalEvent(
			session.sessionId,
			pending.approvalId,
			request.id,
			"requested",
			createPersistedApprovalRequestedData(pending, undefined, workspaceId)
		);
	}

	emitWorkbenchUpdated(socket, request.id, session);
	return `已创建测试审批：\`${pending.approvalId}\`。请在 Studio 审批面板中 Approve 或 Reject。`;
}

async function createTestMessageQueue(socket: WebSocket, request: ClientRequest, session: ClientSession): Promise<string> {
	const testTexts: string[] = [
		"测试队列消息 A：检查队列卡片基础样式。",
		"测试队列消息 B：拖拽我来调整优先级。",
		"测试队列消息 C：删除我来检查关闭按钮。"
	];
	const items = testTexts.map((text: string) => enqueueMessage(session, {
		text
	}));

	for (const item of items) {
		await persistMessageQueueEvent(session, request.id, "message.queue.added", {
			type: "message.queue.added",
			item: serializeQueuedMessage(item)
		});
	}

	bumpWorkbenchRevision(session);
	emitMessageQueueUpdated(socket, request.id, session);
	emitWorkbenchUpdated(socket, request.id, session);
	await waitForSessionEventPersistence(session);

	return `已创建 ${items.length} 条消息队列 UI 测试项；它们不会自动开始执行。`;
}

async function emitTestTodoListSnapshot(socket: WebSocket, request: ClientRequest, session: ClientSession): Promise<void> {
	if (session.sessionId === undefined) {
		return;
	}
	const runId: string = `slash-test-todo-${Date.now().toString(36)}`;
	beginAgentRun({
		socket,
		session,
		sessionId: session.sessionId,
		requestId: request.id,
		runId,
		title: "Todo UI test",
		intent: "mutate",
		scope: "complex",
		lane: "agent_loop"
	});
	const todo: WorkflowTodoSnapshot = {
		workflowId: runId,
		title: "Todo UI test",
		source: "slash",
		revision: 1,
		activePhaseRunId: `${runId}-write`,
		phases: [
			{
				id: "inspect",
				title: "读取上下文",
				status: "done"
			},
			{
				id: "write",
				title: "实现修改",
				status: "running"
			},
			{
				id: "verify",
				title: "验证结果",
				status: "pending"
			},
			{
				id: "summarize",
				title: "总结交付",
				status: "pending"
			}
		],
		todos: [
			{ id: "todo-inspect", phaseId: "inspect", status: "done", text: "读取上下文" },
			{ id: "todo-write", phaseId: "write", status: "running", text: "实现修改" },
			{ id: "todo-verify", phaseId: "verify", status: "pending", text: "验证结果" },
			{ id: "todo-summarize", phaseId: "summarize", status: "pending", text: "总结交付" }
		]
	};
	updateAgentRun(socket, session, runId, "finalizing", {
		todo
	});
	updateAgentRun(socket, session, runId, "completed", {
		todo,
		terminal: {
			resultStatus: "completed",
			completedAt: new Date().toISOString()
		}
	});
	await waitForSessionEventPersistence(session);
}

function getSkillWorkspace(session: ClientSession): SkillWorkspace {
	if (session.activeWorkspace !== undefined) {
		return { id: session.activeWorkspace.id, rootPath: session.activeWorkspace.rootPath };
	}
	if (session.workspaceRoot !== undefined) {
		return { id: `runtime:${session.workspaceRoot}`, rootPath: session.workspaceRoot };
	}
	return createGlobalSkillWorkspace();
}

async function formatSkillList(session: ClientSession): Promise<string> {
	const catalog = await listSkillSummaries(getSkillWorkspace(session));
	return [
		"## 可用 Skills",
		...catalog.skills.map((skill): string => `- \`${skill.ref}\` [${skill.source}] ${skill.name} - ${skill.description || skill.error || "Invalid skill"} (${skill.enabled ? "enabled" : "disabled"})`)
	].join("\n");
}

async function sendChatText(
	socket: WebSocket,
	request: ClientRequest,
	text: string,
	session: ClientSession,
	mcpHost: McpHost,
	createSessionInfo: SessionInfoFactory
): Promise<void> {
	if (request.method !== "ai.chat" || request.params.options?.stream !== true) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				text,
				context: createSessionInfo(session, mcpHost)
			}
		});
		return;
	}

	const runId: string = `slash-${request.id}`;
	sendSessionEvent(
		socket,
		request.id,
		session,
		"agent.run.started",
		{
			runId,
			requestId: request.id,
			title: "Slash command",
			source: "slash",
			startedAt: new Date().toISOString(),
			steps: [{
				id: "answer",
				title: "回答命令",
				toolGroup: "answer",
				acceptanceCriteria: []
			}]
		}
	);

	for (let index: number = 0; index < text.length; index += 1) {
		sendSessionEvent(
			socket,
			request.id,
			session,
			"agent.message.delta",
			{
				runId,
				stepRunId: `${runId}-answer`,
				text: text[index]
			}
		);
	}

	sendSessionEvent(
		socket,
		request.id,
		session,
		"agent.message.done",
		{
			runId,
			requestId: request.id,
			stepRunId: `${runId}-answer`,
			text,
			context: createSessionInfo(session, mcpHost)
		}
	);
	sendSessionEvent(
		socket,
		request.id,
		session,
		"agent.run.done",
		{
			runId,
			requestId: request.id,
			title: "Slash command",
			status: "done",
			resultStatus: "completed",
			warnings: []
		}
	);
	await waitForSessionEventPersistence(session);
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: true,
		result: {
			text,
			context: createSessionInfo(session, mcpHost)
		}
	});
}

export async function handleSlashCommand(params: {
	socket: WebSocket;
	request: ClientRequest;
	session: ClientSession;
	mcpHost: McpHost;
	createSessionInfo: SessionInfoFactory;
}): Promise<SlashCommandResult> {
	const { socket, request, session, mcpHost, createSessionInfo } = params;
	if (request.method !== "ai.chat") {
		return { type: "none" };
	}

	const inputText: string = request.params.message.trim();
	if (!inputText.startsWith("/")) {
		return { type: "none" };
	}

	const [rawCommand = "", ...restParts] = inputText.split(/\s+/);
	const command: string = rawCommand.toLowerCase();
	const restText: string = restParts.join(" ").trim();

	if (command === "/help") {
		await sendChatText(socket, request, createSlashHelpText(), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/context") {
		await sendChatText(socket, request, formatSessionInfo(session, mcpHost, createSessionInfo), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/approvals") {
		await sendChatText(socket, request, formatPendingApprovals(session), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	const chatMode: AiChatParams["mode"] | null = getChatModeForSlashCommand(command);
	if (chatMode !== null) {
		if (restText.length === 0) {
			await sendChatText(socket, request, `请在 \`${command}\` 后提供要发送的消息。`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		return {
			type: "ai",
			params: {
				...request.params,
				mode: chatMode,
				message: restText
			}
		};
	}

	if (command === "/workflow") {
		if (restText.length === 0) {
			await sendChatText(socket, request, "请在 `/workflow` 后提供要执行的任务。", session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		await sendChatText(socket, request, "The legacy Workflow command has been removed. Submit this task in Agent mode instead.", session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/test-approval") {
		if (!isDevelopmentSlashCommandEnabled()) {
			await sendChatText(socket, request, `未知指令：\`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		await sendChatText(socket, request, await createTestApproval(socket, request, session), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/test-message-queue") {
		if (!isDevelopmentSlashCommandEnabled()) {
			await sendChatText(socket, request, `未知指令：\`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		await sendChatText(socket, request, await createTestMessageQueue(socket, request, session), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/test-todo-list") {
		if (!isDevelopmentSlashCommandEnabled()) {
			await sendChatText(socket, request, `未知指令：\`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		await sendChatText(socket, request, "已发送 Todo 浮层 UI 测试快照；不会调用模型或工具。", session, mcpHost, createSessionInfo);
		await emitTestTodoListSnapshot(socket, request, session);
		return { type: "handled" };
	}

	if (command === "/skills") {
		await sendChatText(socket, request, await formatSkillList(session), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/skill") {
		await sendChatText(socket, request, `Skill 现在按消息激活。请在消息中输入 \`@\` 并选择一个或多个 skill。\n\n${await formatSkillList(session)}`, session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/create-skill") {
		const personal: boolean = restParts[0]?.toLowerCase() === "--personal";
		const requirement: string = (personal ? restParts.slice(1) : restParts).join(" ").trim();
		return {
			type: "ai",
			params: {
				...request.params,
				skillRefs: ["builtin:skill-creator"],
				message: requirement.length > 0
					? `请为我创建一个${personal ? "个人" : "当前项目"} skill。\n\n需求：${requirement}`
					: `请帮我创建一个${personal ? "个人" : "当前项目"} skill。先询问我这个 skill 要解决的具体工作流，再进行创建。`
			}
		};
	}

	if (command === "/reset") {
		session.messages = [];
		session.fullSessionLoadPromise = undefined;
		await sendChatText(socket, request, "已清空当前会话历史。", session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/init") {
		session.messages = [];
		session.fullSessionLoadPromise = undefined;
		const extraInstruction: string = restText.length > 0
			? `\n\n用户补充要求：${restText}`
			: "";

		return {
			type: "ai",
			params: {
				...request.params,
				promptId: "godot.assistant",
				skillRefs: ["builtin:godot-project-init"],
				message: [
					"请初始化当前 Godot 项目的 AI 协作上下文。",
					"请通过 MCP 工具检查项目摘要、场景、脚本、插件和关键配置。",
					"请生成适合项目根目录的 AGENTS.md 内容，并调用文件创建工具请求创建 `AGENTS.md`。",
					"如果 `AGENTS.md` 已存在，请读取并总结现有内容，不要覆盖；说明是否建议更新。",
					"文件创建工具需要用户审批时，请明确告知审批 ID 和用户需要在 Godot 客户端 Approvals 区域批准。"
				].join("\n") + extraInstruction
			}
		};
	}

	await sendChatText(socket, request, `未知指令：\`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
	return { type: "handled" };
}
