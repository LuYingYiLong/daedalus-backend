import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	applyProjectContextRouteOverride,
	applyWorkflowRouteSafety,
	createFallbackWorkflowRoute,
	hasComplexWriteIntent,
	hasWriteIntent,
	normalizeWorkflowRouteDecision,
	resolveForcedWorkflowRoute
} from "../../../src/workflow/router.js";

test("single mode keeps inspection read-only and bounded mutations lightweight", (): void => {
	const inspect = resolveForcedWorkflowRoute({
		message: "Inspect the active workspace.",
		mode: "agent",
		options: { workflow: "single" }
	});
	const mutate = resolveForcedWorkflowRoute({
		message: "Add /build/ to .gitignore.",
		mode: "agent",
		options: { workflow: "single" }
	});

	assert.equal(inspect?.intent, "inspect");
	assert.equal(inspect?.lane, "read");
	assert.equal(mutate?.intent, "mutate");
	assert.equal(mutate?.scope, "bounded");
	assert.equal(mutate?.lane, "lightweight");
});

test("explicit multi-phase mode always uses workflow", (): void => {
	const decision = resolveForcedWorkflowRoute({
		message: "Implement a character controller.",
		mode: "agent",
		options: { workflow: "multi_phase" }
	});

	assert.equal(decision?.intent, "mutate");
	assert.equal(decision?.scope, "complex");
	assert.equal(decision?.lane, "workflow");
	assert.equal(decision?.forcedByOption, "multi_phase");
});

test("read-only safety overrides mutation routes", (): void => {
	const decision = applyWorkflowRouteSafety({
		intent: "mutate",
		scope: "complex",
		lane: "workflow",
		reason: "Model selected a write workflow.",
		planningHint: "Modify scripts/a.gd."
	}, {
		message: "Read scripts/a.gd only; do not modify it.",
		mode: "agent"
	});

	assert.equal(decision.intent, "inspect");
	assert.equal(decision.scope, "bounded");
	assert.equal(decision.lane, "read");
	assert.equal(decision.safetyOverride, "explicit_read_only");
});

test("router output separates intent, scope, and lane", (): void => {
	const direct = normalizeWorkflowRouteDecision({
		intent: "answer",
		scope: "bounded",
		lane: "direct",
		reason: "Conceptual explanation.",
		planningHint: ""
	}, {
		message: "Explain this concept.",
		mode: "agent"
	});
	const probe = normalizeWorkflowRouteDecision({
		intent: "inspect",
		scope: "unknown",
		lane: "read",
		reason: "Read the scene tree first.",
		planningHint: ""
	}, {
		message: "Implement the requested level improvements.",
		mode: "agent"
	});

	assert.equal(direct.lane, "direct");
	assert.equal(probe.intent, "mutate");
	assert.equal(probe.scope, "unknown");
	assert.equal(probe.lane, "probe");
	assert.match(probe.reason, /safety guard/);
});

test("project-specific advice is upgraded from direct to read", (): void => {
	const decision = applyProjectContextRouteOverride({
		intent: "answer",
		scope: "bounded",
		lane: "direct",
		reason: "Generic advice.",
		planningHint: ""
	}, {
		message: "What could the current Daedalus Studio title bar add?",
		mode: "agent"
	}, {
		workspaceSummary: "id=studio\nname=Daedalus Studio\nrootPath=D:\\daedalus-studio",
		editorSummary: "editorInstanceId=none",
		additionalContextSummary: "No additional context."
	});

	assert.equal(decision.intent, "inspect");
	assert.equal(decision.lane, "read");
	assert.equal(decision.safetyOverride, "project_context_read");
});

test("fallback probes uncertain mutations and workflows complex changes", (): void => {
	const uncertain = createFallbackWorkflowRoute({
		message: "Change one setting.",
		mode: "agent"
	});
	const complex = createFallbackWorkflowRoute({
		message: "Refactor multiple files and migrate the configuration.",
		mode: "agent"
	});

	assert.equal(hasWriteIntent("Change one setting."), true);
	assert.equal(uncertain.intent, "mutate");
	assert.equal(uncertain.scope, "unknown");
	assert.equal(uncertain.lane, "probe");
	assert.equal(hasComplexWriteIntent("Add /build/ to .gitignore."), false);
	assert.equal(complex.scope, "complex");
	assert.equal(complex.lane, "workflow");
});

test("hidden probe exposes tool progress without creating workflow todos", async (): Promise<void> => {
	const source: string = await readFile(
		new URL("../../../src/server/chat-orchestrator.ts", import.meta.url),
		"utf8"
	);
	const hiddenStart: number = source.indexOf("async function runHiddenAnswerExecution");
	const escalationStart: number = source.indexOf("async function runHiddenAnswerExecutionWithEscalation");

	assert.ok(hiddenStart >= 0);
	assert.ok(escalationStart > hiddenStart);
	assert.equal(source.slice(hiddenStart, escalationStart).includes("sendWorkflowTodoSnapshot"), false);
	assert.equal(source.includes("daedalus_report_execution_decision"), true);
	assert.equal(source.includes('routeDecision.lane === "probe" ? "probing" : "executing"'), true);
	assert.equal(
		source.includes("if (effectiveParams.retryOfRunId === undefined) {\n\t\t\t\t\tawait appendUserMessageToSession("),
		true
	);
});
