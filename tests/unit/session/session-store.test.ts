import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatMessage } from "../../../src/protocol/types.js";

async function withTempAppData<T>(
	fn: (store: typeof import("../../../src/session/session-store.js"), appDataDir: string) => Promise<T>
): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-session-appdata-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../../../src/session/session-store.js?case=${Date.now()}-${Math.random()}`);
		return await fn(store, appDataDir);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
}

test("session store creates, opens, pages, rewinds, archives, restores, and deletes sessions", async (): Promise<void> => {
	await withTempAppData(async (store, appDataDir): Promise<void> => {
		const metadata = await store.createSession("First session", "workspace-a", "gdscript.review");
		assert.match(metadata.id, /^session-/);
		assert.equal(metadata.title, "First session");
		assert.equal(metadata.workspaceId, "workspace-a");
		await assert.rejects(fs.stat(path.join(appDataDir, ".daedalus", "sessions")));

		const firstMessage: ChatMessage = {
			role: "user",
			content: "hello",
			requestId: "req-1",
			createdAt: "2026-07-03T00:00:00.000Z"
		};
		const secondMessage: ChatMessage = {
			role: "assistant",
			content: "world",
			requestId: "req-2",
			createdAt: "2026-07-03T00:00:01.000Z"
		};
		await store.appendMessage(metadata.id, firstMessage);
		await store.appendSessionEvent(metadata.id, "req-1", "tool.call", { toolName: "mcp_godot_read_text_file" });
		await store.appendMessage(metadata.id, secondMessage);
		await store.appendSessionEvent(metadata.id, "req-2", "workflow.todo.updated", { phases: [] });
		await store.appendApprovalEvent(metadata.id, "approval-req-2", "req-2", "requested", { approvalId: "approval-req-2" });
		assert.equal((await store.readApprovalEvents(metadata.id)).length, 1);

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.messages.length, 2);
		assert.equal(opened.events.length, 2);

		const recent = await store.openSessionRecentTimeline(metadata.id, 1);
		assert.equal(recent.timelineBlocks.length, 1);
		assert.equal(recent.timelineBlocks[0]?.requestId, "req-2");
		assert.equal(typeof recent.timelineBlocks[0]?.renderHints?.estimatedHeight, "number");
		assert.deepEqual(recent.latestWorkflowSnapshot, { phases: [] });
		assert.equal(recent.hasMoreBefore, true);
		assert.equal(recent.hasMoreAfter, false);

		const firstPage = await store.openSessionTimelinePage(metadata.id, recent.blockOffset, 1);
		assert.equal(firstPage.timelineBlocks.length, 1);
		assert.equal(firstPage.timelineBlocks[0]?.requestId, "req-1");
		assert.equal(firstPage.hasMoreBefore, true);
		assert.equal(firstPage.hasMoreAfter, true);

		const afterPage = await store.openSessionTimelinePageAfter(metadata.id, recent.blockOffset, 1);
		assert.equal(afterPage.timelineBlocks.length, 1);
		assert.equal(afterPage.timelineBlocks[0]?.requestId, "req-2");

		await store.appendSessionEvent(metadata.id, "req-2", "ai.status", { title: "Updated", details: "cache invalidated" });
		const invalidatedPage = await store.openSessionTimelinePageAfter(metadata.id, recent.blockOffset, 1);
		const bodyParts = invalidatedPage.timelineBlocks[0]?.type === "assistant"
			? invalidatedPage.timelineBlocks[0].bodyParts
			: [];
		assert.equal(bodyParts.some((part) => part.type === "status" && part.title === "Updated"), true);
		await store.appendSessionEvent(metadata.id, "workflow-run-req-2", "agent.message.delta", {
			runId: "workflow-run-req-2",
			text: "stale assistant response"
		});
		const { getSessionDatabase } = await import("../../../src/session/session-database.js");
		const db = await getSessionDatabase();
		db.prepare(`
			UPDATE session_events SET created_at = ?
			WHERE session_id = ? AND channel = 'timeline'
		`).run("2026-07-03T00:00:02.000Z", metadata.id);

		const rewound = await store.rewindSessionFromRequest(metadata.id, "req-2");
		assert.equal(rewound.length, 1);
		assert.equal(rewound[0]?.requestId, "req-1");
		assert.equal((await store.openSession(metadata.id)).events.length, 1);
		assert.equal((await store.openSessionRecentTimeline(metadata.id, 10)).timelineBlocks.some((block) => block.requestId === "workflow-run-req-2"), false);
		assert.equal((await store.readApprovalEvents(metadata.id)).length, 0);

		const renamed = await store.renameSession(metadata.id, "Renamed");
		assert.equal(renamed.title, "Renamed");

		const archived = await store.archiveSession(metadata.id);
		assert.equal(archived.archivedAt !== undefined, true);
		assert.equal((await store.listSessions()).length, 0);
		assert.equal((await store.listArchivedSessions()).length, 1);
		await assert.rejects(fs.stat(path.join(appDataDir, ".daedalus", "archived_sessions")));

		const restored = await store.restoreArchivedSession(metadata.id);
		assert.equal(restored.archivedAt, undefined);
		assert.equal(await store.sessionExists(metadata.id), true);

		await store.deleteSession(metadata.id);
		assert.equal(await store.sessionExists(metadata.id), false);
	});
});

test("session store persists workspace metadata snapshot", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("Workspace session", undefined, undefined, {
			id: "workspace-a",
			name: "Project A",
			kind: "godot",
			rootPath: "D:/GodotProjects/project-a",
			icon: 0,
			color: 0,
			sourceFolders: [{
				id: "primary-a",
				path: "D:/GodotProjects/project-a",
				capabilities: { git: false, godot: true }
			}],
			primarySourceFolderId: "primary-a",
			godotExecutablePath: "D:/Godot/Godot.exe"
		});

		assert.equal(metadata.workspaceId, "workspace-a");
		assert.equal(metadata.workspaceName, "Project A");
		assert.equal(metadata.workspaceKind, "godot");
		assert.equal(metadata.workspaceRoot, "D:/GodotProjects/project-a");
		assert.equal(metadata.godotExecutablePath, "D:/Godot/Godot.exe");

		await store.saveSession(metadata.id, [], {
			workspaceId: undefined,
			activeSkillId: undefined
		});

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.metadata.workspaceId, "workspace-a");
		assert.equal(opened.metadata.workspaceRoot, "D:/GodotProjects/project-a");
		assert.equal(opened.metadata.godotExecutablePath, "D:/Godot/Godot.exe");
	});
});

test("session store persists frontend session metadata", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("Configured session", undefined, undefined, undefined, {
			provider: "moonshot",
			model: "kimi-k2.7-code",
			chatMode: "ask",
			approvalMode: "manual",
			workflowTodoCollapsed: true
		});

		assert.equal(metadata.provider, "moonshot");
		assert.equal(metadata.model, "kimi-k2.7-code");
		assert.equal(metadata.chatMode, "ask");
		assert.equal(metadata.approvalMode, "manual");
		assert.equal(metadata.workflowTodoCollapsed, true);

		await store.saveSession(metadata.id, [], {
			provider: "deepseek",
			model: "deepseek-v4-pro",
			chatMode: "plan",
			approvalMode: "auto-safe",
			workflowTodoCollapsed: false
		});

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.metadata.provider, "deepseek");
		assert.equal(opened.metadata.model, "deepseek-v4-pro");
		assert.equal(opened.metadata.chatMode, "plan");
		assert.equal(opened.metadata.approvalMode, "auto-safe");
		assert.equal(opened.metadata.workflowTodoCollapsed, false);
	});
});

test("session rewind uses event-only retry checkpoints to remove later messages", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("Event checkpoint session");
		await store.appendMessage(metadata.id, {
			role: "user",
			content: "keep before checkpoint",
			requestId: "req-before",
			createdAt: "2026-07-03T00:00:00.000Z"
		});
		await store.appendSessionEvent(metadata.id, "req-checkpoint", "agent.run.cancelled", {
			requestId: "req-checkpoint"
		});
		await store.appendMessage(metadata.id, {
			role: "user",
			content: "remove stale retry",
			requestId: "req-stale",
			createdAt: "9999-01-01T00:00:00.000Z"
		});
		await store.appendSessionEvent(metadata.id, "req-stale", "agent.message.delta", {
			requestId: "req-stale",
			text: "stale response"
		});

		const rewound = await store.rewindSessionFromRequest(metadata.id, "req-checkpoint");
		assert.deepEqual(rewound.map((message) => message.requestId), ["req-before"]);

		const opened = await store.openSession(metadata.id);
		assert.deepEqual(opened.messages.map((message) => message.requestId), ["req-before"]);
		assert.equal(opened.events.some((event) => event.requestId === "req-checkpoint" || event.requestId === "req-stale"), false);
	});
});

test("session metadata updates do not rewrite persisted messages", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("Metadata only session");
		await store.appendMessage(metadata.id, {
			role: "user",
			content: "keep me",
			requestId: "req-keep",
			createdAt: "2026-07-03T00:00:00.000Z"
		});
		const before = await store.openSession(metadata.id);
		assert.equal(before.messages.length, 1);

		const updated = await store.updateSessionMetadata(metadata.id, {
			workflowTodoCollapsed: true,
			model: "MiniMax-M3"
		});
		assert.equal(updated.workflowTodoCollapsed, true);

		const after = await store.openSession(metadata.id);
		assert.equal(after.metadata.workflowTodoCollapsed, true);
		assert.equal(after.metadata.model, "MiniMax-M3");
		assert.deepEqual(after.messages, before.messages);
	});
});

test("workspace metadata backfill does not overwrite an existing session workspace", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const originalWorkspace = {
			id: "workspace-a",
			name: "Project A",
			kind: "godot" as const,
			rootPath: "D:/ProjectA",
			icon: 0 as const,
			color: 0 as const,
			sourceFolders: [{ id: "primary-a", path: "D:/ProjectA", capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "primary-a"
		};
		const otherWorkspace = {
			id: "workspace-b",
			name: "Project B",
			kind: "godot" as const,
			rootPath: "D:/ProjectB",
			icon: 0 as const,
			color: 0 as const,
			sourceFolders: [{ id: "primary-b", path: "D:/ProjectB", capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "primary-b"
		};
		const metadata = await store.createSession("Workspace session", originalWorkspace.id, undefined, originalWorkspace);

		assert.deepEqual(store.createWorkspaceMetadataBackfill(metadata, otherWorkspace), {});
	});
});

test("workspace metadata backfill fills only sessions without workspace metadata", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const workspace = {
			id: "workspace-a",
			name: "Project A",
			kind: "godot" as const,
			rootPath: "D:/ProjectA",
			icon: 0 as const,
			color: 0 as const,
			sourceFolders: [{ id: "primary-a", path: "D:/ProjectA", capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "primary-a"
		};
		const metadata = await store.createSession("No workspace session");

		assert.deepEqual(store.createWorkspaceMetadataBackfill(metadata, workspace), {
			workspaceId: "workspace-a",
			workspaceName: "Project A",
			workspaceKind: "godot",
			workspaceRoot: "D:/ProjectA"
		});
	});
});

test("session integrity check reports cross-session event records", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("Integrity session");
		await store.appendSessionEvent(metadata.id, "request-good", "agent.message.delta", {
			sessionId: metadata.id,
			text: "good"
		});
		await store.appendSessionEvent(metadata.id, "request-bad", "agent.message.delta", {
			sessionId: "session-20260720-other",
			text: "wrong session"
		});

		const result = await store.checkSessionIntegrity(metadata.id);

		assert.equal(result.ok, false);
		assert.equal(result.issues.length, 1);
		assert.equal(result.issues[0]?.file, "events");
		assert.equal(result.issues[0]?.expectedSessionId, metadata.id);
		assert.equal(result.issues[0]?.actualSessionId, "session-20260720-other");
		assert.equal(result.issues[0]?.requestId, "request-bad");
	});
});

test("session store deletes active and archived sessions by workspace", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const active = await store.createSession("Active workspace session", "workspace-a");
		const archived = await store.createSession("Archived workspace session", "workspace-a");
		const other = await store.createSession("Other workspace session", "workspace-b");
		await store.archiveSession(archived.id);

		const result = await store.deleteSessionsByWorkspace("workspace-a");

		assert.deepEqual(result.deletedSessionIds, [active.id]);
		assert.deepEqual(result.deletedArchivedSessionIds, [archived.id]);
		assert.deepEqual((await store.listSessions()).map((metadata) => metadata.id), [other.id]);
		assert.deepEqual(await store.listArchivedSessions(), []);
	});
});

test("workspace deletion reassigns every session kind to the most specific remaining project", async (): Promise<void> => {
	await withTempAppData(async (store, appDataDir): Promise<void> => {
		const broadRoot: string = path.join(appDataDir, "projects");
		const specificRoot: string = path.join(broadRoot, "game");
		const oldRoot: string = path.join(specificRoot, "scenes");
		const orphanRoot: string = path.join(appDataDir, "orphan");
		const deletedWorkspace = {
			id: "workspace-deleted",
			name: "Deleted",
			kind: "godot" as const,
			rootPath: oldRoot,
			icon: 0 as const,
			color: 0 as const,
			sourceFolders: [{ id: "deleted-primary", path: oldRoot, capabilities: { git: false, godot: true } }],
			primarySourceFolderId: "deleted-primary"
		};
		const orphanWorkspace = {
			...deletedWorkspace,
			rootPath: orphanRoot,
			sourceFolders: [{ id: "orphan-primary", path: orphanRoot, capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "orphan-primary"
		};
		const broadWorkspace = {
			id: "workspace-broad",
			name: "All projects",
			kind: "godot" as const,
			rootPath: broadRoot,
			icon: 0 as const,
			color: 0 as const,
			sourceFolders: [{ id: "broad", path: broadRoot, capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "broad"
		};
		const specificWorkspace = {
			id: "workspace-specific",
			name: "Game",
			kind: "godot" as const,
			rootPath: specificRoot,
			icon: 5 as const,
			color: 4 as const,
			sourceFolders: [{ id: "specific", path: specificRoot, capabilities: { git: true, godot: true } }],
			primarySourceFolderId: "specific"
		};

		const active = await store.createSession("Active", deletedWorkspace.id, undefined, deletedWorkspace);
		const archived = await store.createSession("Archived", deletedWorkspace.id, undefined, deletedWorkspace);
		const temporary = await store.createSession("Temporary", deletedWorkspace.id, undefined, deletedWorkspace, { temporary: true });
		const orphan = await store.createSession("Orphan", deletedWorkspace.id, undefined, orphanWorkspace);
		await store.archiveSession(archived.id);

		const result = await store.reassignOrDeleteSessionsForWorkspace(deletedWorkspace.id, [
			broadWorkspace,
			specificWorkspace
		]);

		assert.deepEqual(
			result.movedSessions
				.map((move) => ({ sessionId: move.sessionId, workspaceId: move.workspaceId, archived: move.archived }))
				.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
			[
				{ sessionId: active.id, workspaceId: specificWorkspace.id, archived: false },
				{ sessionId: archived.id, workspaceId: specificWorkspace.id, archived: true },
				{ sessionId: temporary.id, workspaceId: specificWorkspace.id, archived: false }
			].sort((left, right) => left.sessionId.localeCompare(right.sessionId))
		);
		assert.deepEqual(result.deletedSessionIds, [orphan.id]);
		assert.deepEqual(result.deletedArchivedSessionIds, []);
		assert.equal((await store.openSession(active.id)).metadata.workspaceName, "Game");
		assert.equal((await store.listArchivedSessions()).find((session) => session.id === archived.id)?.workspaceId, specificWorkspace.id);
		assert.equal((await store.listTemporarySessions())[0]?.workspaceId, specificWorkspace.id);
		await assert.rejects(() => store.openSession(orphan.id), /Session not found/);
	});
});

test("session store rejects unsafe session ids", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		await assert.rejects(() => store.openSession("../session-escape"), /Invalid session id/);
		await assert.rejects(() => store.deleteSession("session-../escape"), /Invalid session id/);
		await assert.rejects(() => store.restoreArchivedSession("session-..\\escape"), /Invalid session id/);
	});
});

test("temporary sessions stay hidden until they are promoted", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const temporary = await store.createSession("Draft", undefined, undefined, undefined, { temporary: true });
		assert.equal((await store.listSessions()).some((session) => session.id === temporary.id), false);
		assert.deepEqual((await store.listTemporarySessions()).map((session) => session.id), [temporary.id]);

		const promoted = await store.promoteTemporarySession(temporary.id);
		assert.equal(promoted.temporary, undefined);
		assert.equal((await store.listSessions()).some((session) => session.id === temporary.id), true);
		assert.equal((await store.listTemporarySessions()).length, 0);
	});
});

test("recent timeline pagination only decodes payloads for the selected SQL page", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("Paged payload session");
		await store.appendMessage(metadata.id, {
			role: "user",
			content: "old message",
			requestId: "request-old",
			createdAt: "2026-07-03T00:00:00.000Z"
		});
		await store.appendMessage(metadata.id, {
			role: "assistant",
			content: "recent message",
			requestId: "request-recent",
			createdAt: "2026-07-03T00:00:01.000Z"
		});
		const { getSessionDatabase } = await import("../../../src/session/session-database.js");
		const db = await getSessionDatabase();
		db.prepare(`
			UPDATE messages SET payload_json = '{invalid-json'
			WHERE session_id = ? AND request_id = 'request-old'
		`).run(metadata.id);

		const recent = await store.openSessionRecentTimeline(metadata.id, 1);
		assert.equal(recent.blockCount, 2);
		assert.equal(recent.timelineBlocks.length, 1);
		assert.equal(recent.timelineBlocks[0]?.requestId, "request-recent");
		assert.deepEqual(recent.messages.map((message) => message.requestId), ["request-recent"]);
		await assert.rejects(store.openSession(metadata.id), /JSON/u);
	});
});
