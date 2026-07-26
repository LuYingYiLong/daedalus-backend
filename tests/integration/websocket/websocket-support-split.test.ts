import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import type { AdditionalContextItem, ClientRequest } from "../../../src/protocol/types.js";
import type { StoredSessionEvent } from "../../../src/session/session-store.js";
import { createClientSession } from "../../../src/server/client-session.js";
import type { ClientSession } from "../../../src/server/client-session.js";
import { createAdditionalContextPromptSection } from "../../../src/server/additional-context.js";
import { normalizeNextStepHints, parseJsonObjectLoose } from "../../../src/server/next-step-hints.js";
import { beginRequestExecution, finishRequestExecution } from "../../../src/server/request-lifecycle.js";
import { hydratePendingGuides } from "../../../src/server/pending-guides.js";

function createSocketMock(): WebSocket & { sent: unknown[] } {
	const sent: unknown[] = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(message: string): void {
			sent.push(JSON.parse(message) as unknown);
		}
	} as unknown as WebSocket & { sent: unknown[] };
}

function createSession(): ClientSession {
	return createClientSession(undefined);
}

test("request lifecycle deduplicates in-flight and completed requests", (): void => {
	const socket = createSocketMock();
	const session: ClientSession = createSession();
	const request: ClientRequest = {
		id: "request-1",
		method: "command.list",
		params: {}
	} as ClientRequest;

	assert.equal(beginRequestExecution(socket, request, session), true);
	assert.equal(beginRequestExecution(socket, request, session), false);
	assert.deepEqual(socket.sent.at(-1), {
		protocolVersion: 2,
		type: "response",
		id: "request-1",
		ok: true,
		result: {
			duplicate: true,
			ignored: true,
			state: "in_flight",
			method: "command.list"
		}
	});

	finishRequestExecution(request, session);
	assert.equal(beginRequestExecution(socket, request, session), false);
	assert.equal((socket.sent.at(-1) as { result: { state: string } }).result.state, "completed");
});

test("additional context formats script selections without mutating source items", (): void => {
	const item: AdditionalContextItem = {
		id: "context-1",
		kind: "script_selection",
		source: "editor",
		title: "player.gd",
		resourcePath: "res://scripts/player.gd",
		data: {
			hasSelection: true,
			lineStart: 2,
			columnStart: 1,
			lineEnd: 3,
			columnEnd: 5,
			selectedTextPreview: "func _ready():\n\tpass"
		}
	};

	const section: string = createAdditionalContextPromptSection([item]);

	assert.match(section, /## 用户附加上下文/);
	assert.match(section, /range: 2:1-3:5/);
	assert.match(section, /func _ready/);
	assert.equal((item.data as Record<string, unknown>).hasSelection, true);
});

test("additional context exposes image ids for image generation tools", (): void => {
	const section: string = createAdditionalContextPromptSection([{
		id: "image-context-1",
		kind: "image",
		source: "manual",
		title: "Reference image",
		data: {
			mimeType: "image/png",
			attachmentId: "image-attachment-1",
			byteSize: 5
		}
	}]);

	assert.match(section, /imageContextId: image-context-1/);
	assert.match(section, /attachmentId: image-attachment-1/);
	assert.doesNotMatch(section, /aGVsbG8=/);
});

test("additional context formats local git review comments with file and line targets", (): void => {
	const section: string = createAdditionalContextPromptSection([{
		id: "review-comment-1",
		kind: "git_diff_comment",
		source: "manual",
		title: "scripts/player.gd",
		resourcePath: "scripts/player.gd",
		pinned: true,
		data: {
			workspaceId: "workspace-a",
			newLine: 42,
			changeType: "insert",
			lineText: "velocity = speed",
			comment: "Use the configured movement speed here."
		}
	}]);

	assert.match(section, /resourcePath: scripts\/player\.gd/);
	assert.match(section, /new line 42/);
	assert.match(section, /Use the configured movement speed here/);
	assert.match(section, /local code-review request/);
});

test("additional context preserves external absolute file references", (): void => {
	const section: string = createAdditionalContextPromptSection([{
		id: "external-file-1",
		kind: "file",
		source: "manual",
		title: "notes.pdf",
		subtitle: "D:/Documents/notes.pdf",
		resourcePath: "D:/Documents/notes.pdf",
		data: {
			external: true,
			absolutePath: "D:/Documents/notes.pdf",
			mimeType: "application/pdf"
		}
	}]);

	assert.match(section, /externalAbsolutePath: D:\/Documents\/notes\.pdf/u);
	assert.match(section, /工作区外本机文件/u);
});

test("pending guides hydrate added, updated, applied and deleted events", (): void => {
	const events: StoredSessionEvent[] = [
		{
			id: "event-1",
			requestId: "request-1",
			event: "guide.added",
			createdAt: "2026-07-07T00:00:00.000Z",
			data: {
				guideId: "guide-1",
				clientGuideId: "client-1",
				text: "先验证场景",
				createdAt: "2026-07-07T00:00:00.000Z",
				updatedAt: "2026-07-07T00:00:00.000Z"
			}
		},
		{
			id: "event-2",
			requestId: "request-1",
			event: "guide.updated",
			createdAt: "2026-07-07T00:01:00.000Z",
			data: {
				guideId: "guide-1",
				text: "先验证场景和诊断"
			}
		},
		{
			id: "event-3",
			requestId: "request-1",
			event: "guide.added",
			createdAt: "2026-07-07T00:02:00.000Z",
			data: {
				guideId: "guide-2",
				clientGuideId: "client-2",
				text: "保留这个引导"
			}
		},
		{
			id: "event-4",
			requestId: "request-1",
			event: "guide.applied",
			createdAt: "2026-07-07T00:03:00.000Z",
			data: {
				guideId: "guide-1"
			}
		}
	];

	const guides = hydratePendingGuides(events);

	assert.equal(guides.length, 1);
	assert.equal(guides[0]?.id, "guide-2");
	assert.equal(guides[0]?.text, "保留这个引导");
});

test("next step hints normalize loose model output", (): void => {
	assert.deepEqual(normalizeNextStepHints({
		hints: [
			{ title: "验证", message: "运行诊断并修复错误" },
			{ title: "", message: "总结刚才的改动" },
			{ title: "空", message: "" }
		]
	}, 2), [
		{ title: "验证", message: "运行诊断并修复错误" },
		{ title: "总结刚才的改动", message: "总结刚才的改动" }
	]);
});

test("next step hint JSON parser returns stable errors for malformed arrays", (): void => {
	assert.throws(
		(): unknown => parseJsonObjectLoose("{\"hints\":[{\"title\":\"验证\"} {\"title\":\"总结\"}]}"),
		/LLM did not return valid JSON/u
	);
});
