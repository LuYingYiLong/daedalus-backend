import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApprovedPlanExecutionParams, createPlanDecision, createPlannerMessage, createPlannerSystemPrompt, createPlanVisibleDeltaFilter, normalizePlanDecision } from "../../../src/server/plan-mode.js";
import { createPlanMetadata } from "../../../src/server/plan-store.js";
import type { StoredPlan } from "../../../src/server/plan-store.js";
import type { ProviderChatOptions } from "../../../src/providers/deepseek-client.js";
import { shouldPersistSessionEvent } from "../../../src/server/session-events.js";

const DUMMY_PROVIDER: ProviderChatOptions = {
	provider: "deepseek",
	apiKey: "test-key",
	model: "deepseek-v4-pro"
};

test("broad Godot AI plugin goal requires clarification with at most three replies", async (): Promise<void> => {
	const decision = await createPlanDecision({
		message: "帮我做一个 godot ai 插件",
		mode: "plan"
	}, DUMMY_PROVIDER);

	assert.equal(decision.decision, "needs_clarification");
	assert.ok(decision.question.length > 0);
	assert.ok(decision.recommendedReplies.length > 0);
	assert.ok(decision.recommendedReplies.length <= 3);
	assert.ok(decision.recommendedReplies.some((reply): boolean => reply.text.includes("前端")));
});

test("a skipped clarification is explicit planner input rather than a synthetic user reply", (): void => {
	const message = createPlannerMessage(
		"Make the feature",
		[],
		[{ question: "Which platform should be supported?", skippedAt: "2026-08-06T00:00:00.000Z" }],
		[]
	);

	assert.match(message, /信息未提供/u);
	assert.match(message, /Which platform should be supported\?/u);
	assert.match(message, /必须继续规划/u);
	assert.doesNotMatch(message, /Continue with the current assumptions/u);
});

test("plan clarification normalization accepts common reply aliases", (): void => {
	const decision = normalizePlanDecision({
		decision: "needs_clarification",
		title: "玩法澄清",
		clarificationQuestion: "请选择五子棋玩法。",
		options: [
			{
				title: "双人同屏",
				value: "做一个双人同屏本地五子棋。",
				description: "只需要落子和胜负判定。"
			},
			"做人机对战版本。"
		]
	}, "执行计划");

	assert.equal(decision.decision, "needs_clarification");
	assert.equal(decision.question, "请选择五子棋玩法。");
	assert.deepEqual(decision.recommendedReplies, [
		{
			label: "双人同屏",
			text: "做一个双人同屏本地五子棋。",
			description: "只需要落子和胜负判定。"
		},
		{
			label: "做人机对战版本。",
			text: "做人机对战版本。"
		}
	]);
});

test("plan clarification normalization allows a custom-answer-only question", (): void => {
	const decision = normalizePlanDecision({
		title: "技术栈澄清",
		question: "你希望用网页、命令行还是 Godot 场景实现？"
	}, "执行计划");

	assert.equal(decision.decision, "needs_clarification");
	assert.equal(decision.question, "你希望用网页、命令行还是 Godot 场景实现？");
	assert.deepEqual(decision.recommendedReplies, []);
});

test("plan normalization infers ready plans from structured fields without a decision", (): void => {
	const decision = normalizePlanDecision({
		title: "本地五子棋计划",
		summary: "实现一个本地双人五子棋。",
		keyChanges: [
			"新增棋盘状态",
			"实现落子和胜负判定"
		],
		testPlan: [
			"验证横竖斜五连"
		]
	}, "执行计划");

	assert.equal(decision.decision, "plan_ready");
	assert.match(decision.planMarkdown, /# 本地五子棋计划/);
	assert.match(decision.planMarkdown, /## Summary/);
	assert.match(decision.planMarkdown, /实现一个本地双人五子棋/);
	assert.match(decision.planMarkdown, /## Key Changes/);
	assert.match(decision.planMarkdown, /新增棋盘状态/);
});

test("plan metadata stores PLAN.md under the session plan directory", (): void => {
	const metadata = createPlanMetadata({
		sessionId: "session-20260709-test",
		requestId: "request-1",
		status: "ready",
		title: "测试计划",
		originalMessage: "请先计划",
		previewMarkdown: "# 测试计划"
	});

	assert.match(metadata.planId, /^plan-/);
	assert.equal(metadata.planPath, `plans/${metadata.planId}/PLAN.md`);
	assert.equal(metadata.status, "ready");
	assert.equal(metadata.previewMarkdown, "# 测试计划");
});

test("planner prompt anchors backend plans to actual repository conventions", async (): Promise<void> => {
	const prompt = await createPlannerSystemPrompt();

	assert.match(prompt, /# CORE/);
	assert.match(prompt, /调用工具前/);
	assert.match(prompt, /澄清前/);
	assert.match(prompt, /TypeScript WebSocket\/RPC/);
	assert.match(prompt, /zod schema/);
	assert.match(prompt, /Node 内置 test runner/);
	assert.match(prompt, /不要.*Vitest/);
	assert.match(prompt, /不要.*gRPC/);
});

test("plan visible delta filter forwards preludes but suppresses final json", (): void => {
	const filter = createPlanVisibleDeltaFilter();

	assert.equal(filter.push("我先读取项目结构，再判断计划边界。\n"), "我先读取项目结构，再判断计划边界。\n");
	assert.equal(filter.push("\n"), "");
	assert.equal(filter.push("{\"decision\":\"plan_ready\""), "");
	assert.equal(filter.push(",\"title\":\"测试\"}"), "");
});

test("plan mode does not inject hardcoded visible status prose", async (): Promise<void> => {
	const planModeSource: string = await readFile(new URL("../../../src/server/plan-mode.ts", import.meta.url), "utf8");
	const planHandlersSource: string = await readFile(new URL("../../../src/server/handlers/plan-handlers.ts", import.meta.url), "utf8");
	const source: string = `${planModeSource}\n${planHandlersSource}`;

	assert.equal(source.includes("我需要先确认一个关键点"), false);
	assert.equal(source.includes("我需要先读取最小必要上下文"), false);
	assert.equal(source.includes("我还需要继续确认一个关键点"), false);
	assert.equal(source.includes("我正在吸收你的澄清"), false);
	assert.equal(source.includes("我正在根据你的反馈修订计划"), false);
	assert.equal(source.includes("我已根据你的澄清生成计划"), false);
	assert.equal(source.includes("我已根据你的反馈修订计划"), false);
});

test("plan mode does not hard-fail when provider omits read tool calls", async (): Promise<void> => {
	const planModeSource: string = await readFile(new URL("../../../src/server/plan-mode.ts", import.meta.url), "utf8");

	assert.match(planModeSource, /runtime\.requireToolInspection === true/);
	assert.equal(planModeSource.includes("Plan runner did not call any read/verify tool before producing a plan."), false);
	assert.match(planModeSource, /plan_ready_without_tool_inspection/);
});

test("plan events are persisted for timeline recovery", (): void => {
	assert.equal(shouldPersistSessionEvent("plan.clarification.required"), true);
	assert.equal(shouldPersistSessionEvent("plan.generated"), true);
	assert.equal(shouldPersistSessionEvent("plan.revised"), true);
});

test("approved plan execution forces agent multi-phase workflow", (): void => {
	const plan: StoredPlan = {
		metadata: createPlanMetadata({
			sessionId: "session-20260712-test",
			requestId: "request-1",
			status: "ready",
			title: "审批测试计划",
			originalMessage: "审批",
			previewMarkdown: "Summary"
		}),
		markdown: "# 审批测试计划\n\n## Summary\n执行一次需要审批的写入测试。"
	};
	const params = createApprovedPlanExecutionParams(plan, "moonshot", "kimi-k3");

	assert.equal(params.mode, "agent");
	assert.equal(params.options?.workflow, "multi_phase");
	assert.equal(params.options?.toolBudget, "project_edit");
	assert.equal(params.message, "执行计划。");
	assert.equal(params.provider, "moonshot");
	assert.equal(params.model, "kimi-k3");
	assert.match(params.systemPrompt ?? "", /执行阶段必须以该计划为主要约束/);
	assert.match(params.systemPrompt ?? "", /原始用户请求：\n审批/);
});

test("plan approval persists agent mode and streams every execution phase", async (): Promise<void> => {
	const planHandlersSource: string = await readFile(new URL("../../../src/server/handlers/plan-handlers.ts", import.meta.url), "utf8");
	const continuationSource: string = await readFile(new URL("../../../src/server/workflow/continuation.ts", import.meta.url), "utf8");
	const modeSwitchIndex: number = planHandlersSource.indexOf('session.workbenchComposer.chatMode = "agent"');
	const executionStartIndex: number = planHandlersSource.indexOf("await handleChatRequest(socket, executionRequest");

	assert.ok(modeSwitchIndex >= 0);
	assert.ok(executionStartIndex > modeSwitchIndex);
	assert.match(planHandlersSource, /updateSessionMetadata\(sessionId, createRuntimeSessionUiMetadata\(session\)\)/);
	assert.match(planHandlersSource, /workbench: serializeWorkbench\(session\)/);
	assert.match(continuationSource, /const streamPhase: boolean = streamFinal/);
});

test("plan clarification and revision runs are cancellable active runs", async (): Promise<void> => {
	const planHandlersSource: string = await readFile(new URL("../../../src/server/handlers/plan-handlers.ts", import.meta.url), "utf8");

	assert.match(planHandlersSource, /function beginPlanOperationRun/);
	assert.match(planHandlersSource, /beginSessionRun\(session\.sessionId, runRequestId\)/);
	assert.match(planHandlersSource, /session\.activeAbortControllers\.set\(requestId, abortController\)/);
	assert.match(planHandlersSource, /session\.activeAbortControllers\.set\(runRequestId, abortController\)/);
	assert.match(planHandlersSource, /registerSessionRunController\(session\.sessionId, runRequestId, abortController\)/);
	assert.match(planHandlersSource, /setWorkbenchActiveRun\(session, \{\s*status: "streaming",\s*requestId: runRequestId/s);
	assert.match(planHandlersSource, /sendSessionEvent\(socket, runRequestId, session, "agent\.run\.started"/);
	assert.match(planHandlersSource, /applyPlanClarification\([\s\S]*activePlanOperation\.abortController\.signal/);
	assert.match(planHandlersSource, /applyPlanRevision\([\s\S]*activePlanOperation\.abortController\.signal/);
	assert.match(planHandlersSource, /isCancellationError\(error, failedAbortSignal\)/);
});

test("plan operation failures are visible as agent run errors", async (): Promise<void> => {
	const planHandlersSource: string = await readFile(new URL("../../../src/server/handlers/plan-handlers.ts", import.meta.url), "utf8");

	assert.match(planHandlersSource, /sendSessionEvent\(socket, failedRunRequestId, session, "agent\.run\.error"/);
	assert.match(planHandlersSource, /operationRequestId: request\.id/);
	assert.match(planHandlersSource, /sendSessionEvent\(socket, request\.id, session, "plan\.error"/);
	assert.match(planHandlersSource, /requestId: failedRunRequestId \?\? request\.id/);
});
