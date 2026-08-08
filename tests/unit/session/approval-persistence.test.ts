import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
	createPersistedApprovalRequestedData,
	createRuntimePendingContinuation,
	collectApprovedDownloadAuthorizations,
	foldPendingApprovalStates,
	mergeHydratedPendingApprovalStates
} from "../../../src/session/approval-persistence.js";
import type { StoredApprovalEvent } from "../../../src/session/session-store.js";
import type { PendingAiContinuation } from "../../../src/server/client-session.js";
import { createClientSession } from "../../../src/server/client-session.js";
import type { PendingApproval } from "../../../src/tools/approval-gateway.js";

function createPendingApproval(): PendingApproval {
	return {
		approvalId: "approval-test",
		toolCallId: "call-test",
		toolName: "mcp_godot_create_text_file",
		llmToolName: "mcp_godot_create_text_file",
		args: {
			relativePath: "test_approval.md",
			content: "# Approval"
		},
		reason: "写操作需要用户在 Godot 客户端确认",
		createdAt: Date.parse("2026-07-03T00:00:00.000Z"),
		executionFingerprint: "godot:create:fingerprint"
	};
}

function createPendingContinuation(): PendingAiContinuation {
	const assistantMessage = {
		role: "assistant",
		content: null,
		tool_calls: [
			{
				id: "call-test",
				type: "function",
				function: {
					name: "mcp_godot_create_text_file",
					arguments: "{\"relativePath\":\"test_approval.md\",\"content\":\"# Approval\"}"
				}
			}
		],
		reasoning_content: "保留 thinking mode 所需 reasoning_content"
	} as unknown as ChatCompletionMessageParam;

	return {
		params: {
			message: "创建一个审批测试文件",
			options: {
				stream: true,
				workflow: "single"
			}
		},
		options: {
			provider: "deepseek",
			apiKey: "secret-api-key",
			model: "deepseek-v4-flash",
			baseUrl: "https://api.deepseek.com"
		},
		continuation: {
			messages: [assistantMessage],
			nextStep: 1,
			totalToolResultChars: 0
		},
		allowedToolNames: ["mcp_godot_create_text_file"],
		userMessage: "创建一个审批测试文件",
		requestId: "request-test",
		userCreatedAt: "2026-07-03T00:00:00.000Z",
		stream: true,
		lightweightActionState: {
			observations: [{
				toolCallId: "call-test",
				toolName: "mcp_godot_create_text_file",
				risk: "write",
				status: "approval_required",
				argsSummary: { relativePath: "test_approval.md" },
				artifactRefs: []
			}]
		},
		executionControl: { lane: "probe", allowMutationEscalation: true, requireDecision: true },
		chatCompletion: { requireSubmission: true }
	};
}

function createApprovalEvent(event: string, data: unknown, createdAt: string): StoredApprovalEvent {
	return {
		id: `approval-event-${event}-${createdAt}`,
		schemaVersion: 1,
		approvalId: "approval-test",
		requestId: "request-test",
		event,
		data,
		createdAt
	};
}

test("approval persistence folds pending, interrupted, and executed states", (): void => {
	const pendingApproval: PendingApproval = createPendingApproval();
	const pendingContinuation: PendingAiContinuation = createPendingContinuation();
	const requestedData = createPersistedApprovalRequestedData(pendingApproval, pendingContinuation, "workspace-a");
	const serializedData: string = JSON.stringify(requestedData);

	assert.equal(serializedData.includes("secret-api-key"), false);
	assert.equal(serializedData.includes("reasoning_content"), true);

	const pendingStates = foldPendingApprovalStates([
		createApprovalEvent("requested", requestedData, "2026-07-03T00:00:00.000Z")
	]);
	assert.equal(pendingStates.length, 1);
	assert.equal(pendingStates[0]?.status, "pending");
	assert.equal(pendingStates[0]?.restored, true);

	const interruptedStates = foldPendingApprovalStates([
		createApprovalEvent("requested", requestedData, "2026-07-03T00:00:00.000Z"),
		createApprovalEvent("executing", { startedAt: "2026-07-03T00:00:02.000Z" }, "2026-07-03T00:00:02.000Z")
	]);
	assert.equal(interruptedStates.length, 1);
	assert.equal(interruptedStates[0]?.status, "interrupted");
	assert.equal(interruptedStates[0]?.interrupted, true);

	const approvedThenFailedStates = foldPendingApprovalStates([
		createApprovalEvent("requested", requestedData, "2026-07-03T00:00:00.000Z"),
		createApprovalEvent("approved", { approvedAt: "2026-07-03T00:00:01.000Z" }, "2026-07-03T00:00:01.000Z"),
		createApprovalEvent("executing", { startedAt: "2026-07-03T00:00:02.000Z" }, "2026-07-03T00:00:02.000Z"),
		createApprovalEvent("failed", { message: "MCP request timed out" }, "2026-07-03T00:00:03.000Z")
	]);
	assert.equal(approvedThenFailedStates.length, 0);

	const executedStates = foldPendingApprovalStates([
		createApprovalEvent("requested", requestedData, "2026-07-03T00:00:00.000Z"),
		createApprovalEvent("executing", { startedAt: "2026-07-03T00:00:02.000Z" }, "2026-07-03T00:00:02.000Z"),
		createApprovalEvent("executed", { resultChars: 12 }, "2026-07-03T00:00:03.000Z")
	]);
	assert.equal(executedStates.length, 0);

	assert.ok(requestedData.continuation !== undefined);
	const runtimeContinuation = createRuntimePendingContinuation(requestedData.continuation, "new-api-key");
	assert.equal(runtimeContinuation.options.apiKey, "new-api-key");
	assert.equal(runtimeContinuation.options.provider, "deepseek");
	assert.equal(runtimeContinuation.options.model, "deepseek-v4-flash");
	assert.equal(runtimeContinuation.lightweightActionState?.observations[0]?.toolCallId, "call-test");
	assert.deepEqual(runtimeContinuation.executionControl, { lane: "probe", allowMutationEscalation: true, requireDecision: true });
	assert.deepEqual(runtimeContinuation.chatCompletion, { requireSubmission: true });
});

test("hydrated approval states keep in-memory approvals created during continuation races", (): void => {
	const hydratedApproval: PendingApproval = createPendingApproval();
	const memoryApproval: PendingApproval = {
		...createPendingApproval(),
		approvalId: "approval-memory-race",
		toolCallId: "call-memory-race",
		createdAt: Date.parse("2026-07-03T00:00:01.000Z")
	};
	const hydratedStates = foldPendingApprovalStates([
		createApprovalEvent(
			"requested",
			createPersistedApprovalRequestedData(hydratedApproval, createPendingContinuation(), "workspace-a"),
			"2026-07-03T00:00:00.000Z"
		)
	]);
	const mergedStates = mergeHydratedPendingApprovalStates(hydratedStates, [{
		approval: memoryApproval,
		status: "pending",
		restored: false,
		interrupted: false,
		requestId: "request-memory-race",
		createdAt: "2026-07-03T00:00:01.000Z",
		updatedAt: "2026-07-03T00:00:01.000Z"
	}]);

	assert.deepEqual(
		mergedStates.map((state) => state.approval.approvalId).sort(),
		["approval-memory-race", "approval-test"]
	);
});

test("approved download authorization scopes survive persistence while pending cards do not", (): void => {
	const scope = {
		kind: "network_download" as const,
		requestId: "request-test",
		workspaceId: "workspace-a",
		fingerprints: ["a".repeat(64)],
		downloads: [{
			url: "https://downloads.example.test/tool.bin",
			sourceFolderId: "tools",
			relativePath: "bin/tool.bin",
			dependency: "tool",
			purpose: "Run this request's verifier.",
			criticality: "required" as const,
			overwrite: false
		}]
	};
	const scopes = collectApprovedDownloadAuthorizations([
		createApprovalEvent("requested", createPersistedApprovalRequestedData(createPendingApproval(), undefined, "workspace-a"), "2026-07-03T00:00:00.000Z"),
		createApprovalEvent("approved", { approvedAt: "2026-07-03T00:00:01.000Z", downloadAuthorization: scope }, "2026-07-03T00:00:01.000Z"),
		createApprovalEvent("approved", { approvedAt: "2026-07-03T00:00:02.000Z", downloadAuthorization: { kind: "network_download" } }, "2026-07-03T00:00:02.000Z")
	]);

	assert.deepEqual(scopes, [scope]);
});

test("cancelling a request clears pending approval continuation and persistence", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-approval-cancel-"));
	process.env.USERPROFILE = appDataDir;
	try {
		const suffix: string = `${Date.now()}-${Math.random()}`;
		const store = await import(`../../../src/session/session-store.js?case=${suffix}`);
		const continuationModule = await import(`../../../src/server/approval-continuation.js?case=${suffix}`);
		const metadata = await store.createSession("Approval cancel", "workspace-a");
		const session = createClientSession(undefined);
		session.sessionId = metadata.id;
		const pendingApproval: PendingApproval = createPendingApproval();
		const pendingContinuation: PendingAiContinuation = createPendingContinuation();
		session.approvalGateway.upsertPending(pendingApproval);
		session.pendingAiContinuations.set(pendingApproval.approvalId, pendingContinuation);
		await store.appendApprovalEvent(
			metadata.id,
			pendingApproval.approvalId,
			pendingContinuation.requestId,
			"requested",
			createPersistedApprovalRequestedData(pendingApproval, pendingContinuation, "workspace-a")
		);

		const cancelledIds: string[] = await continuationModule.cancelPendingApprovalsForRequest(session, pendingContinuation.requestId);
		assert.deepEqual(cancelledIds, [pendingApproval.approvalId]);
		assert.equal(session.approvalGateway.listPending().length, 0);
		assert.equal(session.pendingAiContinuations.size, 0);

		const events = await store.readApprovalEvents(metadata.id);
		assert.equal(events.some((event: StoredApprovalEvent): boolean => event.event === "cancelled"), true);
		assert.deepEqual(foldPendingApprovalStates(events), []);
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
});
