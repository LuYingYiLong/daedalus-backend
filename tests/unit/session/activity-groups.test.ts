import assert from "node:assert/strict";
import test from "node:test";
import {
	annotateActivityEvent,
	createActivityGroupAccumulator,
	type ActivityGroupAnnotation
} from "../../../src/session/activity-groups.js";

function annotate(
	accumulator: ReturnType<typeof createActivityGroupAccumulator>,
	eventName: string,
	data: Record<string, unknown> = {}
): Record<string, unknown> {
	return annotateActivityEvent(accumulator, "request-activity", eventName, data);
}

function activityMetadata(data: Record<string, unknown>): ActivityGroupAnnotation {
	return {
		activityGroupId: data.activityGroupId as string,
		activityPartId: data.activityPartId as string,
		activityPartKind: data.activityPartKind as "thinking" | "tool",
		activityGroupStats: data.activityGroupStats as ActivityGroupAnnotation["activityGroupStats"]
	};
}

test("backend assigns one stable group across contiguous thinking and tools", (): void => {
	const accumulator = createActivityGroupAccumulator();
	const thinkingDelta = annotate(accumulator, "agent.thinking.delta", { text: "inspect" });
	const thinkingDone = annotate(accumulator, "agent.thinking.done", {});
	const terminalCall = annotate(accumulator, "agent.tool.call", {
		toolCallId: "tool-terminal",
		toolName: "mcp_terminal_run_command"
	});
	const terminalResult = annotate(accumulator, "agent.tool.result", {
		toolCallId: "tool-terminal",
		toolName: "mcp_terminal_run_command",
		ok: true
	});

	assert.equal(activityMetadata(thinkingDelta).activityGroupId, "activity:request-activity:1");
	assert.equal(activityMetadata(thinkingDone).activityGroupId, activityMetadata(thinkingDelta).activityGroupId);
	assert.equal(activityMetadata(thinkingDone).activityPartId, activityMetadata(thinkingDelta).activityPartId);
	assert.equal(activityMetadata(terminalCall).activityGroupId, activityMetadata(thinkingDelta).activityGroupId);
	assert.notEqual(activityMetadata(terminalCall).activityPartId, activityMetadata(thinkingDelta).activityPartId);
	assert.equal(activityMetadata(terminalResult).activityPartId, activityMetadata(terminalCall).activityPartId);
	assert.deepEqual(activityMetadata(terminalResult).activityGroupStats, {
		editedFiles: 0,
		commands: 1,
		thoughts: 1
	});
});

test("hidden lifecycle snapshots preserve a tool batch while semantic boundaries close it", (): void => {
	const accumulator = createActivityGroupAccumulator();
	const firstCall = annotate(accumulator, "agent.tool.call", {
		toolCallId: "verify-1",
		toolName: "mcp_terminal_run_safe_preset"
	});
	const executing = annotate(accumulator, "agent.run.state", { stage: "executing" });
	const firstResult = annotate(accumulator, "agent.tool.result", {
		toolCallId: "verify-1",
		toolName: "mcp_terminal_run_safe_preset",
		ok: true
	});
	const secondCall = annotate(accumulator, "agent.tool.call", {
		toolCallId: "verify-2",
		toolName: "mcp_terminal_run_safe_preset"
	});
	annotate(accumulator, "agent.step.outcome", { status: "completed" });
	const afterPhase = annotate(accumulator, "agent.tool.call", {
		toolCallId: "verify-3",
		toolName: "mcp_terminal_run_safe_preset"
	});

	assert.equal(executing.activityGroupId, undefined);
	assert.equal(firstCall.activityGroupId, firstResult.activityGroupId);
	assert.equal(firstCall.activityGroupId, secondCall.activityGroupId);
	assert.deepEqual(activityMetadata(secondCall).activityGroupStats, {
		editedFiles: 0,
		commands: 2,
		thoughts: 0
	});
	assert.notEqual(afterPhase.activityGroupId, secondCall.activityGroupId);
});

test("only non-empty thinking and unique terminal invocations contribute to activity stats", (): void => {
	const accumulator = createActivityGroupAccumulator();
	const emptyThinking = annotate(accumulator, "agent.thinking.done", {});
	const thinking = annotate(accumulator, "agent.thinking.delta", { text: "inspect" });
	const preview = annotate(accumulator, "agent.tool.call", {
		toolCallId: "verify-1",
		toolName: "mcp_terminal_run_safe_preset",
		preview: true
	});
	annotate(accumulator, "agent.thinking.done", {});
	const execution = annotate(accumulator, "agent.tool.call", {
		toolCallId: "verify-1",
		toolName: "mcp_terminal_run_safe_preset"
	});

	assert.equal(activityMetadata(emptyThinking).activityGroupStats.thoughts, 0);
	assert.equal(activityMetadata(thinking).activityGroupStats.thoughts, 1);
	assert.deepEqual(activityMetadata(preview).activityGroupStats, {
		editedFiles: 0,
		commands: 1,
		thoughts: 1
	});
	assert.deepEqual(activityMetadata(execution).activityGroupStats, {
		editedFiles: 0,
		commands: 1,
		thoughts: 1
	});
});

test("structured file batches are deduplicated by source and failed results do not count", (): void => {
	const accumulator = createActivityGroupAccumulator();
	annotate(accumulator, "agent.tool.call", {
		toolCallId: "write-1",
		toolName: "mcp_workspace_overwrite_text_file"
	});
	const firstResult = annotate(accumulator, "agent.tool.result", {
		toolCallId: "write-1",
		toolName: "mcp_workspace_overwrite_text_file",
		ok: true,
		fileEditBatch: {
			batchId: "batch-1",
			editedFiles: [
				{ sourceFolderId: "frontend", path: "src/App.tsx" },
				{ sourceFolderId: "frontend", path: "src/App.tsx" }
			]
		}
	});

	annotate(accumulator, "agent.tool.call", {
		toolCallId: "write-2",
		toolName: "mcp_workspace_overwrite_text_file"
	});
	const secondResult = annotate(accumulator, "agent.tool.result", {
		toolCallId: "write-2",
		toolName: "mcp_workspace_overwrite_text_file",
		ok: false,
		fileEditBatch: {
			batchId: "batch-failed",
			editedFileCount: 20
		}
	});

	assert.equal(activityMetadata(firstResult).activityGroupStats.editedFiles, 1);
	assert.equal(activityMetadata(secondResult).activityGroupStats.editedFiles, 1);
});

test("a non-activity event closes the current group and the next activity starts a new one", (): void => {
	const accumulator = createActivityGroupAccumulator();
	const first = annotate(accumulator, "agent.tool.call", {
		toolCallId: "read-1",
		toolName: "mcp_workspace_read_text_file"
	});
	const boundary = annotate(accumulator, "agent.message.delta", { text: "answer" });
	const second = annotate(accumulator, "agent.tool.call", {
		toolCallId: "read-2",
		toolName: "mcp_workspace_read_text_file"
	});

	assert.equal((first.activityGroupId as string), "activity:request-activity:1");
	assert.equal(boundary.activityGroupId, undefined);
	assert.equal((second.activityGroupId as string), "activity:request-activity:2");
});
