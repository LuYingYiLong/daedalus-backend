import assert from "node:assert/strict";
import test from "node:test";
import type { ToolEvent } from "../../../src/tools/tool-dispatcher.js";
import {
	addLightweightActionObservation,
	applyToolEventToLightweightActionState,
	collectLightweightActionCompletionStatus,
	createLightweightActionState,
	LightweightActionScopeExceededError
} from "../../../src/workflow/lightweight-action.js";

function call(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>
): ToolEvent {
	return { type: "tool.call", step: 1, toolCallId, toolName, args } as ToolEvent;
}

function result(
	toolCallId: string,
	toolName: string,
	options: {
		ok?: boolean;
		environmentIssue?: boolean;
		summary?: string;
		failedChecks?: string[];
		artifactRefs?: string[];
	} = {}
): ToolEvent {
	return {
		type: "tool.result",
		step: 1,
		toolCallId,
		toolName,
		resultChars: 10,
		truncated: false,
		...options
	};
}

test("lightweight text edits are verified by a matching readback", (): void => {
	const state = createLightweightActionState();
	applyToolEventToLightweightActionState(state, call("write-1", "mcp_workspace_replace_text_in_file", {
		relativePath: ".gitignore"
	}));
	applyToolEventToLightweightActionState(state, result("write-1", "mcp_workspace_replace_text_in_file", {
		ok: true,
		artifactRefs: [".gitignore"]
	}));
	applyToolEventToLightweightActionState(state, call("read-1", "mcp_workspace_read_text_file", {
		relativePath: ".gitignore"
	}));
	applyToolEventToLightweightActionState(state, result("read-1", "mcp_workspace_read_text_file", {
		ok: true,
		artifactRefs: [".gitignore"]
	}));

	assert.deepEqual(collectLightweightActionCompletionStatus(state), {
		resultStatus: "completed",
		verificationStatus: "verified",
		warnings: []
	});
});

test("approved writes preserve their pending target for readback matching", (): void => {
	const state = createLightweightActionState([{
		toolCallId: "write-1",
		toolName: "mcp_workspace_replace_text_in_file",
		risk: "write",
		status: "approval_required",
		argsSummary: { relativePath: ".gitignore" },
		artifactRefs: []
	}]);
	addLightweightActionObservation(state, {
		toolCallId: "write-1",
		toolName: "mcp_workspace_replace_text_in_file",
		risk: "write",
		status: "succeeded",
		argsSummary: {},
		artifactRefs: []
	});
	applyToolEventToLightweightActionState(state, call("read-1", "mcp_workspace_read_text_file", {
		relativePath: ".gitignore"
	}));
	applyToolEventToLightweightActionState(state, result("read-1", "mcp_workspace_read_text_file", {
		ok: true
	}));

	assert.equal(collectLightweightActionCompletionStatus(state).verificationStatus, "verified");
});

test("unrelated Godot verification does not validate a gitignore edit", (): void => {
	const state = createLightweightActionState();
	applyToolEventToLightweightActionState(state, call("write-1", "mcp_workspace_replace_text_in_file", {
		relativePath: ".gitignore"
	}));
	applyToolEventToLightweightActionState(state, result("write-1", "mcp_workspace_replace_text_in_file", {
		ok: true,
		artifactRefs: [".gitignore"]
	}));
	applyToolEventToLightweightActionState(state, call("verify-1", "mcp_terminal_run_safe_preset", {
		presetName: "godot.check_only"
	}));
	applyToolEventToLightweightActionState(state, result("verify-1", "mcp_terminal_run_safe_preset", {
		ok: true
	}));

	const completion = collectLightweightActionCompletionStatus(state);
	assert.equal(completion.verificationStatus, "unverified");
	assert.match(completion.warnings[0] ?? "", /没有成功的针对性验证或内容回读/);
});

test("environment verification failures become warnings", (): void => {
	const state = createLightweightActionState();
	applyToolEventToLightweightActionState(state, call("write-1", "mcp_workspace_replace_text_in_file", {
		relativePath: "src/app.ts"
	}));
	applyToolEventToLightweightActionState(state, result("write-1", "mcp_workspace_replace_text_in_file", {
		ok: true,
		artifactRefs: ["src/app.ts"]
	}));
	applyToolEventToLightweightActionState(state, call("verify-1", "mcp_terminal_run_safe_preset", {
		presetName: "workspace.typecheck"
	}));
	applyToolEventToLightweightActionState(state, result("verify-1", "mcp_terminal_run_safe_preset", {
		ok: false,
		environmentIssue: true,
		summary: "TypeScript is not available"
	}));

	const completion = collectLightweightActionCompletionStatus(state);
	assert.equal(completion.resultStatus, "completed_with_warnings");
	assert.equal(completion.verificationStatus, "unverified");
	assert.equal(completion.failureMessage, undefined);
	assert.match(completion.warnings.join("\n"), /not available/);
});

test("deterministic verification failures gracefully block the lightweight action", (): void => {
	const state = createLightweightActionState();
	applyToolEventToLightweightActionState(state, call("write-1", "mcp_workspace_replace_text_in_file", {
		relativePath: "src/app.ts"
	}));
	applyToolEventToLightweightActionState(state, result("write-1", "mcp_workspace_replace_text_in_file", {
		ok: true,
		artifactRefs: ["src/app.ts"]
	}));
	applyToolEventToLightweightActionState(state, call("verify-1", "mcp_terminal_run_safe_preset", {
		presetName: "workspace.typecheck"
	}));
	applyToolEventToLightweightActionState(state, result("verify-1", "mcp_terminal_run_safe_preset", {
		ok: false,
		failedChecks: ["TS2322 in src/app.ts"]
	}));

	const completion = collectLightweightActionCompletionStatus(state);
	assert.equal(completion.resultStatus, "blocked");
	assert.equal(completion.failureMessage, undefined);
	assert.match(completion.warnings.join("\n"), /TS2322/);
});

test("a later deterministic failure is not hidden by an earlier readback", (): void => {
	const state = createLightweightActionState();
	applyToolEventToLightweightActionState(state, call("write-1", "mcp_workspace_replace_text_in_file", {
		relativePath: "src/app.ts"
	}));
	applyToolEventToLightweightActionState(state, result("write-1", "mcp_workspace_replace_text_in_file", {
		ok: true,
		artifactRefs: ["src/app.ts"]
	}));
	applyToolEventToLightweightActionState(state, call("read-1", "mcp_workspace_read_text_file", {
		relativePath: "src/app.ts"
	}));
	applyToolEventToLightweightActionState(state, result("read-1", "mcp_workspace_read_text_file", {
		ok: true,
		artifactRefs: ["src/app.ts"]
	}));
	applyToolEventToLightweightActionState(state, call("verify-1", "mcp_terminal_run_safe_preset", {
		presetName: "workspace.typecheck"
	}));
	applyToolEventToLightweightActionState(state, result("verify-1", "mcp_terminal_run_safe_preset", {
		ok: false,
		failedChecks: ["TS1005 in src/app.ts"]
	}));

	const completion = collectLightweightActionCompletionStatus(state);
	assert.equal(completion.resultStatus, "blocked");
	assert.match(completion.warnings.join("\n"), /TS1005/);
});

test("an unresolved business write failure is blocked instead of reported as completed", (): void => {
	const state = createLightweightActionState();
	applyToolEventToLightweightActionState(state, call("write-1", "mcp_workspace_replace_text_in_file", {
		relativePath: "src/app.ts"
	}));
	applyToolEventToLightweightActionState(state, {
		type: "tool.error",
		step: 1,
		toolCallId: "write-1",
		toolName: "mcp_workspace_replace_text_in_file",
		message: "oldText was not found",
		failure: {
			code: "old_text_not_found",
			category: "business",
			message: "oldText was not found",
			retryable: true,
			artifactRefs: ["src/app.ts"]
		}
	});

	const completion = collectLightweightActionCompletionStatus(state);
	assert.equal(completion.resultStatus, "blocked");
	assert.match(completion.warnings[0] ?? "", /old_text_not_found/);
});

test("a third automatic write escalates the lightweight action", (): void => {
	const state = createLightweightActionState();
	for (const id of ["write-1", "write-2"]) {
		applyToolEventToLightweightActionState(state, call(id, "mcp_workspace_replace_text_in_file", {
			relativePath: `${id}.txt`
		}), true);
	}

	assert.throws((): void => {
		applyToolEventToLightweightActionState(state, call("write-3", "mcp_workspace_replace_text_in_file", {
			relativePath: "write-3.txt"
		}), true);
	}, LightweightActionScopeExceededError);
});
