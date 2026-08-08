import assert from "node:assert/strict";
import test from "node:test";
import { collectUnresolvedExecutionFailures } from "../../../src/workflow/evidence-failures.js";
import type { ExecutionEvidence } from "../../../src/workflow/agent-run-state.js";

function evidence(overrides: Partial<ExecutionEvidence>): ExecutionEvidence {
	return {
		toolCallId: "call",
		toolName: "mcp_workspace_replace_text_in_file",
		risk: "write",
		status: "succeeded",
		artifactRefs: [],
		observedAt: new Date().toISOString(),
		...overrides
	};
}

test("an exact structured recovery key resolves an earlier failure", (): void => {
	const failure = evidence({
		toolCallId: "failed",
		status: "failed",
		failure: {
			code: "old_text_not_found",
			category: "business",
			message: "not found",
			retryable: true,
			artifactRefs: []
		},
		recovery: { recoveryKey: "target-a", attempt: 1, maxAttempts: 3, status: "failed" }
	});
	const success = evidence({
		toolCallId: "succeeded",
		recovery: { recoveryKey: "target-a", attempt: 1, maxAttempts: 3, status: "recovered" }
	});
	assert.deepEqual(collectUnresolvedExecutionFailures([failure, success]), []);
});

test("a later same-name success without a shared target does not erase a failure", (): void => {
	const failure = evidence({
		toolCallId: "failed",
		status: "failed",
		failure: {
			code: "invalid_arguments",
			category: "protocol",
			message: "invalid",
			retryable: true,
			artifactRefs: []
		}
	});
	const unrelatedSuccess = evidence({ toolCallId: "succeeded" });
	assert.deepEqual(collectUnresolvedExecutionFailures([failure, unrelatedSuccess]), [failure]);
});

test("same relative path in another source folder cannot resolve a failure", (): void => {
	const failure = evidence({
		toolCallId: "failed",
		status: "failed",
		artifactRefs: ["src/a.ts"],
		sourceFolderId: "backend",
		failure: {
			code: "target_not_found",
			category: "business",
			message: "not found",
			retryable: true,
			artifactRefs: ["src/a.ts"],
			sourceFolderId: "backend"
		}
	});
	const otherSource = evidence({
		toolCallId: "succeeded",
		artifactRefs: ["src/a.ts"],
		sourceFolderId: "frontend"
	});
	assert.deepEqual(collectUnresolvedExecutionFailures([failure, otherSource]), [failure]);
});
