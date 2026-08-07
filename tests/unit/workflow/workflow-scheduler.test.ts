import assert from "node:assert/strict";
import test from "node:test";
import { scheduleWorkflowApproval, scheduleWorkflowPhaseOutcome, scheduleWorkflowPhaseStart } from "../../../src/workflow/scheduler.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowRunState } from "../../../src/workflow/types.js";

function createPhase(id: string, toolGroup: WorkflowPhase["toolGroup"] = "read"): WorkflowPhase {
	return {
		id,
		title: id,
		toolGroup,
		toolBudget: "normal",
		allowedTools: [],
		instruction: id
	};
}

function createState(phases: WorkflowPhase[], outputs: WorkflowPhaseOutput[] = []): WorkflowRunState {
	return {
		plan: {
			id: "workflow-test",
			title: "Workflow test",
			phases,
			todos: phases.map((phase: WorkflowPhase) => ({ id: phase.id, phaseId: phase.id, text: phase.title, status: "pending" }))
		},
		phaseIndex: 0,
		phaseOutputs: outputs,
		originalParams: { message: "test" },
		history: [],
		historyBudgetTokens: 100
	};
}

function createOutcome(phase: WorkflowPhase, status: WorkflowPhaseOutput["status"]): WorkflowPhaseOutput {
	return {
		phaseId: phase.id,
		phaseRunId: `run-${phase.id}`,
		title: phase.title,
		status,
		summary: status,
		evidence: [],
		failedChecks: status === "needs_fix" ? [{ code: "check", message: "needs repair" }] : [],
		requiredFixes: status === "needs_fix" ? ["修复：needs repair"] : [],
		modifiedArtifacts: [],
		verifiedArtifacts: [],
		toolObservations: []
	};
}

test("scheduler always permits the summary phase after an unresolved outcome", (): void => {
	const failedPhase = createPhase("verify", "verify");
	const summarizePhase = createPhase("summarize", "summarize");
	const state = createState([failedPhase, summarizePhase], [createOutcome(failedPhase, "needs_fix")]);
	state.phaseIndex = 1;

	const command = scheduleWorkflowPhaseStart(state, "run-summarize");
	assert.equal(command.type, "run_phase");
	if (command.type === "run_phase") {
		assert.equal(command.state.plan.todos[1]?.status, "running");
	}
});

test("scheduler inserts repair phases for a repairable verification outcome", (): void => {
	const write: WorkflowPhase = {
		...createPhase("write", "write"),
		toolGroup: "write",
		allowedTools: ["mcp_workspace_replace_text_in_file"],
		completionContract: {
			targets: [{ kind: "artifact", path: "src/app.ts", targetKind: "workspace_file" }],
			requireAll: true
		}
	};
	const phase = createPhase("verify", "verify");
	const state = createState([write, phase]);
	state.phaseIndex = 1;
	const outcome: WorkflowPhaseOutput = {
		...createOutcome(phase, "needs_fix"),
		failedChecks: [{ code: "artifact_invalid", failureCode: "artifact_invalid", targetKind: "workspace_file", message: "needs repair", artifact: "src/app.ts" }]
	};
	const command = scheduleWorkflowPhaseOutcome(state, phase, outcome, 2);

	assert.equal(command.type, "repair");
	if (command.type === "repair") {
		assert.equal(command.state.phaseIndex, 2);
		assert.ok(command.state.plan.phases.length > 1);
	}
});

test("scheduler inserts workspace write retry phases for write guard failures", (): void => {
	const phase: WorkflowPhase = {
		...createPhase("implement", "write"),
		title: "实现修改",
		allowedTools: [
			"mcp_workspace_read_text_file",
			"mcp_workspace_propose_replace_text_in_file",
			"mcp_workspace_replace_text_in_file"
		],
		instruction: "修改 src/main/services/system-info.ts"
	};
	const outcome: WorkflowPhaseOutput = {
		...createOutcome(phase, "needs_fix"),
		summary: "写入阶段「实现修改」没有实际调用写入工具或触发审批，已阻止将该 Todo 标记为完成。",
		failedChecks: [
			{
				code: "tool_failed_check",
				failureCode: "replace_target_not_found",
				targetKind: "workspace_file",
				message: "oldText not found in file",
				toolName: "mcp_workspace_propose_replace_text_in_file",
				artifact: "src/main/services/system-info.ts"
			},
			{
				code: "write_tool_missing",
				failureCode: "write_tool_missing",
				targetKind: "workspace_file",
				message: "写入阶段「实现修改」没有实际调用写入工具或触发审批，已阻止将该 Todo 标记为完成。"
			}
		],
		requiredFixes: [
			"修复：oldText not found in file",
			"修复：写入阶段「实现修改」没有实际调用写入工具或触发审批，已阻止将该 Todo 标记为完成。"
		]
	};

	const command = scheduleWorkflowPhaseOutcome(createState([phase]), phase, outcome, 2);

	assert.equal(command.type, "repair");
	if (command.type === "repair") {
		const repairPhase: WorkflowPhase | undefined = command.state.plan.phases[1];
		assert.equal(repairPhase?.title, "重试实际修改");
		assert.ok(repairPhase?.allowedTools.includes("mcp_workspace_read_text_file"));
		assert.ok(repairPhase?.allowedTools.includes("mcp_workspace_replace_text_in_file"));
		assert.equal(repairPhase?.allowedTools.includes("mcp_workspace_propose_replace_text_in_file"), false);
		assert.match(repairPhase?.instruction ?? "", /上一写入阶段/);
		assert.match(repairPhase?.instruction ?? "", /oldText not found/);
	}
});

test("scheduler completes verification with warnings after the repair budget is exhausted", (): void => {
	const phase = createPhase("verify", "verify");
	const state = createState([phase]);
	state.plan.phases = [
		{ ...phase, id: "auto-repair-1", repairRound: 1 },
		{ ...phase, id: "auto-verify-1", repairRound: 1 },
		{ ...phase, id: "auto-repair-2", repairRound: 2 },
		{ ...phase, id: "auto-verify-2", repairRound: 2 }
	];
	state.plan.todos = state.plan.phases.map((item: WorkflowPhase) => ({ id: item.id, phaseId: item.id, text: item.title, status: "pending" }));

	const command = scheduleWorkflowPhaseOutcome(state, phase, createOutcome(phase, "needs_fix"), 2);
	assert.equal(command.type, "complete_phase");
	if (command.type === "complete_phase") {
		assert.equal(command.outcome.verificationStatus, "unverified");
		assert.ok((command.outcome.warnings?.length ?? 0) > 0);
	}
});

test("scheduler never repairs guessed verification paths outside the registered target", (): void => {
	const write: WorkflowPhase = {
		...createPhase("write", "write"),
		allowedTools: ["mcp_godot_overwrite_text_file"],
		completionContract: {
			targets: [{ kind: "artifact", path: "scripts/player.gd", targetKind: "godot_script" }],
			requireAll: true
		}
	};
	const verify = createPhase("verify", "verify");
	const state = createState([write, verify]);
	state.phaseIndex = 1;
	const outcome: WorkflowPhaseOutput = {
		...createOutcome(verify, "needs_fix"),
		failedChecks: [
			{ code: "godot_check", failureCode: "godot_check_failed", artifact: "scripts/player.gd", message: "PlayerStats is unresolved" },
			{ code: "godot_check", failureCode: "godot_check_failed", artifact: "scripts/player_stats.gd", message: "Guessed path does not exist" }
		]
	};

	const command = scheduleWorkflowPhaseOutcome(state, verify, outcome, 2);
	assert.equal(command.type, "repair");
	if (command.type === "repair") {
		assert.deepEqual(command.outcome.failedChecks.map((check): string | undefined => check.artifact), ["scripts/player.gd"]);
		assert.match(command.outcome.warnings?.[0] ?? "", /Guessed path does not exist/);
		assert.equal(command.state.plan.phases[2]?.allowedTools.includes("mcp_godot_overwrite_text_file"), true);
	}
});

test("targetless verification failure completes with a warning instead of a backend failure", (): void => {
	const write: WorkflowPhase = {
		...createPhase("write", "write"),
		allowedTools: ["mcp_godot_overwrite_text_file"]
	};
	const verify = createPhase("verify", "verify");
	const state = createState([write, verify]);
	state.phaseIndex = 1;
	const outcome: WorkflowPhaseOutput = {
		...createOutcome(verify, "needs_fix"),
		failedChecks: [{ code: "tool_failed", failureCode: "godot_check_failed", message: "No structured artifact was returned" }]
	};

	const command = scheduleWorkflowPhaseOutcome(state, verify, outcome, 2);
	assert.equal(command.type, "complete_phase");
	if (command.type === "complete_phase") {
		assert.equal(command.outcome.verificationStatus, "unverified");
		assert.equal(command.outcome.failedChecks.length, 0);
		assert.match(command.outcome.warnings?.[0] ?? "", /No structured artifact/);
	}
});

test("scheduler reports repeated verification failure as a normal warning", (): void => {
	const writePhase: WorkflowPhase = {
		...createPhase("write", "write"),
		allowedTools: ["mcp_workspace_overwrite_text_file"],
		completionContract: {
			targets: [{ kind: "artifact", path: "index.html", targetKind: "workspace_file" }],
			requireAll: true
		}
	};
	const phase = createPhase("auto-verify-1", "verify");
	phase.repairRound = 1;
	const previousPhase = createPhase("verify", "verify");
	const previousOutcome: WorkflowPhaseOutput = {
		...createOutcome(previousPhase, "needs_fix"),
		failedChecks: [{ code: "check", failureCode: "check", targetKind: "workspace_file", artifact: "index.html", message: "needs repair" }]
	};
	const state = createState([writePhase, phase], [previousOutcome]);
	state.phaseIndex = 1;

	const command = scheduleWorkflowPhaseOutcome(
		state,
		phase,
		{
			...createOutcome(phase, "needs_fix"),
			failedChecks: [{ code: "check", failureCode: "check", targetKind: "workspace_file", artifact: "index.html", message: "needs repair" }]
		},
		2
	);

	assert.equal(command.type, "complete_phase");
	if (command.type === "complete_phase") {
		assert.match(command.outcome.summary, /重复出现相同失败/);
		assert.equal(command.outcome.verificationStatus, "unverified");
	}
});

test("scheduler never creates a write repair for a read-stage failure", (): void => {
	const phase = createPhase("inspect", "read");
	const write = createPhase("implement", "write");
	const verify = createPhase("verify", "verify");
	const summarize = createPhase("summarize", "summarize");
	const command = scheduleWorkflowPhaseOutcome(
		createState([phase, write, verify, summarize]),
		phase,
		createOutcome(phase, "needs_fix"),
		2
	);

	assert.equal(command.type, "graceful_blocked");
	if (command.type === "graceful_blocked") {
		assert.equal(command.outcome.status, "blocked");
		assert.match(command.outcome.summary, /不能通过自动写入修复/);
		assert.equal(command.state.plan.phases.some((item: WorkflowPhase): boolean => item.repairOf === phase.id), false);
		assert.equal(command.state.phaseIndex, 3);
		assert.deepEqual(command.state.plan.todos.map((todo) => todo.status), ["failed", "skipped", "skipped", "pending"]);
		assert.deepEqual(command.state.phaseOutputs.map((output) => output.status), ["blocked", "skipped", "skipped"]);
	}
});

test("scheduler permits a repeated verification failure after a real file mutation", (): void => {
	const writePhase: WorkflowPhase = {
		...createPhase("implement", "write"),
		allowedTools: ["mcp_workspace_overwrite_text_file"],
		completionContract: {
			targets: [{ kind: "artifact", path: "index.html", targetKind: "workspace_file" }],
			requireAll: true
		}
	};
	const phase = createPhase("auto-verify-1", "verify");
	phase.repairRound = 1;
	const previousPhase = createPhase("verify", "verify");
	const repairPhase = createPhase("auto-repair-1", "write");
	const repairOutcome: WorkflowPhaseOutput = {
		...createOutcome(repairPhase, "completed"),
		toolObservations: [{
			toolCallId: "rewrite-index",
			toolName: "mcp_workspace_overwrite_text_file",
			risk: "write",
			status: "succeeded",
			artifactRefs: ["index.html"],
			repairFamilies: ["workspace_file"],
			fileEditFingerprints: ["index.html:before:after"]
		}]
	};
	const previousOutcome: WorkflowPhaseOutput = {
		...createOutcome(previousPhase, "needs_fix"),
		failedChecks: [{ code: "check", failureCode: "check", targetKind: "workspace_file", message: "needs repair", artifact: "index.html" }]
	};
	const state = createState([writePhase, phase], [previousOutcome, repairOutcome]);
	state.phaseIndex = 1;

	const repeatedOutcome: WorkflowPhaseOutput = {
		...createOutcome(phase, "needs_fix"),
		failedChecks: [{ code: "check", failureCode: "check", targetKind: "workspace_file", message: "needs repair", artifact: "index.html" }]
	};
	const command = scheduleWorkflowPhaseOutcome(state, phase, repeatedOutcome, 2);
	assert.equal(command.type, "repair");
});

test("scheduler completes a successful phase without executing effects", (): void => {
	const phase = createPhase("inspect");
	const command = scheduleWorkflowPhaseOutcome(createState([phase]), phase, createOutcome(phase, "completed"), 2);

	assert.equal(command.type, "complete_phase");
	if (command.type === "complete_phase") {
		assert.equal(command.state.plan.todos[0]?.status, "done");
		assert.equal(command.state.phaseIndex, 1);
	}
});

test("scheduler pauses an approval-required phase without invoking approval effects", (): void => {
	const phase = createPhase("write", "write");
	const outcome = createOutcome(phase, "approval_required");
	const command = scheduleWorkflowApproval(createState([phase]), phase, outcome, "run-write");

	assert.equal(command.type, "pause_for_approval");
	if (command.type === "pause_for_approval") {
		assert.equal(command.state.plan.todos[0]?.status, "paused");
		assert.equal(command.state.activePhaseRunId, "run-write");
	}
});
