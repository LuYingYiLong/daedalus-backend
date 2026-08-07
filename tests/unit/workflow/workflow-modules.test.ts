import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
import type { WorkflowPhase } from "../../../src/workflow/types.js";
import { planWorkflow, planWorkflowAfterLlmPlannerFailure } from "../../../src/workflow/planner.js";
import { createStructuredWorkflowCompletionContract } from "../../../src/workflow/completion-contract.js";
import { getWorkflowToolsForProfile } from "../../../src/workflow/execution-profile.js";
import { applyWorkflowVerificationPolicy } from "../../../src/workflow/verification-policy.js";
import {
	createEmptyWorkflowPhaseToolStats,
	didWorkflowWritePhaseExecute,
	getWorkflowWriteGuardRetryAllowedTools,
	updateWorkflowPhaseToolStats
} from "../../../src/server/workflow/tool-events.js";
import { mapWorkflowEventToAgentEvent } from "../../../src/server/workflow/events.js";

test("workflow planner uses the neutral provider chat gateway", async (): Promise<void> => {
	const source = await readFile(new URL("../../../src/workflow/llm-planner.ts", import.meta.url), "utf8");
	assert.match(source, /chatWithProvider/u);
	assert.equal(source.includes("chatWithDeepSeek"), false);
	assert.match(source, /completionTargets/u);
	assert.equal(source.includes("createWorkflowCompletionContract"), false);
});

test("fixed fallback requires an exact structured target and respects read-only policy", (): void => {
	const params = { message: "Anything", mode: "agent" as const, options: { workflow: "llm_planned" as const } };
	assert.equal(planWorkflowAfterLlmPlannerFailure(params), null);
	const fallback = planWorkflowAfterLlmPlannerFailure(params, "godot", {
		targets: [{ kind: "artifact", path: "scripts/player.gd", targetKind: "godot_script" }],
		requireAll: true
	});
	assert.deepEqual(fallback?.phases.map((phase: WorkflowPhase): WorkflowPhase["toolGroup"] => phase.toolGroup), ["read", "write", "verify", "summarize"]);
	assert.deepEqual(fallback?.phases.find((phase: WorkflowPhase): boolean => phase.toolGroup === "write")?.completionContract?.targets, [
		{ kind: "artifact", path: "scripts/player.gd", targetKind: "godot_script" }
	]);
	assert.equal(planWorkflow({ message: "Anything", mode: "agent", options: { executionPolicy: "read_only" } }), null);
});

test("verification policy is applied structurally after target-bound fallback planning", (): void => {
	const skipPlan = planWorkflowAfterLlmPlannerFailure({
		message: "Any prose is irrelevant to policy",
		mode: "agent",
		options: { verificationPolicy: "skip" }
	}, "godot", {
		targets: [{ kind: "artifact", path: "scripts/player.gd", targetKind: "godot_script" }],
		requireAll: true
	});
	assert.equal(skipPlan?.verificationPolicy, "skip");
	assert.equal(skipPlan?.phases.some((phase: WorkflowPhase): boolean => phase.toolGroup === "verify"), false);

	const requiredPlan = applyWorkflowVerificationPolicy({
		id: "workflow-required",
		title: "write then summarize",
		phases: [
			{ id: "write", title: "Write", toolGroup: "write", toolBudget: "project_edit", allowedTools: [], instruction: "Write" },
			{ id: "summarize", title: "Summarize", toolGroup: "summarize", toolBudget: "simple", allowedTools: [], instruction: "Summarize" }
		],
		todos: [],
		executionProfile: "godot"
	}, { message: "Any prose", options: { verificationPolicy: "required" } });
	assert.deepEqual(requiredPlan.phases.map((phase: WorkflowPhase): string | undefined => phase.toolGroup), ["write", "verify", "summarize"]);
	assert.equal(requiredPlan.phases[1]?.allowedTools.includes("mcp_godot_lsp_get_file_diagnostics"), false);
});

test("workspace workflow profile overrides Godot prompt and skill defaults", (): void => {
	const fallback = planWorkflowAfterLlmPlannerFailure({
		message: "Update a TypeScript service",
		mode: "agent",
		promptId: "godot.assistant",
		options: { workflow: "llm_planned" }
	}, "workspace", {
		targets: [{ kind: "artifact", path: "src/service.ts", targetKind: "workspace_file" }],
		requireAll: true
	});
	assert.equal(fallback?.executionProfile, "workspace");
	assert.deepEqual(
		fallback?.phases.map((phase: WorkflowPhase): string | undefined => phase.promptId),
		[undefined, "workspace.assistant", undefined, "workspace.assistant"]
	);
	assert.deepEqual(
		fallback?.phases.map((phase: WorkflowPhase): string | undefined => phase.skillId),
		[undefined, undefined, undefined, undefined]
	);
	assert.doesNotMatch(fallback?.phases.map((phase: WorkflowPhase): string => phase.instruction).join("\n") ?? "", /Godot|GDScript|scene|LSP/u);
	assert.equal(
		fallback?.phases.some((phase: WorkflowPhase): boolean => phase.allowedTools.some((toolName: string): boolean => toolName.startsWith("mcp_godot_"))),
		false
	);
});

test("LLM planned tools come only from the execution profile and not phase prose", (): void => {
	const godotTools = getWorkflowToolsForProfile("godot", "write");
	const workspaceTools = getWorkflowToolsForProfile("workspace", "write");
	assert.equal(godotTools.includes("mcp_godot_create_text_file"), true);
	assert.equal(workspaceTools.some((toolName: string): boolean => toolName.startsWith("mcp_godot_")), false);
});

test("LLM completion contracts only accept structured, exact targets", (): void => {
	assert.deepEqual(createStructuredWorkflowCompletionContract("write", {
		artifacts: ["scenes/Main.tscn", "index.html（rewrite result）", "../outside.py"],
		projectSettings: ["application/run/main_scene", "a prose setting"]
	})?.targets, [
		{ kind: "artifact", path: "scenes/Main.tscn" },
		{ kind: "project_setting", key: "application/run/main_scene" }
	]);
	assert.equal(createStructuredWorkflowCompletionContract("write", { artifacts: ["index.html rewritten"] }), undefined);
});

test("workflow tool stats track writes and keep retry tools narrow", (): void => {
	const phase: WorkflowPhase = {
		id: "write", title: "Write", instruction: "Write", status: "pending", toolGroup: "write", toolBudget: "project_edit",
		allowedTools: ["mcp_godot_read_text_file", "mcp_godot_propose_attach_script_to_node", "mcp_godot_attach_script_to_node"]
	} as WorkflowPhase;
	const stats = createEmptyWorkflowPhaseToolStats();
	updateWorkflowPhaseToolStats(stats, { type: "tool.call", toolCallId: "write-1", toolName: "mcp_godot_attach_script_to_node" } as ToolEvent);
	updateWorkflowPhaseToolStats(stats, { type: "tool.result", toolCallId: "write-1", toolName: "mcp_godot_attach_script_to_node", ok: true, validationStatus: "passed" } as ToolEvent);
	assert.equal(didWorkflowWritePhaseExecute(phase, stats), true);
	assert.deepEqual(getWorkflowWriteGuardRetryAllowedTools(phase), ["mcp_godot_propose_attach_script_to_node", "mcp_godot_attach_script_to_node"]);
});

test("workflow events map to the agent compatibility surface", (): void => {
	assert.equal(mapWorkflowEventToAgentEvent("workflow.phase.done", { workflowId: "workflow-1" }), null);
});
