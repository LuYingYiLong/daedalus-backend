import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetSessionDatabaseForTests } from "../../../src/session/session-database.js";
import {
	appendMessage,
	createSession,
	getStoredSessionMetadata,
	listSessions,
} from "../../../src/session/session-store.js";
import { createSessionFork } from "../../../src/session/session-fork.js";
import {
	acquireConversationFlowRun,
	addConversationFlowBranch,
	assertSessionCanUseStandaloneMutation,
	createConversationFlow,
	getConversationFlow,
	releaseConversationFlowRun,
	setConversationFlowBranchSeedRequest,
	updateConversationFlowLayout,
} from "../../../src/session/conversation-flow-store.js";

test("conversation Flow isolates sessions, projects branches, persists layout, and enforces one run", async (): Promise<void> => {
	const directory: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-flow-"));
	const databasePath: string = path.join(directory, "sessions.sqlite");
	await resetSessionDatabaseForTests(databasePath);
	try {
		const root = await createSession("Flow source", "workspace-a");
		await appendMessage(root.id, { role: "user", content: "First", requestId: "request-1", createdAt: "2026-09-15T00:00:00.000Z" });
		await appendMessage(root.id, { role: "assistant", content: "First answer", requestId: "request-1", createdAt: "2026-09-15T00:00:01.000Z" });
		await appendMessage(root.id, { role: "user", content: "Try again", requestId: "request-2", createdAt: "2026-09-15T00:00:02.000Z" });
		await appendMessage(root.id, { role: "assistant", content: "Original answer", requestId: "request-2", createdAt: "2026-09-15T00:00:03.000Z" });

		const created = await createConversationFlow({ title: "Branching test", rootSession: root });
		const rootMetadata = await getStoredSessionMetadata(root.id);
		assert.equal(rootMetadata.surface, "flow_branch");
		assert.deepEqual(rootMetadata.flow, { flowId: created.flow.flowId, branchId: created.flow.rootBranchId });
		assert.equal((await listSessions()).some((session): boolean => session.id === root.id), true);
		await assert.rejects(assertSessionCanUseStandaloneMutation(root.id), { code: "flow_session_managed" });

		const clone = await createSessionFork({
			sourceSessionId: root.id,
			sourceRequestId: "request-2",
			title: "Regenerated branch",
			cutoff: "before_user",
		});
		const branch = await addConversationFlowBranch({
			flowId: created.flow.flowId,
			session: clone.metadata,
			parentBranchId: created.flow.rootBranchId,
			forkRequestId: "request-2",
			forkRole: "user",
		});
		await setConversationFlowBranchSeedRequest(branch.branchId, "request-regenerated");
		await appendMessage(branch.sessionId, { role: "user", content: "Try again", requestId: "request-regenerated", createdAt: "2026-09-15T00:00:04.000Z" });
		await appendMessage(branch.sessionId, { role: "assistant", content: "New answer", requestId: "request-regenerated", createdAt: "2026-09-15T00:00:05.000Z" });

		const projected = await getConversationFlow(created.flow.flowId);
		assert.equal(projected.nodes.filter((node): boolean => node.role === "user").length, 2);
		assert.equal(projected.nodes.some((node): boolean => node.nodeId === "user:request-regenerated"), false);
		assert.equal(
			projected.nodes.find((node): boolean => node.nodeId === "assistant:request-regenerated")?.parentNodeId,
			"user:request-2",
		);

		const locked = await acquireConversationFlowRun(branch.sessionId, "run-branch");
		assert.equal(locked?.activeBranchId, branch.branchId);
		await assert.rejects(acquireConversationFlowRun(root.id, "run-root"), { code: "flow_busy" });
		const released = await releaseConversationFlowRun(branch.sessionId, "run-branch");
		assert.equal(released?.activeRequestId, null);

		const node = projected.nodes[0]!;
		await assert.rejects(updateConversationFlowLayout(created.flow.flowId, released!.revision, [
			{ nodeId: "assistant:missing", x: 0, y: 0 },
		]), { code: "flow_node_not_found" });
		const layout = await updateConversationFlowLayout(created.flow.flowId, released!.revision, [
			{ nodeId: node.nodeId, x: 120, y: 80 },
		]);
		assert.equal(layout.revision, released!.revision + 1);
		assert.deepEqual((await getConversationFlow(created.flow.flowId)).positions, [{ nodeId: node.nodeId, x: 120, y: 80 }]);
		await assert.rejects(updateConversationFlowLayout(created.flow.flowId, released!.revision, []), { code: "flow_revision_conflict" });
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("assistant-derived Flow branches continue from the selected answer", async (): Promise<void> => {
	const directory: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-flow-answer-branch-"));
	await resetSessionDatabaseForTests(path.join(directory, "sessions.sqlite"));
	try {
		const root = await createSession("Flow source", "workspace-a");
		await appendMessage(root.id, { role: "user", content: "First", requestId: "request-1", createdAt: "2026-09-15T00:00:00.000Z" });
		await appendMessage(root.id, { role: "assistant", content: "First answer", requestId: "request-1", createdAt: "2026-09-15T00:00:01.000Z" });
		const created = await createConversationFlow({ title: "Answer branch", rootSession: root });
		const clone = await createSessionFork({
			sourceSessionId: root.id,
			sourceRequestId: "request-1",
			title: "Continued answer",
			cutoff: "through_request",
		});
		const branch = await addConversationFlowBranch({
			flowId: created.flow.flowId,
			session: clone.metadata,
			parentBranchId: created.flow.rootBranchId,
			forkRequestId: "request-1",
			forkRole: "assistant",
		});
		await acquireConversationFlowRun(branch.sessionId, "request-2", "Continue here");
		const running = await getConversationFlow(created.flow.flowId);
		assert.equal(running.nodes.find((node): boolean => node.nodeId === "user:request-2")?.parentNodeId, "assistant:request-1");
		assert.equal(running.nodes.find((node): boolean => node.nodeId === "assistant:request-2")?.parentNodeId, "user:request-2");
		assert.equal(running.nodes.find((node): boolean => node.nodeId === "assistant:request-2")?.status, "streaming");
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("legacy session metadata normalizes to the chat surface", async (): Promise<void> => {
	const directory: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-flow-metadata-"));
	await resetSessionDatabaseForTests(path.join(directory, "sessions.sqlite"));
	try {
		const session = await createSession("Chat");
		assert.equal(session.surface, "chat");
		assert.equal(session.flow, undefined);
	} finally {
		await resetSessionDatabaseForTests();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
