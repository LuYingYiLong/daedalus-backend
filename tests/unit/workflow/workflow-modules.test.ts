import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
import type { WorkflowPhase } from "../../../src/workflow/types.js";
import { planWorkflow, planWorkflowAfterLlmPlannerFailure } from "../../../src/workflow/planner.js";
import {
	classifyGodotTask,
	createGodotTemplateWorkflowPlan,
	getAllowedToolsForLlmPlannedStep,
	narrowLlmPlannedWriteTools
} from "../../../src/workflow/godot-template-planner.js";
import { createStructuredWorkflowCompletionContract } from "../../../src/workflow/completion-contract.js";
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

test("fixed fallback is a safe workflow and respects read-only policy", (): void => {
	const fallback = planWorkflowAfterLlmPlannerFailure({ message: "Anything", mode: "agent", options: { workflow: "llm_planned" } });
	assert.deepEqual(fallback?.phases.map((phase: WorkflowPhase): WorkflowPhase["toolGroup"] => phase.toolGroup), ["read", "write", "verify", "summarize"]);
	assert.equal(planWorkflow({ message: "Anything", mode: "agent", options: { executionPolicy: "read_only" } }), null);
});

test("workspace workflow profile overrides Godot prompt and skill defaults", (): void => {
	const fallback = planWorkflowAfterLlmPlannerFailure({
		message: "Update a TypeScript service",
		mode: "agent",
		promptId: "godot.assistant",
		options: { workflow: "llm_planned" }
	}, "workspace");
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

test("Godot templates only use evidence-driven targets", (): void => {
	const target = {
		kind: "godot_script_scene" as const,
		artifacts: ["scripts/smoke.gd", "scenes/smoke.tscn"]
	};
	const classification = classifyGodotTask(target, { isGodotProject: true });
	assert.equal(classification.type, "scene_attach_script");
	assert.equal(classification.scriptPath, "scripts/smoke.gd");
	assert.equal(classification.scenePath, "scenes/smoke.tscn");
	assert.equal(classifyGodotTask(undefined, { isGodotProject: true }).type, "general_edit");
	const plan = createGodotTemplateWorkflowPlan({ message: "Any prose", mode: "agent" }, target, { isGodotProject: true });
	assert.equal(plan?.source, "godot_template");
	assert.equal(plan?.executionProfile, "godot");
	assert.ok(plan?.phases.some((phase: WorkflowPhase): boolean => phase.id === "attach-script"));
});

test("unknown targets never choose a Godot template", (): void => {
	assert.equal(createGodotTemplateWorkflowPlan({ message: "Create a scene", mode: "agent" }, undefined, { isGodotProject: true }), null);
	assert.equal(createGodotTemplateWorkflowPlan({ message: "Any prose", mode: "ask" }, { kind: "godot_script", artifacts: ["scripts/a.gd"] }, { isGodotProject: true }), null);
	assert.equal(createGodotTemplateWorkflowPlan({ message: "Any prose", mode: "agent", options: { executionPolicy: "read_only" } }, { kind: "godot_script", artifacts: ["scripts/a.gd"] }, { isGodotProject: true }), null);
});

test("LLM planned write tools are generic and do not depend on phase prose", (): void => {
	const one = getAllowedToolsForLlmPlannedStep("write", "Attach script", "Attach a script.");
	const two = getAllowedToolsForLlmPlannedStep("write", "Set a project setting", "Set it.");
	assert.deepEqual(one, two);
	assert.deepEqual(narrowLlmPlannedWriteTools({ title: "Any", instruction: "Any", toolGroup: "write" }), one);
	assert.equal(one.includes("mcp_godot_create_text_file"), true);
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
