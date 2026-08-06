import assert from "node:assert/strict";
import test from "node:test";
import { getWorkflowToolSemantics } from "../../../src/workflow/tool-semantics.js";
import { didWorkflowWritePhaseExecute } from "../../../src/server/workflow/tool-events.js";
import { createEmptyWorkflowPhaseToolStats } from "../../../src/server/workflow/tool-events.js";
import type { WorkflowPhase } from "../../../src/workflow/types.js";

test("workflow tool semantics use exact terminal preset keys", (): void => {
	assert.deepEqual(getWorkflowToolSemantics("mcp_terminal_run_safe_preset", { presetName: "godot.check_only" }).validationCapabilities, ["godot_script_check"]);
	assert.deepEqual(getWorkflowToolSemantics("mcp_terminal_run_safe_preset", { presetName: "godot.check_only_extra" }).validationCapabilities, undefined);
	assert.deepEqual(getWorkflowToolSemantics("mcp_workspace_replace_text_in_file").repairFamilies, ["workspace_file"]);
	assert.deepEqual(getWorkflowToolSemantics("custom_unknown_tool").repairFamilies, undefined);
});

test("proposal completion is declared by phase structure, never phase prose", (): void => {
	const stats = createEmptyWorkflowPhaseToolStats();
	stats.successfulProposeToolEvents = 1;
	const writePhase: WorkflowPhase = {
		id: "write", title: "preview", instruction: "propose a diff", toolGroup: "write", toolBudget: "normal", allowedTools: [], writeRequirement: "write"
	};
	const proposalPhase: WorkflowPhase = { ...writePhase, writeRequirement: "propose" };
	assert.equal(didWorkflowWritePhaseExecute(writePhase, stats), false);
	assert.equal(didWorkflowWritePhaseExecute(proposalPhase, stats), true);
});
