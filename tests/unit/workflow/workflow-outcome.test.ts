import assert from "node:assert/strict";
import test from "node:test";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
import {
	applyDeterministicVerificationGate,
	applyToolEventToWorkflowObservations,
	createWorkflowPhaseOutcome,
	findBlockingOutcomeBeforeSummarize
} from "../../../src/workflow/outcome.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowToolObservation } from "../../../src/workflow/types.js";

function createPhase(id: string, toolGroup: WorkflowPhase["toolGroup"]): WorkflowPhase {
	return {
		id,
		title: id,
		toolGroup,
		toolBudget: toolGroup === "write" ? "project_edit" : "normal",
		allowedTools: [],
		instruction: id
	};
}

function applyEvents(events: ToolEvent[]): WorkflowToolObservation[] {
	let observations: WorkflowToolObservation[] = [];
	for (const event of events) {
		observations = applyToolEventToWorkflowObservations(observations, event);
	}
	return observations;
}

test("verify phase with failed terminal validation becomes needs_fix", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_terminal_run_safe_preset",
			args: { presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
			serverId: "terminal",
			serverName: "Terminal",
			category: "terminal",
			title: "运行验证",
			summary: "godot.check_only",
			target: {
				kind: "command",
				path: "res://scripts/game.gd",
				label: "godot.check_only"
			}
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_terminal_run_safe_preset",
			resultChars: 120,
			truncated: false,
			ok: false,
			exitCode: 1,
			validationStatus: "failed",
			summary: "godot.check_only failed",
			failedChecks: ["Parser Error"],
			artifactRefs: ["res://scripts/game.gd"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "", observations);

	assert.equal(outcome.status, "needs_fix");
	assert.equal(outcome.failedChecks.length, 1);
	assert.match(outcome.failedChecks[0]?.message ?? "", /Parser Error/);
	assert.deepEqual(outcome.requiredFixes, ["修复：Parser Error"]);
});

test("read phase failure blocks without requesting a workspace repair", (): void => {
	const observations: WorkflowToolObservation[] = [{
		toolCallId: "read-failed",
		toolName: "mcp_workspace_read_text_file",
		risk: "read",
		status: "failed",
		error: "The requested file is unavailable.",
		artifactRefs: []
	}];

	const outcome = createWorkflowPhaseOutcome(createPhase("inspect", "read"), "phase-run-read", "", observations);

	assert.equal(outcome.status, "blocked");
	assert.equal(outcome.failedChecks[0]?.code, "tool_error");
});

test("not-applicable workspace checks complete verification with an explicit warning", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.result",
			step: 0,
			toolCallId: "git-status",
			toolName: "mcp_terminal_run_safe_preset",
			resultChars: 120,
			truncated: false,
			validationStatus: "not_applicable",
			environmentIssue: true,
			applicabilityCode: "git_repository_missing",
			summary: "git.status is not applicable because the workspace is not a Git repository",
			failedChecks: ["fatal: not a git repository"]
		}
	]);

	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-not-applicable", "", observations);

	assert.equal(outcome.status, "completed");
	assert.equal(outcome.verificationStatus, "unverified");
	assert.deepEqual(outcome.failedChecks, []);
	assert.match(outcome.warnings?.[0] ?? "", /\[git_repository_missing\].*not applicable/);
});

test("environment gaps do not hide a real verification failure", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.result",
			step: 0,
			toolCallId: "runtime-gap",
			toolName: "mcp_terminal_run_safe_preset",
			resultChars: 80,
			truncated: false,
			ok: false,
			validationStatus: "failed",
			environmentIssue: true,
			applicabilityCode: "godot_runtime_unavailable",
			summary: "Godot runtime unavailable",
			failedChecks: ["spawn godot ENOENT"]
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "real-failure",
			toolName: "mcp_terminal_run_safe_preset",
			resultChars: 100,
			truncated: false,
			ok: false,
			validationStatus: "failed",
			summary: "Parser Error",
			failedChecks: ["Parser Error at scripts/game.gd:4"]
		}
	]);

	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-mixed-failure", "", observations);
	assert.equal(outcome.status, "needs_fix");
	assert.equal(outcome.failedChecks.length, 1);
	assert.match(outcome.failedChecks[0]?.message ?? "", /Parser Error/);
	assert.match(outcome.warnings?.[0] ?? "", /godot_runtime_unavailable/);
});

test("failed write phase summary prefers failed checks over prior read summaries", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.result",
			step: 0,
			toolCallId: "read-scene",
			toolName: "mcp_godot_read_text_file",
			resultChars: 120,
			truncated: false,
			ok: true,
			validationStatus: "unknown",
			summary: "[gd_scene format=3 uid=\"uid://lfje63a3doaj\"]",
			artifactRefs: ["scenes/guess_number.tscn"]
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "replace-scene",
			toolName: "mcp_godot_propose_replace_text_in_file",
			resultChars: 120,
			truncated: false,
			ok: false,
			validationStatus: "failed",
			summary: "mcp_godot_propose_replace_text_in_file failed",
			failedChecks: ["oldText not found in file. Ensure exact match including whitespace and indentation."],
			artifactRefs: ["scenes/guess_number.tscn"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("write", "write"), "phase-run-1", "", observations);

	assert.equal(outcome.status, "failed");
	assert.match(outcome.summary, /oldText not found/);
	assert.doesNotMatch(outcome.summary, /^\[gd_scene/);
});

test("write phase treats transient tool failure as resolved when same tool succeeds later", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "image-1",
			toolName: "mcp_image_generate",
			args: {},
			serverId: "image",
			serverName: "Image Generation",
			category: "image",
			title: "生成图片",
			summary: "生成 1 张图片",
			target: {
				kind: "unknown",
				label: "generated image"
			}
		},
		{
			type: "tool.error",
			step: 0,
			toolCallId: "image-1",
			toolName: "mcp_image_generate",
			message: "fetch failed"
		},
		{
			type: "tool.call",
			step: 1,
			toolCallId: "image-2",
			toolName: "mcp_image_generate",
			args: {},
			serverId: "image",
			serverName: "Image Generation",
			category: "image",
			title: "生成图片",
			summary: "生成 1 张图片",
			target: {
				kind: "unknown",
				label: "generated image"
			}
		},
		{
			type: "tool.result",
			step: 1,
			toolCallId: "image-2",
			toolName: "mcp_image_generate",
			resultChars: 120,
			truncated: false,
			ok: true,
			validationStatus: "passed",
			summary: "mcp_image_generate passed",
			artifactRefs: ["attachments/images/generated-image.png"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("write", "write"), "phase-run-1", "图片已生成。", observations);

	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.failedChecks, []);
	assert.deepEqual(outcome.requiredFixes, []);
	assert.equal(outcome.summary, "mcp_image_generate passed");
	assert.equal(outcome.toolObservations.length, 2);
});

test("write phase ignores failed non-mutation verification after a successful write", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "write-ts",
			toolName: "mcp_workspace_replace_text_in_file",
			args: { relativePath: "src/renderer/src/hooks/useDiskSpaceCheck.ts", oldText: "checkDiskSpace(driveLetter)", newText: "checkDiskSpace()" },
			serverId: "workspace",
			serverName: "Workspace",
			category: "write",
			title: "写入文件",
			summary: "src/renderer/src/hooks/useDiskSpaceCheck.ts",
			target: { kind: "file", path: "src/renderer/src/hooks/useDiskSpaceCheck.ts", label: "src/renderer/src/hooks/useDiskSpaceCheck.ts" }
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "write-ts",
			toolName: "mcp_workspace_replace_text_in_file",
			resultChars: 20,
			truncated: false,
			ok: true,
			validationStatus: "passed",
			summary: "mcp_workspace_replace_text_in_file",
			artifactRefs: ["src/renderer/src/hooks/useDiskSpaceCheck.ts"]
		},
		{
			type: "tool.call",
			step: 0,
			toolCallId: "bad-verify",
			toolName: "mcp_terminal_run_write_preset",
			args: { presetName: "godot.check_only", resourcePath: "src/renderer/src/hooks/useDiskSpaceCheck.ts" },
			serverId: "terminal",
			serverName: "Terminal",
			category: "terminal",
			title: "运行终端命令",
			summary: "godot.check_only src/renderer/src/hooks/useDiskSpaceCheck.ts",
			target: { kind: "command", label: "godot.check_only src/renderer/src/hooks/useDiskSpaceCheck.ts" }
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "bad-verify",
			toolName: "mcp_terminal_run_write_preset",
			resultChars: 120,
			truncated: false,
			ok: false,
			validationStatus: "failed",
			summary: "godot.check_only src/renderer/src/hooks/useDiskSpaceCheck.ts failed",
			failedChecks: ["Unsupported Godot resourcePath extension for 'godot.check_only': .ts. Use a .gd or .tscn file."],
			artifactRefs: ["src/renderer/src/hooks/useDiskSpaceCheck.ts"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("write", "write"), "phase-run-1", "修改完成。", observations);

	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.failedChecks, []);
	assert.deepEqual(outcome.modifiedArtifacts, ["src/renderer/src/hooks/useDiskSpaceCheck.ts"]);
});

test("verify phase without deterministic validation tool becomes blocked", (): void => {
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "我检查过了，应该没问题。", []);

	assert.equal(outcome.status, "blocked");
	assert.match(outcome.blockedReason ?? "", /验证工具/);
	assert.equal(outcome.failedChecks[0]?.code, "verify_tool_missing");
});

test("verify phase accepts an explicitly required artifact readback", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([{
		type: "tool.result",
		step: 0,
		toolCallId: "read-readme",
		toolName: "mcp_workspace_read_text_file",
		resultChars: 320,
		truncated: false,
		ok: true,
		validationStatus: "unknown",
		summary: "# Daedalus Backend",
		artifactRefs: ["README-CN.md"]
	}]);
	const phase: WorkflowPhase = { ...createPhase("verify", "verify"), verificationRequirements: ["artifact_readback"] };
	const outcome = createWorkflowPhaseOutcome(phase, "phase-run-1", "Document readback confirmed.", observations);

	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.verifiedArtifacts, ["README-CN.md"]);
	assert.equal(outcome.verificationStatus, "verified");
});

test("verify phase does not treat a source-code readback as executable validation", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([{
		type: "tool.result",
		step: 0,
		toolCallId: "read-source",
		toolName: "mcp_workspace_read_text_file",
		resultChars: 320,
		truncated: false,
		ok: true,
		validationStatus: "unknown",
		summary: "export const value = 1;",
		artifactRefs: ["src/index.ts"]
	}]);
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "Source readback confirmed.", observations);

	assert.equal(outcome.status, "blocked");
	assert.equal(outcome.failedChecks[0]?.code, "verify_tool_missing");
});

test("summarize phase does not infer tool calls from prose", (): void => {
	const outcome = createWorkflowPhaseOutcome(
		createPhase("summarize", "summarize"),
		"phase-run-1",
		"已经拿到了上下文。现在读取 `AGENTS.md` 内容，准备用 `read_text_file` 读取 `res://addons/godot_daedalus/AGENTS.md`，大概几秒。",
		[]
	);

	assert.equal(outcome.status, "completed");
});

test("LSP diagnostics alone do not satisfy a structured verify phase", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			resultChars: 80,
			truncated: false,
			ok: true,
			diagnosticsCount: 0,
			diagnosticsErrorCount: 0,
			validationStatus: "passed",
			summary: "res://scripts/game.gd LSP diagnostics: 0 issue(s), 0 error(s).",
			artifactRefs: ["res://scripts/game.gd"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "验证完成。", observations);

	assert.equal(outcome.status, "blocked");
	assert.equal(outcome.failedChecks[0]?.code, "verify_tool_missing");
});

test("verify phase treats LSP unavailable plus check-only pass as completed", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-lsp-status",
			toolName: "mcp_godot_lsp_get_status",
			resultChars: 120,
			truncated: false,
			ok: false,
			validationStatus: "failed",
			environmentIssue: true,
			summary: "mcp_godot_lsp_get_status failed: godot_diagnostics_unavailable: no active workspace",
			failedChecks: ["godot_diagnostics_unavailable: no active workspace"],
			artifactRefs: []
		},
		{
			type: "tool.call",
			step: 0,
			toolCallId: "call-check",
			toolName: "mcp_terminal_run_safe_preset",
			args: { presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
			serverId: "terminal",
			serverName: "Terminal",
			category: "terminal",
			title: "运行验证",
			summary: "godot.check_only",
			target: {
				kind: "command",
				path: "res://scripts/game.gd",
				label: "godot.check_only"
			}
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-check",
			toolName: "mcp_terminal_run_safe_preset",
			resultChars: 120,
			truncated: false,
			ok: true,
			exitCode: 0,
			validationStatus: "passed",
			summary: "godot.check_only res://scripts/game.gd passed",
			artifactRefs: ["res://scripts/game.gd"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "LSP 是环境问题，check-only 已通过。", observations);

	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.failedChecks, []);
	assert.deepEqual(outcome.requiredFixes, []);
	assert.match(outcome.evidence.join("\n"), /no active workspace/);
	assert.deepEqual(outcome.verifiedArtifacts, ["res://scripts/game.gd"]);
});

test("verify phase with only LSP unavailable completes as non-blocking environment gap", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([{
		type: "tool.result",
		step: 0,
		toolCallId: "call-lsp-status",
		toolName: "mcp_godot_lsp_get_status",
		resultChars: 120,
		truncated: false,
		ok: false,
		validationStatus: "failed",
		environmentIssue: true,
		summary: "mcp_godot_lsp_get_status failed: godot_diagnostics_unavailable: no active workspace",
		failedChecks: ["godot_diagnostics_unavailable: no active workspace"],
		artifactRefs: []
	}]);
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "LSP 不可用。", observations);

	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.failedChecks, []);
	assert.deepEqual(outcome.requiredFixes, []);
	assert.equal(outcome.blockedReason, undefined);
	assert.match(outcome.evidence.join("\n"), /godot_diagnostics_unavailable/);
});

test("summarize gate blocks unresolved failed outcome until a later completed outcome", (): void => {
	const verifyPhase: WorkflowPhase = createPhase("verify", "verify");
	const failedOutcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-1",
		"",
		applyEvents([{
			type: "tool.result",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_godot_validate_scene_script_references",
			resultChars: 120,
			truncated: false,
			ok: false,
			validationStatus: "failed",
			summary: "场景引用缺失。",
			failedChecks: ["`%TitleLabel` 未设置 unique name。"],
			artifactRefs: ["res://scenes/main.tscn"]
		}])
	);
	const repairedOutcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-2",
		"",
		applyEvents([{
			type: "tool.result",
			step: 0,
			toolCallId: "call-2",
			toolName: "mcp_godot_validate_scene_script_references",
			resultChars: 80,
			truncated: false,
			ok: true,
			diagnosticsCount: 0,
			diagnosticsErrorCount: 0,
			validationStatus: "passed",
			summary: "Scene references passed.",
			artifactRefs: ["res://scenes/main.tscn"]
		}])
	);

	assert.equal(findBlockingOutcomeBeforeSummarize([failedOutcome])?.status, "needs_fix");
	assert.equal(findBlockingOutcomeBeforeSummarize([failedOutcome, repairedOutcome]), null);
});

test("summarize gate ignores prior approval placeholder from the same phase", (): void => {
	const summarizePhase: WorkflowPhase = createPhase("answer", "summarize");
	const approvalOutcome: WorkflowPhaseOutput = {
		phaseId: "answer",
		phaseRunId: "phase-run-answer",
		title: "回答用户",
		status: "approval_required",
		summary: "等待审批",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: [],
		verifiedArtifacts: [],
		toolObservations: [],
		text: ""
	};
	const failedVerifyOutcome: WorkflowPhaseOutput = {
		phaseId: "verify",
		phaseRunId: "phase-run-verify",
		title: "运行验证",
		status: "needs_fix",
		summary: "验证失败",
		evidence: [],
		failedChecks: [{ code: "failed", message: "验证失败" }],
		requiredFixes: ["修复：验证失败"],
		modifiedArtifacts: [],
		verifiedArtifacts: [],
		toolObservations: []
	};

	assert.equal(findBlockingOutcomeBeforeSummarize([approvalOutcome], summarizePhase.id), null);
	assert.equal(findBlockingOutcomeBeforeSummarize([failedVerifyOutcome, approvalOutcome], summarizePhase.id), failedVerifyOutcome);
});

test("unregistered diagnostics do not satisfy a structured verification gate", (): void => {
	const writeOutcome: WorkflowPhaseOutput = {
		phaseId: "implement",
		phaseRunId: "phase-run-write",
		title: "实现修改",
		status: "completed",
		summary: "updated script",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: ["res://scripts/game.gd"],
		verifiedArtifacts: [],
		toolObservations: []
	};
	const verifyPhase: WorkflowPhase = createPhase("verify", "verify");
	const lspOnlyOutcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-verify",
		"",
		applyEvents([{
			type: "tool.result",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			resultChars: 80,
			truncated: false,
			ok: true,
			diagnosticsCount: 0,
			diagnosticsErrorCount: 0,
			validationStatus: "passed",
			summary: "LSP diagnostics passed.",
			artifactRefs: ["res://scripts/game.gd"]
		}])
	);
	const gatedOutcome = applyDeterministicVerificationGate(verifyPhase, lspOnlyOutcome, [writeOutcome]);

	assert.equal(gatedOutcome.status, "blocked");
	assert.equal(gatedOutcome.failedChecks[0]?.code, "verify_tool_missing");
});

test("structured diagnostics-unavailable results become an unverified warning", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "lsp-transport",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			args: { resourcePath: "res://scripts/game.gd" },
			serverId: "godot_diagnostics",
			serverName: "Godot Diagnostics",
			category: "read",
			title: "LSP diagnostics",
			summary: "LSP diagnostics",
			target: { kind: "file", path: "res://scripts/game.gd", label: "LSP" }
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "lsp-transport",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			resultChars: 0,
			truncated: false,
			ok: false,
			validationStatus: "not_applicable",
			applicabilityCode: "diagnostics_unavailable",
			notApplicableReason: "diagnostics connection unavailable"
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-lsp-transport", "", observations);

	assert.equal(outcome.status, "completed");
	assert.equal(outcome.verificationStatus, "unverified");
	assert.deepEqual(outcome.failedChecks, []);
	assert.equal(outcome.warnings?.some((warning: string): boolean => /diagnostics connection unavailable/iu.test(warning)), true);
});

test("deterministic verification gate accepts check-only when LSP is unavailable", (): void => {
	const writeOutcome: WorkflowPhaseOutput = {
		phaseId: "implement",
		phaseRunId: "phase-run-write",
		title: "实现修改",
		status: "completed",
		summary: "updated script",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: ["res://scripts/game.gd"],
		verifiedArtifacts: [],
		toolObservations: []
	};
	const verifyPhase: WorkflowPhase = createPhase("verify", "verify");
	const outcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-verify",
		"LSP 不可用，已用 check-only 验证。",
		applyEvents([
			{
				type: "tool.result",
				step: 0,
				toolCallId: "call-lsp-status",
				toolName: "mcp_godot_lsp_get_status",
				resultChars: 120,
				truncated: false,
				ok: false,
				validationStatus: "failed",
				environmentIssue: true,
				summary: "mcp_godot_lsp_get_status failed: godot_diagnostics_unavailable: no active workspace",
				failedChecks: ["godot_diagnostics_unavailable: no active workspace"],
				artifactRefs: []
			},
			{
				type: "tool.call",
				step: 0,
				toolCallId: "call-check",
				toolName: "mcp_terminal_run_safe_preset",
				args: { presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
				serverId: "terminal",
				serverName: "Terminal",
				category: "terminal",
				title: "运行验证",
				summary: "godot.check_only",
				target: {
					kind: "command",
					path: "res://scripts/game.gd",
					label: "godot.check_only"
				}
			},
			{
				type: "tool.result",
				step: 0,
				toolCallId: "call-check",
				toolName: "mcp_terminal_run_safe_preset",
				resultChars: 120,
				truncated: false,
				ok: true,
				exitCode: 0,
				validationStatus: "passed",
				summary: "godot.check_only res://scripts/game.gd passed",
				artifactRefs: ["res://scripts/game.gd"]
			}
		])
	);
	const gatedOutcome = applyDeterministicVerificationGate(verifyPhase, outcome, [writeOutcome]);

	assert.equal(gatedOutcome.status, "completed");
	assert.deepEqual(gatedOutcome.failedChecks, []);
});

test("deterministic verification gate aggregates previous verify observations", (): void => {
	const writeScriptOutcome: WorkflowPhaseOutput = {
		phaseId: "write-script",
		phaseRunId: "phase-run-write-script",
		title: "写入脚本",
		status: "completed",
		summary: "updated script",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: ["scripts/game.gd"],
		verifiedArtifacts: [],
		toolObservations: []
	};
	const writeSceneOutcome: WorkflowPhaseOutput = {
		phaseId: "attach-script",
		phaseRunId: "phase-run-attach-script",
		title: "挂载脚本",
		status: "completed",
		summary: "updated scene",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: ["scenes/game.tscn"],
		verifiedArtifacts: [],
		toolObservations: []
	};
	const previousSceneVerifyOutcome: WorkflowPhaseOutput = {
		phaseId: "validate-scene-references",
		phaseRunId: "phase-run-validate-scene-references",
		title: "验证脚本引用",
		status: "needs_fix",
		summary: "needs script checks",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: [],
		verifiedArtifacts: ["scenes/game.tscn"],
		toolObservations: applyEvents([
			{
				type: "tool.result",
				step: 0,
				toolCallId: "call-scene",
				toolName: "mcp_godot_validate_scene_script_references",
				resultChars: 120,
				truncated: false,
				ok: true,
				validationStatus: "passed",
				summary: "mcp_godot_validate_scene_script_references passed",
				artifactRefs: ["scenes/game.tscn"]
			}
		])
	};
	const verifyPhase: WorkflowPhase = createPhase("auto-verify-1", "verify");
	const outcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-auto-verify-1",
		"LSP 不可用，check-only 通过。",
		applyEvents([
			{
				type: "tool.result",
				step: 0,
				toolCallId: "call-lsp-status",
				toolName: "mcp_godot_lsp_get_status",
				resultChars: 120,
				truncated: false,
				ok: false,
				validationStatus: "failed",
				environmentIssue: true,
				summary: "mcp_godot_lsp_get_status failed: godot_diagnostics_unavailable: no active workspace",
				failedChecks: ["godot_diagnostics_unavailable: no active workspace"],
				artifactRefs: []
			},
			{
				type: "tool.call",
				step: 0,
				toolCallId: "call-check",
				toolName: "mcp_terminal_run_safe_preset",
				args: { presetName: "godot.check_only", resourcePath: "scripts/game.gd" },
				serverId: "terminal",
				serverName: "Terminal",
				category: "terminal",
				title: "运行验证",
				summary: "godot.check_only",
				target: {
					kind: "command",
					path: "scripts/game.gd",
					label: "godot.check_only"
				}
			},
			{
				type: "tool.result",
				step: 0,
				toolCallId: "call-check",
				toolName: "mcp_terminal_run_safe_preset",
				resultChars: 120,
				truncated: false,
				ok: true,
				exitCode: 0,
				validationStatus: "passed",
				summary: "godot.check_only scripts/game.gd passed",
				artifactRefs: ["scripts/game.gd"]
			}
		])
	);
	const gatedOutcome = applyDeterministicVerificationGate(verifyPhase, outcome, [
		writeScriptOutcome,
		writeSceneOutcome,
		previousSceneVerifyOutcome
	]);

	assert.equal(gatedOutcome.status, "completed");
	assert.deepEqual(gatedOutcome.failedChecks, []);
});

test("deterministic verification gate accepts Godot check-only environment issue as attempted validation", (): void => {
	const writeOutcome: WorkflowPhaseOutput = {
		phaseId: "implement",
		phaseRunId: "phase-run-write",
		title: "实现修改",
		status: "completed",
		summary: "updated script",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: ["res://scripts/game.gd"],
		verifiedArtifacts: [],
		toolObservations: []
	};
	const verifyPhase: WorkflowPhase = createPhase("verify", "verify");
	const outcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-verify",
		"LSP 和 Godot CLI 均不可用。",
		applyEvents([
			{
				type: "tool.result",
				step: 0,
				toolCallId: "call-lsp-status",
				toolName: "mcp_godot_lsp_get_status",
				resultChars: 120,
				truncated: false,
				ok: false,
				validationStatus: "failed",
				environmentIssue: true,
				summary: "mcp_godot_lsp_get_status failed: godot_diagnostics_unavailable: no active workspace",
				failedChecks: ["godot_diagnostics_unavailable: no active workspace"],
				artifactRefs: []
			},
			{
				type: "tool.call",
				step: 0,
				toolCallId: "call-check",
				toolName: "mcp_terminal_run_safe_preset",
				args: { presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
				serverId: "terminal",
				serverName: "Terminal",
				category: "terminal",
				title: "运行验证",
				summary: "godot.check_only",
				target: {
					kind: "command",
					path: "res://scripts/game.gd",
					label: "godot.check_only"
				}
			},
			{
				type: "tool.result",
				step: 0,
				toolCallId: "call-check",
				toolName: "mcp_terminal_run_safe_preset",
				resultChars: 120,
				truncated: false,
				ok: false,
				exitCode: null,
				validationStatus: "failed",
				environmentIssue: true,
				summary: "godot.check_only res://scripts/game.gd failed",
				failedChecks: ["godot.check_only res://scripts/game.gd failed: Process error: spawn godot ENOENT"],
				artifactRefs: ["res://scripts/game.gd"]
			}
		])
	);
	const gatedOutcome = applyDeterministicVerificationGate(verifyPhase, outcome, [writeOutcome]);

	assert.equal(gatedOutcome.status, "completed");
	assert.equal(gatedOutcome.verificationStatus, "unverified");
	assert.equal(gatedOutcome.failedChecks.length, 0);
	assert.equal(gatedOutcome.warnings?.some((warning: string): boolean => /godot\.check_only/iu.test(warning)), true);
	assert.equal(gatedOutcome.blockedReason, undefined);
});

test("deterministic verification gate passes when required GDScript checks ran", (): void => {
	const writeOutcome: WorkflowPhaseOutput = {
		phaseId: "implement",
		phaseRunId: "phase-run-write",
		title: "实现修改",
		status: "completed",
		summary: "updated script",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: ["res://scripts/game.gd"],
		verifiedArtifacts: [],
		toolObservations: []
	};
	const verifyPhase: WorkflowPhase = createPhase("verify", "verify");
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-lsp",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			resultChars: 80,
			truncated: false,
			ok: true,
			diagnosticsCount: 0,
			diagnosticsErrorCount: 0,
			validationStatus: "passed",
			summary: "LSP diagnostics passed.",
			artifactRefs: ["res://scripts/game.gd"]
		},
		{
			type: "tool.call",
			step: 0,
			toolCallId: "call-check",
			toolName: "mcp_terminal_run_safe_preset",
			args: { presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
			serverId: "terminal",
			serverName: "Terminal",
			category: "terminal",
			title: "运行终端命令",
			summary: "godot.check_only",
			target: {
				kind: "command",
				path: "res://scripts/game.gd",
				label: "godot.check_only"
			}
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-check",
			toolName: "mcp_terminal_run_safe_preset",
			resultChars: 80,
			truncated: false,
			ok: true,
			exitCode: 0,
			validationStatus: "passed",
			summary: "godot.check_only passed",
			artifactRefs: ["res://scripts/game.gd"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(verifyPhase, "phase-run-verify", "", observations);
	const gatedOutcome = applyDeterministicVerificationGate(verifyPhase, outcome, [writeOutcome]);

	assert.equal(gatedOutcome.status, "completed");
});

test("write completion contract rejects unrelated successful mutations", (): void => {
	const phase: WorkflowPhase = {
		...createPhase("create-main-scene", "write"),
		completionContract: {
			targets: [{ kind: "artifact", path: "scenes/Main.tscn" }],
			requireAll: true
		}
	};
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "set-unrelated",
			toolName: "mcp_godot_set_project_setting",
			args: { key: "display/window/size/viewport_width", value: "1280" },
			serverId: "godot",
			serverName: "Godot",
			category: "write",
			title: "Set project setting",
			summary: "display/window/size/viewport_width",
			target: { kind: "unknown", label: "project setting" }
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "set-unrelated",
			toolName: "mcp_godot_set_project_setting",
			resultChars: 40,
			truncated: false,
			ok: true,
			validationStatus: "passed",
			summary: "Project setting updated.",
			artifactRefs: ["project.godot"]
		}
	]);

	const outcome = createWorkflowPhaseOutcome(phase, "phase-run-main", "", observations);
	assert.equal(outcome.status, "needs_fix");
	assert.equal(outcome.failedChecks[0]?.code, "target_artifact_missing");
	assert.equal(outcome.failedChecks[0]?.artifact, "scenes/Main.tscn");
});

test("write completion contract accepts the actual target artifact", (): void => {
	const phase: WorkflowPhase = {
		...createPhase("create-main-scene", "write"),
		completionContract: {
			targets: [{ kind: "artifact", path: "scenes/Main.tscn" }],
			requireAll: true
		}
	};
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "create-main",
			toolName: "mcp_godot_create_scene",
			args: { scenePath: "res://scenes/Main.tscn", rootType: "Node", rootName: "Main" },
			serverId: "godot",
			serverName: "Godot",
			category: "scene",
			title: "Create scene",
			summary: "scenes/Main.tscn",
			target: { kind: "file", path: "scenes/Main.tscn", label: "Main.tscn" }
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "create-main",
			toolName: "mcp_godot_create_scene",
			resultChars: 40,
			truncated: false,
			ok: true,
			validationStatus: "passed",
			summary: "Scene created.",
			artifactRefs: ["res://scenes/Main.tscn"]
		}
	]);

	const outcome = createWorkflowPhaseOutcome(phase, "phase-run-main", "", observations);
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.failedChecks, []);
});

test("write completion contract ignores malformed legacy prose targets", (): void => {
	const phase: WorkflowPhase = {
		...createPhase("rewrite-index", "write"),
		completionContract: {
			targets: [{ kind: "artifact", path: "index.html（rewritten game implementation）" }],
			requireAll: true
		}
	};
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "rewrite-index",
			toolName: "mcp_workspace_overwrite_text_file",
			args: { relativePath: "index.html", content: "<main>updated</main>" },
			serverId: "workspace",
			serverName: "Workspace",
			category: "write",
			title: "Rewrite index",
			summary: "index.html",
			target: { kind: "file", path: "index.html", label: "index.html" }
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "rewrite-index",
			toolName: "mcp_workspace_overwrite_text_file",
			resultChars: 40,
			truncated: false,
			ok: true,
			validationStatus: "passed",
			summary: "File overwritten.",
			artifactRefs: ["index.html"]
		}
	]);

	const outcome = createWorkflowPhaseOutcome(phase, "phase-run-index", "", observations);
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.failedChecks, []);
});

test("write completion contract rejects ambiguous bare filename target matching", (): void => {
	const phase: WorkflowPhase = {
		...createPhase("repair-main-scene", "write"),
		completionContract: {
			targets: [{ kind: "artifact", path: "Main.tscn" }],
			requireAll: true
		}
	};
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "patch-main",
			toolName: "mcp_godot_apply_scene_patch",
			args: { scenePath: "scenes/Main.tscn", operations: [{ op: "add_node" }] },
			serverId: "godot",
			serverName: "Godot",
			category: "scene",
			title: "Apply scene patch",
			summary: "scenes/Main.tscn",
			target: { kind: "file", path: "scenes/Main.tscn", label: "Main.tscn" }
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "patch-main",
			toolName: "mcp_godot_apply_scene_patch",
			resultChars: 40,
			truncated: false,
			ok: true,
			validationStatus: "passed",
			summary: "Scene patched.",
			artifactRefs: ["scenes/Main.tscn"]
		},
		{
			type: "tool.call",
			step: 1,
			toolCallId: "inspect-main",
			toolName: "mcp_godot_inspect_scene_tree",
			args: { relativePath: "scenes/Main.tscn" },
			serverId: "godot",
			serverName: "Godot",
			category: "read",
			title: "Inspect scene tree",
			summary: "scenes/Main.tscn",
			target: { kind: "file", path: "scenes/Main.tscn", label: "Main.tscn" }
		},
		{
			type: "tool.result",
			step: 1,
			toolCallId: "inspect-main",
			toolName: "mcp_godot_inspect_scene_tree",
			resultChars: 40,
			truncated: false,
			ok: true,
			validationStatus: "passed",
			summary: "Scene tree valid.",
			artifactRefs: ["scenes/Main.tscn"]
		}
	]);

	const outcome = createWorkflowPhaseOutcome(phase, "phase-run-main", "", observations);
	assert.equal(outcome.status, "needs_fix");
	assert.equal(outcome.failedChecks[0]?.code, "target_artifact_missing");
	assert.deepEqual(outcome.modifiedArtifacts, ["scenes/Main.tscn"]);
	assert.deepEqual(outcome.verifiedArtifacts, ["scenes/Main.tscn"]);
});
