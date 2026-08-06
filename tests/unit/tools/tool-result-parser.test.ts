import assert from "node:assert/strict";
import test from "node:test";
import { parseToolResultSummary } from "../../../src/tools/tool-result-parser.js";

test("terminal preset failed result becomes structured failed validation", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: false,
			exitCode: 1,
			stderr: "Parser Error: Unexpected token",
			resourcePath: "res://scripts/game.gd"
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.exitCode, 1);
	assert.equal(summary.validationStatus, "failed");
	assert.match(summary.summary ?? "", /godot\.check_only/);
	assert.deepEqual(summary.artifactRefs, ["res://scripts/game.gd"]);
	assert.equal(summary.failedChecks?.length, 1);
	assert.match(summary.failedChecks?.[0] ?? "", /Unexpected token/);
});

test("free terminal command exposes a bounded redacted display snapshot", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_command",
		{ commandLine: "curl -H 'Authorization: Bearer private-token' https://example.test", cwd: "scripts" },
		JSON.stringify({
			ok: true,
			exitCode: 0,
			commandLine: "curl -H 'Authorization: Bearer private-token' https://example.test",
			cwd: "C:\\private\\workspace\\scripts",
			sandboxMode: "os-sandbox",
			stdout: `\u001b[32mTOKEN=private-token\u001b[0m\n${"x".repeat(7000)}`,
			stderr: "",
			durationMs: 1250,
			truncated: false
		})
	);

	assert.equal(summary.terminalDisplay?.cwd, "scripts");
	assert.equal(summary.terminalDisplay?.sandboxMode, "os-sandbox");
	assert.equal(summary.terminalDisplay?.durationMs, 1250);
	assert.doesNotMatch(summary.terminalDisplay?.commandLine ?? "", /private-token/);
	assert.doesNotMatch(summary.terminalDisplay?.stdout ?? "", /private-token|\u001b/);
	assert.ok((summary.terminalDisplay?.stdout.length ?? 0) <= 6000);
	assert.ok((summary.terminalDisplay?.stdoutOmittedChars ?? 0) > 0);
});

test("generic valid false result with errors becomes failed validation", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_create_text_file",
		{ relativePath: "scenes/tic_tac_toe.tscn" },
		JSON.stringify({
			valid: false,
			path: "scenes/tic_tac_toe.tscn",
			errors: ["File already exists: scenes/tic_tac_toe.tscn"]
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.validationStatus, "failed");
	assert.deepEqual(summary.failedChecks, ["File already exists: scenes/tic_tac_toe.tscn"]);
	assert.deepEqual(summary.artifactRefs, ["scenes/tic_tac_toe.tscn"]);
});

test("Godot terminal spawn errors are marked as environment issues", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: false,
			exitCode: null,
			stderr: "Process error: spawn godot ENOENT",
			resourcePath: "res://scripts/game.gd"
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.validationStatus, "failed");
	assert.equal(summary.environmentIssue, true);
	assert.equal(summary.applicabilityCode, "godot_runtime_unavailable");
	assert.match(summary.failedChecks?.[0] ?? "", /spawn godot ENOENT/);
});

test("parsed tool results preserve source-scoped evidence", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ sourceFolderId: "backend", presetName: "workspace.typecheck", resourcePath: "src/workflow/router.ts" },
		JSON.stringify({ ok: true, validationStatus: "passed", resourcePath: "src/workflow/router.ts" }),
		"workspace-test"
	);
	assert.equal(summary.sourceFolderId, "backend");
	assert.deepEqual(summary.artifactFileRefs, [{
		workspaceId: "workspace-test",
		sourceFolderId: "backend",
		relativePath: "src/workflow/router.ts"
	}]);
});

test("Git checks in a non-Git workspace are not applicable, not failed", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "git.status" },
		JSON.stringify({
			preset: "git.status",
			ok: false,
			exitCode: 128,
			stderr: "fatal: not a git repository (or any of the parent directories): .git"
		})
	);

	assert.equal(summary.validationStatus, "not_applicable");
	assert.equal(summary.environmentIssue, true);
	assert.deepEqual(summary.failedChecks, undefined);
	assert.equal(summary.applicabilityCode, "git_repository_missing");
	assert.match(summary.notApplicableReason ?? "", /not a Git repository/);
});

test("workspace typecheck without a package script is not applicable", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "workspace.typecheck" },
		JSON.stringify({
			preset: "workspace.typecheck",
			ok: false,
			exitCode: 1,
			stderr: "npm error code ENOENT\nnpm error syscall open\nnpm error path C:\\test2\\package.json"
		})
	);

	assert.equal(summary.validationStatus, "not_applicable");
	assert.equal(summary.environmentIssue, true);
	assert.deepEqual(summary.failedChecks, undefined);
	assert.equal(summary.applicabilityCode, "package_manifest_missing");
});

test("legacy applicability requires the exact preset and exit code", (): void => {
	const wrongExitCode = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "git.status" },
		JSON.stringify({ preset: "git.status", ok: false, exitCode: 1, stderr: "fatal: not a git repository" })
	);
	assert.equal(wrongExitCode.validationStatus, "failed");
	assert.equal(wrongExitCode.applicabilityCode, undefined);

	const ordinaryTypecheckFailure = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "workspace.typecheck" },
		JSON.stringify({ preset: "workspace.typecheck", ok: false, exitCode: 1, stderr: "typecheck failed: missing dependency" })
	);
	assert.equal(ordinaryTypecheckFailure.validationStatus, "failed");
	assert.equal(ordinaryTypecheckFailure.applicabilityCode, undefined);

	const genericEnoent = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "workspace.typecheck" },
		JSON.stringify({ preset: "workspace.typecheck", ok: false, exitCode: 1, stderr: "Error: ENOENT while reading cache" })
	);
	assert.equal(genericEnoent.validationStatus, "failed");
	assert.equal(genericEnoent.applicabilityCode, undefined);
});

test("structured applicability wins over legacy text and never creates failed checks", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "workspace.typecheck" },
		JSON.stringify({
			preset: "workspace.typecheck",
			ok: false,
			exitCode: 1,
			validationStatus: "not_applicable",
			applicabilityCode: "typecheck_script_missing",
			notApplicableReason: "No typecheck script",
			failedChecks: ["this must not enter repair"]
		})
	);
	assert.equal(summary.validationStatus, "not_applicable");
	assert.equal(summary.applicabilityCode, "typecheck_script_missing");
	assert.equal(summary.failedChecks, undefined);
});

test("LSP diagnostics result counts errors and marks validation failed", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_lsp_get_file_diagnostics",
		{ resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: true,
			resourcePath: "res://scripts/game.gd",
			diagnostics: [
				{ severity: "error", message: "Unknown identifier", lineStart: 4, columnStart: 2 },
				{ severity: "warning", message: "Unused variable", lineStart: 5, columnStart: 2 }
			]
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.diagnosticsCount, 2);
	assert.equal(summary.diagnosticsErrorCount, 1);
	assert.equal(summary.validationStatus, "failed");
	assert.deepEqual(summary.artifactRefs, ["res://scripts/game.gd"]);
	assert.match(summary.failedChecks?.[0] ?? "", /Unknown identifier/);
});

test("empty LSP diagnostics result marks validation passed", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_lsp_get_file_diagnostics",
		{ resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: true,
			resourcePath: "res://scripts/game.gd",
			diagnostics: []
		})
	);

	assert.equal(summary.ok, true);
	assert.equal(summary.diagnosticsCount, 0);
	assert.equal(summary.diagnosticsErrorCount, 0);
	assert.equal(summary.validationStatus, "passed");
	assert.deepEqual(summary.failedChecks, []);
});

test("LSP status preserves unavailable workspace as environment issue", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_lsp_get_status",
		{},
		JSON.stringify({
			ok: false,
			error: {
				code: "godot_diagnostics_unavailable",
				message: "godot_diagnostics_unavailable: no active workspace"
			}
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.validationStatus, "failed");
	assert.equal(summary.environmentIssue, true);
	assert.equal(summary.applicabilityCode, "diagnostics_unavailable");
	assert.match(summary.summary ?? "", /no active workspace/);
	assert.match(summary.failedChecks?.[0] ?? "", /no active workspace/);
});

test("LSP diagnostics unavailable keeps error text instead of reporting zero clean diagnostics", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_lsp_get_file_diagnostics",
		{ resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: false,
			error: {
				code: "godot_diagnostics_unavailable",
				message: "godot_diagnostics_unavailable: no active workspace"
			}
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.validationStatus, "failed");
	assert.equal(summary.environmentIssue, true);
	assert.equal(summary.applicabilityCode, "diagnostics_unavailable");
	assert.match(summary.summary ?? "", /unavailable/);
	assert.match(summary.failedChecks?.[0] ?? "", /no active workspace/);
});

test("diagnostic timeout and ordinary Godot not-found text remain ordinary failures", (): void => {
	const timeout = parseToolResultSummary(
		"mcp_godot_lsp_get_status",
		{},
		JSON.stringify({ ok: false, error: { message: "request timeout while checking a script" } })
	);
	assert.equal(timeout.validationStatus, "failed");
	assert.equal(timeout.environmentIssue, undefined);
	assert.equal(timeout.applicabilityCode, undefined);

	const notFound = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "godot.check_only" },
		JSON.stringify({ ok: false, status: "failed", exitCode: 1, stderr: "Project reported resource not found" })
	);
	assert.equal(notFound.validationStatus, "failed");
	assert.equal(notFound.environmentIssue, undefined);
	assert.equal(notFound.applicabilityCode, undefined);
});
