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
import { getPluginP2Snapshot } from "../plugins/extensions/registry.js";
import { getClientConnection } from "./client-connections.js";
import { computerOverlayPreviewActionSchema, computerOverlayPreviewSchema, type ComputerOverlayPreview } from "../protocol/computer-overlay-preview.js";

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
		description: "Show available commands.",
		requiresArgument: false,
		examples: ["/help"]
	},
	{
		command: "/context",
		usage: "/context",
		insertText: "/context",
		description: "Show the active model, context window, MCP, and approval information.",
		requiresArgument: false,
		examples: ["/context"]
	},
	{
		command: "/approvals",
		usage: "/approvals",
		insertText: "/approvals",
		description: "Show pending tool approvals.",
		requiresArgument: false,
		examples: ["/approvals"]
	},
	{
		command: "/ask",
		usage: "/ask [Message]",
		insertText: "/ask ",
		description: "Switch to Ask mode and send a message.",
		requiresArgument: true,
		examples: ["/ask What does this mean?"]
	},
	{
		command: "/agent",
		usage: "/agent [Message]",
		insertText: "/agent ",
		description: "Switch to Agent mode and send a message.",
		requiresArgument: true,
		examples: ["/agent Fix this error"]
	},
	{
		command: "/workflow",
		usage: "/workflow [Task]",
		insertText: "/workflow ",
		description: "Run the current workspace task through the full multi-stage workflow.",
		requiresArgument: true,
		examples: ["/workflow Refactor the authentication module and add tests"]
	},
	{
		command: "/plan",
		usage: "/plan [Message]",
		insertText: "/plan ",
		description: "Switch to Plan mode and send a message.",
		requiresArgument: true,
		examples: ["/plan Plan the login system refactor"]
	},
	{
		command: "/goal",
		usage: "/goal [Traget]",
		insertText: "/goal ",
		description: "Switch to Goal mode and start executing a goal.",
		requiresArgument: true,
		examples: ["/goal Complete and verify the login flow"]
	},
	{
		command: "/skills",
		usage: "/skills",
		insertText: "/skills",
		description: "List available skills.",
		requiresArgument: false,
		examples: ["/skills"]
	},
	{
		command: "/skill",
		usage: "/skill",
		insertText: "/skill",
		description: "Explain how to activate skills with @ in the current message.",
		requiresArgument: false,
		examples: ["/skill"]
	},
	{
		command: "/create-skill",
	usage: "/create-skill [--personal] [requirement]",
		insertText: "/create-skill ",
		description: "Ask AI to create a project or personal skill.",
		requiresArgument: false,
		examples: ["/create-skill Create a scene performance review workflow", "/create-skill --personal Create a general code review workflow"]
	},
	{
		command: "/reset",
		usage: "/reset",
		insertText: "/reset",
		description: "Clear the current session history.",
		requiresArgument: false,
		examples: ["/reset"]
	},
	{
		command: "/init",
		usage: "/init [Requirement]",
		insertText: "/init ",
		description: "Inspect the current Godot project and request an AGENTS.md file for its root.",
		requiresArgument: false,
		examples: ["/init", "/init Preserve the existing project constraints"]
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
		command: "/test-computer-overlay",
		usage: "/test-computer-overlay [running|paused|click|stop]",
		insertText: "/test-computer-overlay",
		description: "Preview the Windows Studio computer-use overlay without observing windows or sending input; defaults to the running state.",
		requiresArgument: false,
		examples: ["/test-computer-overlay", "/test-computer-overlay paused", "/test-computer-overlay click", "/test-computer-overlay stop"]
	},
	{
		command: "/test-approval",
		usage: "/test-approval",
		insertText: "/test-approval",
		description: "Create a pending file-write approval for Studio UI debugging.",
		requiresArgument: false,
		examples: ["/test-approval"]
	},
	{
		command: "/test-message-queue",
		usage: "/test-message-queue",
		insertText: "/test-message-queue",
		description: "Create Studio message-queue test items that do not execute automatically.",
		requiresArgument: false,
		examples: ["/test-message-queue"]
	},
	{
		command: "/test-todo-list",
		usage: "/test-todo-list",
		insertText: "/test-todo-list",
		description: "Send a Studio Todo overlay test snapshot that does not execute tools.",
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
		description: `${command.description} (plugin)`,
		requiresArgument: (command.arguments?.length ?? 0) > 0,
		examples: [command.usage ?? command.command]
	}));
	return { commands: [...base.commands, ...pluginCommands] };
}

export function createSlashHelpText(): string {
	return [
		"## Available commands",
		...getVisibleSlashCommands().map((command: SlashCommandDefinition): string => {
			return `- \`${command.usage}\`: ${command.description}`;
		})
	].join("\n");
}

function formatSessionInfo(session: ClientSession, mcpHost: McpHost, createSessionInfo: SessionInfoFactory): string {
	const info: Record<string, unknown> = createSessionInfo(session, mcpHost);
	return [
		"## Current context",
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
		return "There are no pending tool approvals.";
	}

	return [
		"## Pending tool approvals",
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
		return "The current session has no workspace, so a file-write approval cannot be created. Select a workspace before running `/test-approval`.";
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
	return `Created test approval \`${pending.approvalId}\`. Approve or reject it in the Studio Approvals panel.`;
}

async function createTestMessageQueue(socket: WebSocket, request: ClientRequest, session: ClientSession): Promise<string> {
	const testTexts: string[] = [
		"Test queue item A: inspect the basic queue-card styling.",
		"Test queue item B: drag me to change the priority.",
		"Test queue item C: delete me to inspect the close button."
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

	return `Created ${items.length} message-queue UI test items. They will not start automatically.`;
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
				title: "Inspect context",
				status: "done"
			},
			{
				id: "write",
				title: "Implement changes",
				status: "running"
			},
			{
				id: "verify",
				title: "Verify results",
				status: "pending"
			},
			{
				id: "summarize",
				title: "Summarize delivery",
				status: "pending"
			}
		],
		todos: [
			{ id: "todo-inspect", phaseId: "inspect", status: "done", text: "Inspect context" },
			{ id: "todo-write", phaseId: "write", status: "running", text: "Implement changes" },
			{ id: "todo-verify", phaseId: "verify", status: "pending", text: "Verify results" },
			{ id: "todo-summarize", phaseId: "summarize", status: "pending", text: "Summarize delivery" }
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
		"## Available skills",
		...catalog.skills.map((skill): string => `- \`${skill.ref}\` [${skill.source}] ${skill.name} - ${skill.description || skill.error || "Invalid skill"} (${skill.enabled ? "enabled" : "disabled"})`)
	].join("\n");
}

async function sendChatText(
	socket: WebSocket,
	request: ClientRequest,
	text: string,
	session: ClientSession,
	mcpHost: McpHost,
	createSessionInfo: SessionInfoFactory,
	computerOverlayPreview?: ComputerOverlayPreview
): Promise<void> {
	if (request.method !== "ai.chat" || request.params.options?.stream !== true) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				text,
				context: createSessionInfo(session, mcpHost),
				...(computerOverlayPreview ? { computerOverlayPreview } : {})
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
				title: "Answer command",
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
			context: createSessionInfo(session, mcpHost),
			...(computerOverlayPreview ? { computerOverlayPreview } : {})
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
			await sendChatText(socket, request, `Provide a message after \`${command}\`.`, session, mcpHost, createSessionInfo);
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
			await sendChatText(socket, request, "Provide a task after `/workflow`.", session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		await sendChatText(socket, request, "The legacy Workflow command has been removed. Submit this task in Agent mode instead.", session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/test-computer-overlay") {
		const connection = getClientConnection(socket);
		const action = computerOverlayPreviewActionSchema.safeParse(restText || "running");
		let text: string;
		let preview: ComputerOverlayPreview | undefined;
		if (!isDevelopmentSlashCommandEnabled()) {
			text = `Unknown command: \`${command}\`\n\n${createSlashHelpText()}`;
		} else if (connection?.clientType !== "studio" || session.scheduledTaskOrigin || request.params.mode === "goal") {
			text = "This debug command is available only in interactive Windows desktop Studio sessions. Remote, Goal, and scheduled-task sessions are not supported.";
		} else if (!action.success) {
			text = "Usage: `/test-computer-overlay [running|paused|click|stop]`. Omitting the argument shows the running state.";
		} else if (!session.sessionId) {
			text = "Open or create a Studio session before previewing the computer-use overlay.";
		} else {
			preview = computerOverlayPreviewSchema.parse({
				connectionId: connection.connectionId,
				sessionId: session.sessionId,
				requestId: request.id,
				action: action.data,
			});
			text = action.data === "stop"
				? "Requested the debug overlay to close. This does not stop real computer use."
				: "Requested the computer-use debug overlay (development Windows Studio only). It does not start a model, observe windows, or send input. Use `paused` / `running` to change state and `click` to preview a click ripple; use Cancel, Ctrl+Alt+Esc, or `stop` to close it. The preview closes automatically after 5 minutes.";
		}
		// 预览指令仅随原请求响应返回，不持久化或广播成可重放的会话事件
		await sendChatText(socket, request, text, session, mcpHost, createSessionInfo, preview);
		return { type: "handled" };
	}

	if (command === "/test-approval") {
		if (!isDevelopmentSlashCommandEnabled()) {
			await sendChatText(socket, request, `Unknown command: \`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		await sendChatText(socket, request, await createTestApproval(socket, request, session), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/test-message-queue") {
		if (!isDevelopmentSlashCommandEnabled()) {
			await sendChatText(socket, request, `Unknown command: \`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		await sendChatText(socket, request, await createTestMessageQueue(socket, request, session), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/test-todo-list") {
		if (!isDevelopmentSlashCommandEnabled()) {
			await sendChatText(socket, request, `Unknown command: \`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}
		await sendChatText(socket, request, "Sent the Todo overlay UI test snapshot. No model or tool was called.", session, mcpHost, createSessionInfo);
		await emitTestTodoListSnapshot(socket, request, session);
		return { type: "handled" };
	}

	if (command === "/skills") {
		await sendChatText(socket, request, await formatSkillList(session), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/skill") {
		await sendChatText(socket, request, `Skills are activated per message. Type \`@\` in a message and select one or more skills.\n\n${await formatSkillList(session)}`, session, mcpHost, createSessionInfo);
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
					? `Create a ${personal ? "personal" : "project"} skill for me.\n\nRequirement: ${requirement}`
					: `Help me create a ${personal ? "personal" : "project"} skill. First ask which workflow this skill should solve, then create it.`
			}
		};
	}

	if (command === "/reset") {
		session.messages = [];
		session.fullSessionLoadPromise = undefined;
		await sendChatText(socket, request, "Cleared the current session history.", session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/init") {
		session.messages = [];
		session.fullSessionLoadPromise = undefined;
		const extraInstruction: string = restText.length > 0
			? `\n\nAdditional user requirements: ${restText}`
			: "";

		return {
			type: "ai",
			params: {
				...request.params,
				promptId: "godot.assistant",
				skillRefs: ["builtin:godot-project-init"],
				message: [
					"Initialize the AI collaboration context for the current Godot project.",
					"Use MCP tools to inspect the project summary, scenes, scripts, plugins, and key configuration.",
					"Generate AGENTS.md content for the project root and call the file-creation tool to request creating `AGENTS.md`.",
					"If `AGENTS.md` already exists, read and summarize it without overwriting it, and explain whether an update is recommended.",
					"When the file-creation tool requires approval, clearly report the approval ID and tell the user to approve it in the Godot client's Approvals area."
				].join("\n") + extraInstruction
			}
		};
	}

	await sendChatText(socket, request, `Unknown command: \`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
	return { type: "handled" };
}
