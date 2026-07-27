import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	applyProjectContextRouteOverride,
	applyWorkflowRouteSafety,
	createFallbackWorkflowRoute,
	normalizeWorkflowRouteDecision,
	resolveForcedWorkflowRoute
} from "../../../src/workflow/router.js";

test("workflow router forces single mode to hidden tool answer", (): void => {
	const decision = resolveForcedWorkflowRoute({
		message: "当前是什么工作区？",
		mode: "agent",
		options: {
			workflow: "single"
		}
	});

	assert.equal(decision?.execution, "tool_answer");
	assert.equal(decision?.requiresWrite, false);
	assert.equal(decision?.forcedByOption, "single");
});

test("workflow router forces explicit multi-phase mode to workflow", (): void => {
	const decision = resolveForcedWorkflowRoute({
		message: "实现一个角色控制器",
		mode: "agent",
		options: {
			workflow: "multi_phase"
		}
	});

	assert.equal(decision?.execution, "workflow");
	assert.equal(decision?.requiresWrite, true);
	assert.equal(decision?.forcedByOption, "multi_phase");
});

test("workflow router safety override prevents read-only requests from becoming write workflows", (): void => {
	const decision = applyWorkflowRouteSafety({
		execution: "workflow",
		reason: "Model thought this needs a write plan.",
		requiresTools: true,
		requiresWrite: true,
		planningHint: "Modify scripts/a.gd."
	}, {
		message: "只读 scripts/a.gd，不要修改",
		mode: "agent"
	});

	assert.equal(decision.execution, "tool_answer");
	assert.equal(decision.requiresWrite, false);
	assert.equal(decision.safetyOverride, "explicit_read_only");
});

test("workflow router normalizes direct and tool answers without workflow todos", (): void => {
	assert.equal(normalizeWorkflowRouteDecision({
		execution: "direct_answer",
		reason: "Conceptual explanation.",
		requiresTools: false,
		requiresWrite: false,
		planningHint: ""
	}, {
		message: "解释一下这个概念",
		mode: "agent"
	}).execution, "direct_answer");

	assert.equal(createFallbackWorkflowRoute({
		message: "当前是什么工作区？",
		mode: "agent"
	}).execution, "tool_answer");
});

test("workflow router upgrades project-specific advice to hidden read-only tool answer", (): void => {
	const decision = applyProjectContextRouteOverride({
		execution: "direct_answer",
		reason: "User asks for menu suggestions.",
		requiresTools: false,
		requiresWrite: false,
		planningHint: ""
	}, {
		message: "我修好了，你觉得Daedalus-studio的标题栏的菜单栏可以添加什么，先不动文件",
		mode: "agent"
	}, {
		workspaceSummary: [
			"id=runtime-e51fa33500",
			"name=Daedalus Studio",
			"kind=electron",
			"rootPath=D:\\daedalus-studio"
		].join("\n"),
		editorSummary: "editorInstanceId=none",
		additionalContextSummary: "No additional context."
	});

	assert.equal(decision.execution, "tool_answer");
	assert.equal(decision.requiresTools, true);
	assert.equal(decision.requiresWrite, false);
	assert.equal(decision.safetyOverride, "project_context_read");
});

test("workflow router respects explicit requests to avoid reading project files", (): void => {
	const decision = applyProjectContextRouteOverride({
		execution: "direct_answer",
		reason: "User asks for generic suggestions.",
		requiresTools: false,
		requiresWrite: false,
		planningHint: ""
	}, {
		message: "不要看代码，只凭经验说标题栏菜单栏可以添加什么",
		mode: "agent"
	}, {
		workspaceSummary: [
			"id=runtime-e51fa33500",
			"name=Daedalus Studio",
			"kind=electron",
			"rootPath=D:\\daedalus-studio"
		].join("\n"),
		editorSummary: "editorInstanceId=none",
		additionalContextSummary: "No additional context."
	});

	assert.equal(decision.execution, "direct_answer");
	assert.equal(decision.requiresTools, false);
});

test("workflow router fallback treats short edit confirmations as workflow", (): void => {
	const decision = createFallbackWorkflowRoute({
		message: "帮我改一下",
		mode: "agent"
	});

	assert.equal(decision.execution, "workflow");
	assert.equal(decision.requiresWrite, true);
	assert.equal(decision.safetyOverride, "router_fallback");
});

test("chat orchestrator has a hidden answer path that does not emit workflow todo snapshots", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const hiddenAnswerStart: number = source.indexOf("async function runHiddenAnswerExecution");
	const workflowStart: number = source.indexOf("startWorkflowExecution(", hiddenAnswerStart);

	assert.ok(hiddenAnswerStart >= 0);
	assert.ok(workflowStart > hiddenAnswerStart);
	assert.equal(source.slice(hiddenAnswerStart, workflowStart).includes("sendWorkflowTodoSnapshot"), false);
	assert.equal(source.includes("workflow_route_decided"), true);
});

test("chat orchestrator constrains hidden read-only tool answers", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");

	assert.equal(source.includes("function createHiddenAnswerChatParams"), true);
	assert.equal(source.includes('toolBudget: params.options?.toolBudget ?? "simple"'), true);
	assert.equal(source.includes("function createHiddenAnswerSystemPrompt"), true);
	assert.equal(source.includes("隐藏只读回答收束规则"), true);
	assert.equal(source.includes("达到工具预算后必须停止并直接回答"), true);
	assert.equal(source.includes("routeDecision,"), true);
});

test("chat orchestrator prefers deterministic Godot templates before LLM workflow planning", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const plannerFunctionStart: number = source.indexOf("async function createWorkflowPlanForRoute");
	const preferredTemplateIndex: number = source.indexOf("const preferredTemplate", plannerFunctionStart);
	const llmPlannerIndex: number = source.indexOf("createLlmWorkflowPlan", plannerFunctionStart);
	const runtimeProbeIndex: number = source.indexOf("hasGodotProjectFile", plannerFunctionStart);

	assert.ok(plannerFunctionStart >= 0);
	assert.ok(preferredTemplateIndex > plannerFunctionStart);
	assert.ok(llmPlannerIndex > preferredTemplateIndex);
	assert.ok(runtimeProbeIndex > plannerFunctionStart);
	assert.equal(source.includes('params.options?.workflow !== "llm_planned"'), true);
});

test("llm workflow planner only requires first tool calls for write and verify phases", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/workflow/llm-planner.ts", import.meta.url), "utf8");

	assert.equal(source.includes('toolGroup === "read" || toolGroup === "write"'), false);
	assert.equal(source.includes('toolGroup === "write" || toolGroup === "verify" ? true : undefined'), true);
});

test("chat orchestrator emits run started before workflow routing", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const registerIndex: number = source.indexOf("registerSessionRunController(runSessionId, request.id, abortController)");
	const startedIndex: number = source.indexOf("sendSessionEvent(socket, request.id, session, \"agent.run.started\"");
	const routeIndex: number = source.indexOf("routeWorkflowExecution(", startedIndex);

	assert.ok(registerIndex >= 0);
	assert.ok(startedIndex > registerIndex);
	assert.ok(routeIndex > startedIndex);
});

test("explicit write-capable skills keep write tools in hidden tool answer", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const helperIndex: number = source.indexOf("function toolNamesIncludeWriteRisk");
	const postRouteHelperIndex: number = source.indexOf("function applyExplicitSkillWriteRequirement");
	const explicitSkillRouteIndex: number = source.indexOf("Explicit skill tool restriction uses hidden single-turn tool execution.");
	const requiresWriteIndex: number = source.indexOf("requiresWrite: skillRestrictionRequiresWrite", explicitSkillRouteIndex);
	const postRouteApplyIndex: number = source.indexOf("routeDecision = applyExplicitSkillWriteRequirement");
	const requiredToolCallIndex: number = source.indexOf("options.requireToolCallOnFirstStep = true");

	assert.ok(helperIndex >= 0);
	assert.ok(postRouteHelperIndex > helperIndex);
	assert.ok(explicitSkillRouteIndex > helperIndex);
	assert.ok(requiresWriteIndex > explicitSkillRouteIndex);
	assert.ok(postRouteApplyIndex > explicitSkillRouteIndex);
	assert.ok(requiredToolCallIndex >= 0);
	assert.equal(source.includes("toolNamesIncludeWriteRisk(builtinToolRestriction"), true);
});

test("chat orchestrator cancel requests abort and leaves finalization to the active run", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const cancelStart: number = source.indexOf("case \"ai.cancel\"");
	const chatStart: number = source.indexOf("case \"ai.chat\"");
	const cancelBlock: string = source.slice(cancelStart, chatStart);

	assert.ok(cancelStart >= 0);
	assert.ok(chatStart > cancelStart);
	assert.equal(cancelBlock.includes("status: \"cancelling\""), true);
	assert.equal(cancelBlock.includes("controller.abort();"), true);
	assert.equal(cancelBlock.includes("cancellationRequested: controller !== undefined"), true);
	assert.equal(cancelBlock.includes("const alreadyFinished: boolean = controller === undefined"), true);
	assert.equal(cancelBlock.includes("alreadyFinished,"), true);
	assert.equal(cancelBlock.includes("sendAgentCancelled(socket, targetRequestId, session);"), false);
	const pendingCancellationGuard: number = cancelBlock.indexOf("if (cancelledApprovalIds.length > 0 || cancelledToolBudgetIds.length > 0)");
	const finishRun: number = cancelBlock.indexOf("finishSessionRun(session.sessionId, targetRequestId);");
	assert.ok(pendingCancellationGuard >= 0);
	assert.ok(finishRun > pendingCancellationGuard);
});

test("workflow cancellation cannot fall through to fallback planning or a later phase", async (): Promise<void> => {
	const chatSource: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const continuationSource: string = await readFile(new URL("../../../src/server/workflow/continuation.ts", import.meta.url), "utf8");
	const phaseRunnerSource: string = await readFile(new URL("../../../src/server/workflow/phase-runner.ts", import.meta.url), "utf8");
	const approvalSource: string = await readFile(new URL("../../../src/server/handlers/approval-handlers.ts", import.meta.url), "utf8");
	const plannerStart: number = chatSource.indexOf("async function createWorkflowPlanForRoute");
	const plannerEnd: number = chatSource.indexOf("async function createGodotTemplateWorkflowPlanForRuntime", plannerStart);
	const plannerBlock: string = chatSource.slice(plannerStart, plannerEnd);

	assert.ok(plannerStart >= 0);
	assert.ok(plannerEnd > plannerStart);
	assert.equal(plannerBlock.includes("if (isCancellationError(error, abortSignal))"), true);
	assert.equal(plannerBlock.includes("throw error;"), true);
	assert.match(
		chatSource,
		/if \(isCancellationError\(error, abortController\.signal\)\) \{\s*throw error;/
	);
	assert.equal(continuationSource.includes("throwIfAborted(abortSignal);\n\t\tconst candidatePhase"), true);
	assert.equal(continuationSource.includes("awaitWithAbort(runWorkflowPhase("), true);
	assert.equal(continuationSource.includes("awaitWithAbort(reviseLlmWorkflowPlan("), true);
	assert.equal(phaseRunnerSource.includes("throwIfAborted(abortSignal);\n\tconst runtimePhase"), true);
	assert.equal(approvalSource.includes("session.activeAbortControllers.set(continuationRequestId, abortController);"), true);
});

test("chat orchestrator final cleanup only updates the workbench for the owned run", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const finallyStart: number = source.indexOf("const ownsActiveRun: boolean = session.activeRunRequestId === request.id");
	const idleUpdate: number = source.indexOf("setWorkbenchActiveRun(session, {", finallyStart);
	const finishRun: number = source.indexOf("finishSessionRun(runSessionId, request.id);", finallyStart);

	assert.ok(finallyStart >= 0);
	assert.ok(idleUpdate > finallyStart);
	assert.ok(finishRun > idleUpdate);
	assert.equal(source.slice(finallyStart, finishRun).includes("if (ownsActiveRun)"), true);
});

test("chat orchestrator preserves workflow failures instead of reclassifying them as provider errors", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const workflowErrorIndex: number = source.indexOf("if (error instanceof WorkflowExecutionError)");
	const providerErrorIndex: number = source.indexOf("const providerError = classifyProviderError(error);");

	assert.ok(workflowErrorIndex >= 0);
	assert.ok(providerErrorIndex > workflowErrorIndex);
	assert.equal(source.slice(workflowErrorIndex, providerErrorIndex).includes("code: \"agent_run_error\""), true);
	assert.equal(source.slice(workflowErrorIndex, providerErrorIndex).includes("workflow_failed"), true);
});

test("approval continuation workflow failures emit terminal run errors on the original request", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/handlers/approval-handlers.ts", import.meta.url), "utf8");
	const catchIndex: number = source.indexOf("if (error instanceof WorkflowExecutionError)");
	const responseIndex: number = source.indexOf("sendJson(socket, {", catchIndex);
	const errorBlock: string = source.slice(catchIndex, responseIndex);

	assert.ok(catchIndex >= 0);
	assert.equal(errorBlock.includes("sendWorkflowEvent(socket, continuationRequestId, session, \"workflow.error\""), true);
	assert.equal(errorBlock.includes("requestId: continuationRequestId"), true);
	assert.equal(errorBlock.includes("code: \"agent_run_error\""), true);
	assert.equal(source.includes("sendAgentCancelled(socket, continuationRequestId, session);"), true);
});

test("workflow runtime phases keep workspace-scoped tools during execution", async (): Promise<void> => {
	const continuationSource: string = await readFile(new URL("../../../src/server/workflow/continuation.ts", import.meta.url), "utf8");
	const phaseRunnerSource: string = await readFile(new URL("../../../src/server/workflow/phase-runner.ts", import.meta.url), "utf8");

	assert.equal(continuationSource.includes("createRuntimeWorkflowPhase(phase, mcpHost, session)"), true);
	assert.equal(phaseRunnerSource.includes("phase.allowedTools.includes(SKILL_LOAD_TOOL) ? [...phase.allowedTools] : [...phase.allowedTools, SKILL_LOAD_TOOL]"), false);
	assert.equal(phaseRunnerSource.includes("runtimePhase.allowedTools.includes(SKILL_LOAD_TOOL)"), true);
});
