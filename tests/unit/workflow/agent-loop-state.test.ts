import assert from "node:assert/strict";
import test from "node:test";
import {
	cloneAgentLoopState,
	createAgentLoopRecoveryController,
	createAgentLoopState,
	AGENT_LOOP_NO_PROGRESS_EXHAUSTED_CALLS,
	AGENT_LOOP_NO_PROGRESS_WARNING_CALLS,
	isAgentLoopState,
	MAX_AGENT_LOOP_RECOVERY_ATTEMPTS
} from "../../../src/workflow/agent-loop-state.js";
import type { ToolFailure } from "../../../src/tools/tool-failure.js";

function retryableFailure(code: string = "old_text_not_found"): ToolFailure {
	return {
		code,
		category: "business",
		message: "The structured target could not be changed.",
		retryable: true,
		artifactRefs: ["src/a.ts"],
		sourceFolderId: "backend"
	};
}

test("the same structured operation is exhausted after three failures", (): void => {
	const state = createAgentLoopState();
	const recovery = createAgentLoopRecoveryController(state);
	const args = { sourceFolderId: "backend", relativePath: "src/a.ts", oldText: "x", newText: "y" };
	for (let attempt: number = 1; attempt <= MAX_AGENT_LOOP_RECOVERY_ATTEMPTS; attempt += 1) {
		const failure = recovery.recordFailure("mcp_workspace_replace_text_in_file", args, retryableFailure());
		assert.equal((failure.details?.recovery as { attempt: number }).attempt, attempt);
	}
	const exhausted = recovery.beforeCall("mcp_workspace_replace_text_in_file", {
		...args,
		oldText: "corrected context"
	});
	assert.equal(exhausted?.code, "retry_exhausted");
});

test("success on the same source-scoped target marks its failure recovered", (): void => {
	const state = createAgentLoopState();
	const recovery = createAgentLoopRecoveryController(state);
	const firstArgs = { sourceFolderId: "backend", relativePath: "src/a.ts", oldText: "x", newText: "y" };
	recovery.recordFailure("mcp_workspace_replace_text_in_file", firstArgs, retryableFailure());
	const status = recovery.recordSuccess("mcp_workspace_replace_text_in_file", {
		...firstArgs,
		oldText: "new current value"
	});
	assert.equal(status?.status, "recovered");
	assert.equal(state.recoveryEntries[0]?.status, "recovered");
});

test("same relative path in another source folder has an independent recovery key", (): void => {
	const state = createAgentLoopState();
	const recovery = createAgentLoopRecoveryController(state);
	const backend = { sourceFolderId: "backend", relativePath: "src/a.ts" };
	const frontend = { sourceFolderId: "frontend", relativePath: "src/a.ts" };
	recovery.recordFailure("mcp_workspace_overwrite_text_file", backend, retryableFailure());
	assert.equal(recovery.recordSuccess("mcp_workspace_overwrite_text_file", frontend), undefined);
	assert.equal(state.recoveryEntries[0]?.status, "unresolved");
});

test("an unchanged invalid-argument call is blocked before it reaches the tool again", (): void => {
	const state = createAgentLoopState();
	const recovery = createAgentLoopRecoveryController(state);
	const args = { scope: "workspace", slug: "release-helper", skillMd: "---\nname: Release\ndescription: x\n---" };
	const failure = recovery.recordFailure("mcp_skills_propose_create", args, {
		code: "invalid_arguments",
		category: "protocol",
		message: "scope is invalid",
		retryable: true,
		artifactRefs: []
	});

	assert.equal((failure.details?.recovery as { attempt: number }).attempt, 1);
	assert.equal(recovery.beforeCall("mcp_skills_propose_create", args)?.code, "retry_exhausted");
	assert.equal(recovery.beforeCall("mcp_skills_propose_create", {
		...args,
		scope: "project"
	}), undefined);
});

test("repeated structured operations receive a correction window without user interaction", (): void => {
	const state = createAgentLoopState();
	const recovery = createAgentLoopRecoveryController(state);
	const args = { sourceFolderId: "backend", relativePath: "src/a.ts" };

	assert.equal(recovery.beforeCall("mcp_workspace_read_text_file", args), undefined);
	assert.equal(recovery.recordProgress("mcp_workspace_read_text_file", args, "same result"), undefined);
	for (let attempt: number = 1; attempt < AGENT_LOOP_NO_PROGRESS_WARNING_CALLS; attempt += 1) {
		assert.equal(recovery.beforeCall("mcp_workspace_read_text_file", args), undefined);
		assert.equal(recovery.recordProgress("mcp_workspace_read_text_file", args, "same result"), undefined);
	}
	assert.equal(
		recovery.recordProgress("mcp_workspace_read_text_file", args, "same result")?.code,
		"agent_loop_no_progress_detected"
	);

	for (
		let attempt: number = AGENT_LOOP_NO_PROGRESS_WARNING_CALLS + 1;
		attempt < AGENT_LOOP_NO_PROGRESS_EXHAUSTED_CALLS;
		attempt += 1
	) {
		assert.equal(
			recovery.recordProgress("mcp_workspace_read_text_file", args, "same result")?.code,
			"agent_loop_no_progress_detected"
		);
	}
	assert.equal(
		recovery.recordProgress("mcp_workspace_read_text_file", args, "same result")?.code,
		"agent_loop_no_progress_exhausted"
	);
});

test("a changed structured result resets no-progress detection", (): void => {
	const state = createAgentLoopState();
	const recovery = createAgentLoopRecoveryController(state);
	const first = { sourceFolderId: "backend", relativePath: "src/a.ts" };
	for (let attempt: number = 0; attempt <= AGENT_LOOP_NO_PROGRESS_WARNING_CALLS; attempt += 1) {
		recovery.beforeCall("mcp_workspace_read_text_file", first);
		recovery.recordProgress("mcp_workspace_read_text_file", first, "same result");
	}

	assert.equal(recovery.recordProgress("mcp_workspace_read_text_file", first, "changed result"), undefined);
	assert.equal(state.progress?.consecutiveNoProgressCalls, 0);
});

test("persisted Agent Loop state keeps progress while old v1 state remains readable", (): void => {
	const oldState = { schemaVersion: 1 as const, recoveryEntries: [] };
	assert.equal(isAgentLoopState(oldState), true);

	const recovery = createAgentLoopRecoveryController(oldState);
	recovery.beforeCall("mcp_workspace_read_text_file", { relativePath: "src/a.ts" });
	recovery.recordProgress("mcp_workspace_read_text_file", { relativePath: "src/a.ts" }, "content");
	const restored = cloneAgentLoopState(oldState);
	assert.equal(restored.progress?.totalToolCalls, 1);
	assert.equal(restored.progress?.observedResultKeys.length, 1);
});
