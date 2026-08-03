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
	assert.match(summary.failedChecks?.[0] ?? "", /spawn godot ENOENT/);
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
	assert.match(summary.summary ?? "", /unavailable/);
	assert.match(summary.failedChecks?.[0] ?? "", /no active workspace/);
});
