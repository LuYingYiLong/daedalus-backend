import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { AdditionalContextItem, ClientRequest } from "../../../src/protocol/types.js";
import type { StoredSessionEvent } from "../../../src/session/session-store.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { handleMessageQueueRequest } from "../../../src/server/handlers/message-queue-handlers.js";
import {
	createQueuedChatRequest,
	enqueueMessage,
	hydrateMessageQueue,
	reorderQueuedMessages,
	serializeMessageQueue
} from "../../../src/server/message-queue.js";
import { createPendingGuide, hydratePendingGuides, reorderPendingGuides } from "../../../src/server/pending-guides.js";
import { handleWorkbenchRequest } from "../../../src/server/handlers/workbench-handlers.js";
import { applyWorkbenchPatch, serializeWorkbench } from "../../../src/server/workbench.js";

function makeContext(id: string, resourcePath: string, pinned: boolean = false): AdditionalContextItem {
	return {
		id,
		kind: "file",
		title: resourcePath,
		source: "manual",
		resourcePath,
		pinned
	};
}

function makeSocket(messages: unknown[]): WebSocket {
	return {
		readyState: WebSocket.OPEN,
		send(payload: string): void {
			messages.push(JSON.parse(payload) as unknown);
		}
	} as WebSocket;
}

test("workbench patch updates composer and increments revision", (): void => {
	const session = createClientSession(undefined);
	const changed = applyWorkbenchPatch(session, {
		composer: {
			text: "hello",
			chatMode: "ask",
			provider: "openai",
			model: "gpt-test",
			additionalContext: [makeContext("ctx-a", "res://a.gd")]
		}
	});

	assert.equal(changed, true);
	assert.equal(session.workbenchRevision, 1);
	const workbench = serializeWorkbench(session);
	assert.equal((workbench.composer as Record<string, unknown>).text, "hello");
	assert.equal((workbench.composer as Record<string, unknown>).chatMode, "ask");
	assert.equal((workbench.composer as Record<string, unknown>).provider, "openai");
	assert.equal((workbench.composer as Record<string, unknown>).model, "gpt-test");
	assert.equal(session.activeProvider, "openai");
	assert.equal(session.providerModel, "gpt-test");
	assert.equal(session.modelProfile.provider, "openai");
	assert.equal(session.modelProfile.model, "gpt-test");
});

test("workbench additional context actions dedupe, pin and clear unpinned", (): void => {
	const session = createClientSession(undefined);
	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "set",
			items: [
				makeContext("ctx-a", "res://a.gd"),
				makeContext("ctx-b", "res://b.gd")
			]
		}
	});
	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "addOrReplace",
			item: makeContext("ctx-a-new", "res://a.gd")
		}
	});
	assert.equal(session.workbenchComposer.additionalContext.length, 2);
	assert.equal(session.workbenchComposer.additionalContext[0]?.id, "ctx-a");

	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "pin",
			contextId: "ctx-b",
			pinned: true
		}
	});
	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "clearUnpinned"
		}
	});

	assert.deepEqual(
		session.workbenchComposer.additionalContext.map((context: AdditionalContextItem): string => context.id),
		["ctx-b"]
	);
	assert.equal(session.workbenchComposer.additionalContext[0]?.pinned, true);
});

test("git review comments remain pinned and keep independent line identities", (): void => {
	const session = createClientSession(undefined);
	const commentA: AdditionalContextItem = {
		id: "review-a",
		kind: "git_diff_comment",
		title: "scripts/player.gd",
		source: "manual",
		resourcePath: "scripts/player.gd",
		pinned: false,
		data: { newLine: 12, comment: "Rename this variable." }
	};
	const commentB: AdditionalContextItem = {
		...commentA,
		id: "review-b",
		data: { newLine: 20, comment: "Handle the missing input." }
	};

	applyWorkbenchPatch(session, { additionalContextAction: { action: "set", items: [commentA, commentB] } });
	applyWorkbenchPatch(session, { additionalContextAction: { action: "pin", contextId: "review-a", pinned: false } });
	applyWorkbenchPatch(session, { additionalContextAction: { action: "clearUnpinned" } });

	assert.deepEqual(session.workbenchComposer.additionalContext.map((context: AdditionalContextItem): string => context.id), ["review-a", "review-b"]);
	assert.equal(session.workbenchComposer.additionalContext.every((context: AdditionalContextItem): boolean => context.pinned === true), true);
});

test("message selections dedupe by anchor and can never be pinned", (): void => {
	const session = createClientSession(undefined);
	const selection: AdditionalContextItem = {
		id: "selection-a",
		kind: "message_selection",
		title: "Selected text",
		source: "manual",
		pinned: true,
		data: {
			anchor: {
				entryId: "user-1",
				requestId: "request-1",
				role: "user",
				segmentKey: "user:content",
				startOffset: 2,
				endOffset: 6,
				quote: "text",
				contextBefore: "a ",
				contextAfter: " after"
			},
			selectedText: "text",
			annotation: "first"
		}
	};
	applyWorkbenchPatch(session, { additionalContextAction: { action: "addOrReplace", item: selection } });
	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "addOrReplace",
			item: { ...selection, id: "selection-b", data: { ...(selection.data as Record<string, unknown>), annotation: "updated" } }
		}
	});
	applyWorkbenchPatch(session, { additionalContextAction: { action: "pin", contextId: "selection-a", pinned: true } });

	assert.equal(session.workbenchComposer.additionalContext.length, 1);
	assert.equal(session.workbenchComposer.additionalContext[0]?.id, "selection-a");
	assert.equal(session.workbenchComposer.additionalContext[0]?.pinned, undefined);
	assert.equal((session.workbenchComposer.additionalContext[0]?.data as { annotation?: string }).annotation, "updated");
});

test("workbench snapshot derives active run and pending approval shape", (): void => {
	const session = createClientSession(undefined);
	session.activeRunRequestId = "run-1";

	const workbench = serializeWorkbench(session);
	assert.deepEqual(workbench.activeRun, {
		status: "streaming",
		requestId: "run-1",
		sequence: 0
	});
	assert.deepEqual(workbench.pendingApproval, {
		count: 0,
		first: null
	});
});

test("workbench active run sequence is monotonic across state changes", (): void => {
	const session = createClientSession(undefined);

	const firstRun = applyWorkbenchPatch(session, {
		activeRun: {
			status: "streaming",
			requestId: "run-1"
		}
	});
	assert.equal(firstRun, true);
	assert.equal(session.workbenchActiveRun.sequence, 1);

	const idleRun = applyWorkbenchPatch(session, {
		activeRun: {
			status: "idle"
		}
	});
	assert.equal(idleRun, true);
	assert.deepEqual(session.workbenchActiveRun, {
		status: "idle",
		sequence: 2
	});

	const workbench = serializeWorkbench(session);
	assert.deepEqual(workbench.activeRun, {
		status: "idle",
		sequence: 2
	});
});

test("workbench snapshot drops stale non-idle active run state", (): void => {
	const session = createClientSession(undefined);
	applyWorkbenchPatch(session, {
		activeRun: {
			status: "streaming",
			requestId: "stale-request"
		}
	});

	const workbench = serializeWorkbench(session);
	assert.deepEqual(workbench.activeRun, {
		status: "idle",
		sequence: 1
	});
});

test("workbench patch ignores stale client sequence without changing revision", (): void => {
	const session = createClientSession(undefined);
	const messages: unknown[] = [];
	const socket: WebSocket = makeSocket(messages);

	handleWorkbenchRequest(socket, {
		id: "patch-2",
		method: "session.workbench.patch",
		params: {
			clientSequence: 2,
			composer: { text: "new" }
		}
	} as ClientRequest, session, {} as never);

	handleWorkbenchRequest(socket, {
		id: "patch-1",
		method: "session.workbench.patch",
		params: {
			clientSequence: 1,
			composer: { text: "old" }
		}
	} as ClientRequest, session, {} as never);

	assert.equal(session.workbenchComposer.text, "new");
	assert.equal(session.workbenchRevision, 1);
	const responses = messages.filter((message: unknown): boolean => (message as Record<string, unknown>).type === "response");
	const events = messages.filter((message: unknown): boolean => (message as Record<string, unknown>).type === "event");
	assert.equal(responses.length, 2);
	assert.equal(events.length, 1);
	assert.equal(((responses[1] as Record<string, unknown>).result as Record<string, unknown>).changed, false);
	assert.equal(((responses[1] as Record<string, unknown>).result as Record<string, unknown>).stale, true);
});

test("message queue no-op remove does not bump workbench revision", async (): Promise<void> => {
	const session = createClientSession(undefined);
	const messages: unknown[] = [];
	const socket: WebSocket = makeSocket(messages);

	await handleMessageQueueRequest(socket, {
		id: "remove-missing",
		method: "message.queue.remove",
		params: { queueId: 404 }
	} as ClientRequest, session, {} as never);

	assert.equal(session.workbenchRevision, 0);
	assert.equal(messages.length, 1);
	const response = messages[0] as Record<string, unknown>;
	assert.equal(response.type, "response");
	const result = response.result as Record<string, unknown>;
	assert.equal(result.queueRemoved, false);
	assert.equal(result.removed, false);
});

test("message queue stores text context and reorders pending messages", (): void => {
	const session = createClientSession(undefined);
	const first = enqueueMessage(session, {
		text: "先解释这个 hook",
		skillRefs: ["skill-a"],
		additionalContext: [makeContext("ctx-a", "src/hooks/useDiskSpaceCheck.ts")]
	});
	const second = enqueueMessage(session, {
		text: "再修复按钮状态",
		additionalContext: [makeContext("ctx-b", "src/app/App.tsx", true)]
	});

	assert.equal(first.id, 1);
	assert.equal(second.id, 2);
	const serialized = serializeMessageQueue(session);
	assert.equal((serialized[0] as Record<string, unknown>).provider, null);
	assert.equal((serialized[0] as Record<string, unknown>).model, null);
	assert.deepEqual((serialized[0] as Record<string, unknown>).skillRefs, ["skill-a"]);

	const result = reorderQueuedMessages(session, [2, 1]);
	assert.equal(result.changed, true);
	assert.deepEqual(session.queuedMessages.map((message): number => message.id), [2, 1]);

	const invalid = reorderQueuedMessages(session, [1]);
	assert.equal(invalid.changed, false);
	assert.equal(invalid.errorCode, "invalid_queue_order");
});

test("message queue preserves context-only messages across hydration", (): void => {
	const context: AdditionalContextItem = makeContext("ctx-only", "res://scripts/player.gd");
	const hydrated = hydrateMessageQueue([{
		id: "event-context-only",
		requestId: "request-context-only",
		event: "message.queue.added",
		createdAt: "2026-08-01T00:00:00.000Z",
		data: {
			item: {
				id: 1,
				text: "",
				additionalContext: [context],
				status: "pending",
				createdAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-01T00:00:00.000Z"
			}
		}
	}]);

	assert.equal(hydrated.messages.length, 1);
	assert.equal(hydrated.messages[0]?.text, "");
	assert.deepEqual(hydrated.messages[0]?.additionalContext, [context]);
});

test("queued chat request follows the current session model and mode", (): void => {
	const session = createClientSession(undefined);
	const item = enqueueMessage(session, {
		text: "排队执行",
		mode: "agent",
		provider: "deepseek",
		model: "deepseek-chat",
		executionPolicy: "read_only",
		additionalContext: [makeContext("ctx-a", "res://scripts/a.gd")]
	});

	const request = createQueuedChatRequest(item, "queued-run-1");
	assert.equal(request.method, "ai.chat");
	const params = request.params as Record<string, unknown>;
	assert.equal(params.message, "排队执行");
	assert.equal(params.mode, undefined);
	assert.equal(params.provider, undefined);
	assert.equal(params.model, undefined);
	assert.deepEqual(params.options, {
		stream: true,
		queueItemId: 1,
		executionPolicy: "read_only"
	});
});

test("message queue hydrates persisted events without replaying interrupted runs", (): void => {
	const events: StoredSessionEvent[] = [
		{
			id: "event-1",
			requestId: "request-1",
			event: "message.queue.added",
			createdAt: "2026-07-20T00:00:00.000Z",
			data: {
				item: {
					id: 1,
					text: "pending item",
					mode: "ask",
					provider: "openai",
					model: "gpt-test",
					status: "pending",
					createdAt: "2026-07-20T00:00:00.000Z",
					updatedAt: "2026-07-20T00:00:00.000Z"
				}
			}
		},
		{
			id: "event-2",
			requestId: "request-1",
			event: "message.queue.added",
			createdAt: "2026-07-20T00:01:00.000Z",
			data: {
				item: {
					id: 2,
					text: "sending item",
					status: "sending",
					createdAt: "2026-07-20T00:01:00.000Z",
					updatedAt: "2026-07-20T00:01:00.000Z"
				}
			}
		},
		{
			id: "event-3",
			requestId: "request-1",
			event: "message.queue.added",
			createdAt: "2026-07-20T00:02:00.000Z",
			data: {
				item: {
					id: 3,
					text: "approval item",
					status: "approval",
					createdAt: "2026-07-20T00:02:00.000Z",
					updatedAt: "2026-07-20T00:02:00.000Z"
				}
			}
		},
		{
			id: "event-4",
			requestId: "request-1",
			event: "message.queue.status",
			createdAt: "2026-07-20T00:03:00.000Z",
			data: {
				queueId: 1,
				status: "approval"
			}
		},
		{
			id: "event-5",
			requestId: "request-1",
			event: "message.queue.reordered",
			createdAt: "2026-07-20T00:04:00.000Z",
			data: {
				queueIds: [3, 2, 1]
			}
		},
		{
			id: "event-6",
			requestId: "request-1",
			event: "message.queue.removed",
			createdAt: "2026-07-20T00:05:00.000Z",
			data: {
				queueId: 2
			}
		}
	];

	const hydrated = hydrateMessageQueue(events);

	assert.equal(hydrated.nextId, 3);
	assert.deepEqual(hydrated.messages.map((message): number => message.id), [3, 1]);
	assert.deepEqual(hydrated.messages.map((message): string => message.status), ["failed", "failed"]);
});

test("pending guides reorder and hydrate persisted order", (): void => {
	const session = createClientSession(undefined);
	const first = createPendingGuide("client-1", "优先读错误日志", undefined);
	const second = createPendingGuide("client-2", "然后检查按钮状态", "run-1");
	session.pendingGuides = [first, second];

	const reorderResult = reorderPendingGuides(session, [second.id, first.id]);
	assert.equal(reorderResult.changed, true);
	assert.deepEqual(session.pendingGuides.map((guide): string => guide.id), [second.id, first.id]);
	assert.equal(session.pendingGuides[0]?.anchorRequestId, "run-1");

	const invalid = reorderPendingGuides(session, [first.id]);
	assert.equal(invalid.changed, false);
	assert.equal(invalid.errorCode, "invalid_guide_order");

	const events: StoredSessionEvent[] = [
		{
			id: "event-1",
			requestId: "request-1",
			event: "guide.added",
			createdAt: "2026-07-20T00:00:00.000Z",
			data: {
				guideId: "guide-1",
				clientGuideId: "client-1",
				text: "第一条"
			}
		},
		{
			id: "event-2",
			requestId: "request-1",
			event: "guide.added",
			createdAt: "2026-07-20T00:01:00.000Z",
			data: {
				guideId: "guide-2",
				clientGuideId: "client-2",
				text: "第二条"
			}
		},
		{
			id: "event-3",
			requestId: "request-1",
			event: "guide.reordered",
			createdAt: "2026-07-20T00:02:00.000Z",
			data: {
				guideIds: ["guide-2", "guide-1"]
			}
		}
	];
	const guides = hydratePendingGuides(events);

	assert.deepEqual(guides.map((guide): string => guide.id), ["guide-2", "guide-1"]);
	assert.deepEqual(guides.map((guide): string => guide.text), ["第二条", "第一条"]);
});
