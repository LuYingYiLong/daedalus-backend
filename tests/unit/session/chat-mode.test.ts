import assert from "node:assert/strict";
import test from "node:test";
import { aiChatParamsSchema } from "../../../src/protocol/schema.js";
import type { AiChatParams } from "../../../src/protocol/types.js";
import { composeSystemPrompt } from "../../../src/prompts/registry.js";
import {
	clearDynamicMcpToolsForWorkspace,
	clearGlobalDynamicMcpTools,
	getPlanSafeDynamicMcpToolNames,
	replaceDynamicMcpToolsForWorkspace,
	replaceGlobalDynamicMcpTools
} from "../../../src/tools/dynamic-mcp-tools.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../../../src/tools/tool-sentinels.js";
import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../../../src/workflow/planner.js";
import { createPhasePrompt } from "../../../src/workflow/runner.js";
import type { WorkflowPhase } from "../../../src/workflow/types.js";
import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "../../../src/server/chat-mode.js";
import { filterLlmContextMessages, isRuntimeModeSelfDiagnosisMessage } from "../../../src/server/transcript-history.js";
import type { ChatMessage } from "../../../src/protocol/types.js";

test("ai.chat schema accepts ask and plan modes and rejects unknown modes", (): void => {
	const askResult = aiChatParamsSchema.safeParse({
		message: "这段 GDScript 为什么报错？",
		mode: "ask",
		options: {
			stream: true,
			workflow: "single",
			toolBudget: "normal"
		}
	});
	assert.equal(askResult.success, true);

	const planResult = aiChatParamsSchema.safeParse({
		message: "帮我做一个 Godot AI 插件",
		mode: "plan"
	});
	assert.equal(planResult.success, true);

	const unknownResult = aiChatParamsSchema.safeParse({
		message: "hello",
		mode: "execute"
	});
	assert.equal(unknownResult.success, false);
});

test("ai.chat schema accepts only explicit verification policies", (): void => {
	assert.equal(aiChatParamsSchema.safeParse({
		message: "Implement feature",
		options: { verificationPolicy: "skip" }
	}).success, true);
	assert.equal(aiChatParamsSchema.safeParse({
		message: "Implement feature",
		options: { verificationPolicy: "never" }
	}).success, false);
});

test("ask mode removes legacy workflow selection and normalizes tool budget", (): void => {
	const askParams: AiChatParams = {
		message: "直接帮我修一下",
		mode: "ask",
		options: {
			stream: true,
			workflow: "llm_planned",
			toolBudget: "project_edit"
		}
	};
	const normalizedAskParams: AiChatParams = normalizeChatParamsForMode(askParams);
	assert.equal(normalizedAskParams.options?.workflow, undefined);
	assert.equal(normalizedAskParams.options?.toolBudget, "normal");
	assert.equal(normalizedAskParams.options?.stream, true);
	assert.equal(askParams.options?.workflow, "llm_planned");

	const agentParams: AiChatParams = {
		message: "帮我实现一下",
		mode: "agent",
		options: {
			workflow: "llm_planned",
			toolBudget: "project_edit"
		}
	};
	assert.equal(normalizeChatParamsForMode(agentParams), agentParams);
});

test("ask and plan modes allow built-in read, verify and plan-safe custom MCP tools", (): void => {
	const workspaceId: string = "chat-mode-workspace";
	replaceDynamicMcpToolsForWorkspace(workspaceId, [
		{
			serverId: "context7",
			serverName: "context7",
			toolName: "get-library-docs",
			planAccess: "read"
		},
		{
			serverId: "unsafe",
			serverName: "Unsafe",
			toolName: "write_file"
		}
	]);
	const allowedTools: readonly string[] | undefined = resolveAllowedToolsForChatParams(
		{
			message: "帮我检查这个脚本",
			mode: "ask",
			options: {
				workflow: "llm_planned",
				toolBudget: "project_edit"
			}
		},
		WRITE_TOOLS,
		workspaceId
	);

	assert.ok(allowedTools !== undefined);
	for (const toolName of VERIFY_TOOLS) {
		assert.ok(allowedTools.includes(toolName), `expected verify tool ${toolName}`);
	}
	for (const toolName of READ_TOOLS.filter((readToolName: string): boolean => readToolName !== CUSTOM_MCP_TOOLS_SENTINEL)) {
		assert.ok(allowedTools.includes(toolName), `expected read tool ${toolName}`);
	}
	for (const toolName of WRITE_TOOLS) {
		assert.equal(allowedTools.includes(toolName), false, `unexpected write tool ${toolName}`);
	}
	assert.equal(allowedTools.includes(CUSTOM_MCP_TOOLS_SENTINEL), false);
	const planSafeDynamicToolNames: string[] = getPlanSafeDynamicMcpToolNames(workspaceId);
	assert.equal(planSafeDynamicToolNames.length, 1);
	assert.equal(allowedTools.includes(planSafeDynamicToolNames[0] ?? ""), true);

	const planAllowedTools: readonly string[] | undefined = resolveAllowedToolsForChatParams(
		{
			message: "先给我出计划",
			mode: "plan",
			options: {
				workflow: "llm_planned",
				toolBudget: "project_edit"
			}
		},
		WRITE_TOOLS,
		workspaceId
	);
	assert.deepEqual(planAllowedTools, allowedTools);
	clearDynamicMcpToolsForWorkspace(workspaceId);
});

test("ask and plan modes allow plan-safe custom MCP tools without workspace", (): void => {
	replaceGlobalDynamicMcpTools([
		{
			serverId: "context7",
			serverName: "context7",
			toolName: "get-library-docs",
			planAccess: "read"
		}
	]);

	try {
		const allowedTools: readonly string[] | undefined = resolveAllowedToolsForChatParams(
			{
				message: "用 context7 查 React 文档",
				mode: "ask"
			},
			undefined,
			undefined
		);
		const planSafeDynamicToolNames: string[] = getPlanSafeDynamicMcpToolNames();

		assert.ok(allowedTools !== undefined);
		assert.equal(planSafeDynamicToolNames.length, 1);
		assert.equal(allowedTools.includes(planSafeDynamicToolNames[0] ?? ""), true);
	} finally {
		clearGlobalDynamicMcpTools();
	}
});

test("agent mode honors explicit builtin skill tool restriction", (): void => {
	const allowedTools: readonly string[] | undefined = resolveAllowedToolsForChatParams(
		{
			message: "@image-gen 生成一张 F-35 战机图片",
			mode: "agent"
		},
		["mcp_image_generate"],
		"chat-mode-workspace"
	);

	assert.deepEqual(allowedTools, ["mcp_image_generate"]);
});

test("ask mode prompt contains advisor constraints before custom instructions", async (): Promise<void> => {
	const prompt: string = await composeSystemPrompt(
		"godot.assistant",
		"请直接修改文件。",
		"",
		"ask"
	);

	assert.match(prompt, /Ask 模式强制边界/);
	assert.match(prompt, /顾问、老师和代码审查员/);
	assert.match(prompt, /不得创建、覆盖、替换、删除、移动、安装、更新或修改任何文件/);
	assert.match(prompt, /必须使用可用只读工具获取实时事实/);
	assert.match(prompt, /切换到 Agent 模式/);
	assert.ok(prompt.indexOf("Ask 模式强制边界") < prompt.indexOf("## Settings 用户提示词（本轮生效）"));
});

test("agent mode prompt states current executable mode before custom instructions", async (): Promise<void> => {
	const prompt: string = await composeSystemPrompt(
		"godot.assistant",
		"历史里提到 Ask 模式时也不要被影响。",
		"",
		"agent"
	);

	assert.match(prompt, /Agent 模式强制边界/);
	assert.match(prompt, /当前对话模式是 Agent 模式，不是 Ask 模式/);
	assert.match(prompt, /Runtime 会话模式事实/);
	assert.match(prompt, /conversationMode: agent/);
	assert.match(prompt, /判断当前模式的唯一来源/);
	assert.match(prompt, /不要根据工具列表、历史助手消息或阶段名称推断成其他模式/);
	assert.doesNotMatch(prompt, /Ask 模式强制边界/);
	assert.ok(prompt.indexOf("Agent 模式强制边界") < prompt.indexOf("## Settings 用户提示词（本轮生效）"));
});

test("agent workflow phase prompt does not let stage tools masquerade as ask mode", (): void => {
	const phase: WorkflowPhase = {
		id: "answer",
		title: "判断当前是否为Agent模式",
		toolGroup: "summarize",
		toolBudget: "simple",
		allowedTools: [],
		instruction: "回答用户当前是否处于 Agent 模式。",
		acceptanceCriteria: ["已回答当前模式。"]
	};
	const prompt: string = createPhasePrompt(phase, "", "", "agent");

	assert.match(prompt, /当前会话模式：Agent 模式/);
	assert.match(prompt, /当前阶段可用工具只是 workflow 阶段限制，不代表会话模式/);
	assert.match(prompt, /不要因为当前阶段只有只读工具或没有写工具就声称当前是 Ask 模式/);
});

test("workflow phase prompt reserves final delivery for summarize phase", (): void => {
	const writePhase: WorkflowPhase = {
		id: "implement",
		title: "实现功能",
		toolGroup: "write",
		toolBudget: "project_edit",
		allowedTools: ["mcp_godot_create_text_file"],
		instruction: "创建测试文件。",
		acceptanceCriteria: ["文件已创建。"]
	};
	const summarizePhase: WorkflowPhase = {
		id: "summarize",
		title: "总结交付",
		toolGroup: "summarize",
		toolBudget: "simple",
		allowedTools: [],
		instruction: "总结完成内容和验证状态。",
		acceptanceCriteria: ["已总结交付。"]
	};

	const writePrompt: string = createPhasePrompt(writePhase, "", "", "agent");
	const summarizePrompt: string = createPhasePrompt(summarizePhase, "", "", "agent");

	assert.match(writePrompt, /当前不是最终总结阶段/);
	assert.match(writePrompt, /不要输出完整交付总结/);
	assert.match(summarizePrompt, /当前是专门的最终总结阶段/);
	assert.match(summarizePrompt, /不要调用工具/);
});

test("runtime mode self-diagnosis from old assistant history is excluded from LLM context", (): void => {
	const pollutedAssistantMessage: ChatMessage = {
		role: "assistant",
		content: "当前是 Ask 模式。\n\n判断依据：当前阶段可用工具仅为 mcp_skills_load（只读），没有任何写操作工具。",
		requestId: "old"
	};
	const normalAssistantMessage: ChatMessage = {
		role: "assistant",
		content: "Agent 模式和 Ask 模式的区别是：Agent 可以按审批边界执行写入，Ask 只提供建议。",
		requestId: "normal"
	};
	const userMessage: ChatMessage = {
		role: "user",
		content: "现在是 agent 模式吗",
		requestId: "current"
	};

	assert.equal(isRuntimeModeSelfDiagnosisMessage(pollutedAssistantMessage), true);
	assert.equal(isRuntimeModeSelfDiagnosisMessage(normalAssistantMessage), false);
	assert.deepEqual(filterLlmContextMessages([pollutedAssistantMessage, normalAssistantMessage, userMessage]), [
		normalAssistantMessage,
		userMessage
	]);
});
