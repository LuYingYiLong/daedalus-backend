import assert from "node:assert/strict";
import test from "node:test";
import {
	createSubagentGraph,
	createSubagentNode,
	transitionSubagentGraph,
	transitionSubagentNode,
	type SubagentGraphSnapshot,
	type SubagentNode,
	type SubagentResult
} from "../../../src/workflow/subagent-graph.js";
import { SubagentGraphScheduler } from "../../../src/workflow/subagent-scheduler.js";

const RESULT: SubagentResult = {
	status: "completed",
	summary: "Done.",
	findings: [],
	changedFiles: [],
	tests: [],
	artifacts: [],
	needsParentDecision: false,
	recommendedNextAction: null
};

function node(nodeId: string, dependsOn: string[] = [], runId: string = `run-${nodeId}`): SubagentNode {
	return createSubagentNode({
		graphId: "graph-scheduler",
		nodeId,
		runId,
		role: "researcher",
		objective: `Execute ${nodeId}`,
		dependsOn,
		workspaceMode: "shared_read_only",
		toolScope: { capabilities: ["read"], toolNames: [], sourceFolderIds: ["source-main"] },
		now: "2026-09-09T00:00:00.000Z"
	});
}

function snapshot(nodes: SubagentNode[]): SubagentGraphSnapshot {
	return {
		graph: createSubagentGraph({
			graphId: "graph-scheduler",
			sessionId: "session-scheduler",
			rootRunId: "root-run",
			now: "2026-09-09T00:00:00.000Z"
		}),
		nodes
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise: Promise<T> = new Promise<T>((resolvePromise, rejectPromise): void => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function eventually(predicate: () => boolean): Promise<void> {
	const deadline: number = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for scheduler state.");
		await new Promise<void>((resolve): NodeJS.Timeout => setTimeout(resolve, 0));
	}
}

test("ready nodes execute concurrently and each publication increments revision once", async (): Promise<void> => {
	const gates = new Map([
		["a", deferred<{ status: "completed"; result: SubagentResult }>()],
		["b", deferred<{ status: "completed"; result: SubagentResult }>()]
	]);
	const started: string[] = [];
	const revisions: number[] = [];
	const scheduler = new SubagentGraphScheduler(snapshot([node("a"), node("b")]), {
		persist: async (state): Promise<void> => { revisions.push(state.graph.revision); },
		execute: async (candidate) => {
			started.push(candidate.nodeId);
			return await gates.get(candidate.nodeId)!.promise;
		}
	});

	await scheduler.start();
	await eventually((): boolean => started.length === 2);
	assert.deepEqual(new Set(started), new Set(["a", "b"]));
	gates.get("a")!.resolve({ status: "completed", result: RESULT });
	gates.get("b")!.resolve({ status: "completed", result: RESULT });
	const done = await scheduler.wait(undefined);
	assert.equal(done.graph.status, "completed");
	assert.ok(revisions.every((revision: number, index: number): boolean => index === 0 || revision === revisions[index - 1]! + 1));
});

test("failure blocks only descendants while independent nodes finish", async (): Promise<void> => {
	const independent = deferred<{ status: "completed"; result: SubagentResult }>();
	const scheduler = new SubagentGraphScheduler(snapshot([
		node("failed"),
		node("child", ["failed"]),
		node("grandchild", ["child"]),
		node("independent")
	]), {
		persist: async (): Promise<void> => undefined,
		execute: async (candidate) => {
			if (candidate.nodeId === "failed") throw new Error("expected failure");
			if (candidate.nodeId === "independent") return await independent.promise;
			throw new Error(`Blocked node ${candidate.nodeId} was scheduled.`);
		}
	});

	await scheduler.start();
	await eventually((): boolean => scheduler.getSnapshot().nodes.some((candidate) => candidate.nodeId === "failed" && candidate.status === "failed"));
	assert.equal(scheduler.getSnapshot().nodes.find((candidate) => candidate.nodeId === "child")?.status, "blocked");
	assert.equal(scheduler.getSnapshot().nodes.find((candidate) => candidate.nodeId === "grandchild")?.status, "blocked");
	assert.equal(scheduler.getSnapshot().nodes.find((candidate) => candidate.nodeId === "independent")?.status, "running");
	independent.resolve({ status: "completed", result: RESULT });
	const done = await scheduler.wait(undefined);
	assert.equal(done.graph.status, "completed_with_warnings");
});

test("structured failed outcomes retain both result and failure details", async (): Promise<void> => {
	const failedResult: SubagentResult = {
		...RESULT,
		status: "failed",
		summary: "The delegated verification failed.",
		needsParentDecision: true,
		recommendedNextAction: "Inspect the failure and retry."
	};
	const scheduler = new SubagentGraphScheduler(snapshot([node("reported-failure")]), {
		persist: async (): Promise<void> => undefined,
		execute: async () => ({
			status: "failed",
			result: failedResult,
			failure: {
				code: "subagent_reported_failure",
				message: failedResult.summary,
				retryable: true,
				failedAt: "2026-09-09T00:01:00.000Z"
			}
		})
	});

	await scheduler.start();
	const done = await scheduler.wait(undefined);
	assert.equal(done.graph.status, "failed");
	assert.deepEqual(done.nodes[0]?.result, failedResult);
	assert.equal(done.nodes[0]?.failure?.code, "subagent_reported_failure");
});

test("nodes appended while another node runs are scheduled immediately", async (): Promise<void> => {
	const gates = new Map<string, ReturnType<typeof deferred<{ status: "completed"; result: SubagentResult }>>>();
	gates.set("a", deferred());
	gates.set("b", deferred());
	const started: string[] = [];
	const scheduler = new SubagentGraphScheduler(snapshot([node("a")]), {
		persist: async (): Promise<void> => undefined,
		execute: async (candidate) => {
			started.push(candidate.nodeId);
			return await gates.get(candidate.nodeId)!.promise;
		}
	});

	await scheduler.start();
	await eventually((): boolean => started.includes("a"));
	await scheduler.append([node("b")]);
	await eventually((): boolean => started.includes("b"));
	gates.get("a")!.resolve({ status: "completed", result: RESULT });
	gates.get("b")!.resolve({ status: "completed", result: RESULT });
	assert.equal((await scheduler.wait(undefined)).graph.status, "completed");
});

test("a parent can extend a completed graph without changing completed nodes", async (): Promise<void> => {
	const started: string[] = [];
	const scheduler = new SubagentGraphScheduler(snapshot([node("a")]), {
		persist: async (): Promise<void> => undefined,
		execute: async (candidate) => {
			started.push(candidate.nodeId);
			return { status: "completed", result: RESULT };
		}
	});

	await scheduler.start();
	const completed = await scheduler.wait(undefined);
	const completedNode = structuredClone(completed.nodes[0]);
	assert.equal(completed.graph.status, "completed");

	await scheduler.append([node("b")]);
	const extended = await scheduler.wait(undefined);
	assert.equal(extended.graph.status, "completed");
	assert.deepEqual(extended.nodes.find((candidate) => candidate.nodeId === "a"), completedNode);
	assert.deepEqual(started, ["a", "b"]);
});

test("cancellation aborts a running node and blocks only its descendants", async (): Promise<void> => {
	const observedAbort = deferred<void>();
	const scheduler = new SubagentGraphScheduler(snapshot([node("a"), node("child", ["a"]), node("other")]), {
		persist: async (): Promise<void> => undefined,
		execute: async (candidate, _state, signal) => {
			if (candidate.nodeId === "other") return { status: "completed", result: RESULT };
			return await new Promise<never>((_resolve, reject): void => {
				signal.addEventListener("abort", (): void => {
					observedAbort.resolve();
					reject(new Error("aborted"));
				}, { once: true });
			});
		}
	});

	await scheduler.start();
	await eventually((): boolean => scheduler.getSnapshot().nodes.find((candidate) => candidate.nodeId === "a")?.status === "running");
	await scheduler.cancel("a");
	await observedAbort.promise;
	const done = await scheduler.wait(undefined);
	assert.equal(done.nodes.find((candidate) => candidate.nodeId === "a")?.status, "cancelled");
	assert.equal(done.nodes.find((candidate) => candidate.nodeId === "child")?.status, "blocked");
	assert.equal(done.nodes.find((candidate) => candidate.nodeId === "other")?.status, "completed");
});

test("retry reopens a failed graph with a new run id", async (): Promise<void> => {
	let attempts: number = 0;
	const scheduler = new SubagentGraphScheduler(snapshot([node("a")]), {
		persist: async (): Promise<void> => undefined,
		createRunId: (): string => "run-a-retry",
		execute: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("first attempt failed");
			return { status: "completed", result: RESULT };
		}
	});

	await scheduler.start();
	await eventually((): boolean => scheduler.getSnapshot().graph.status === "failed");
	await scheduler.retry("a");
	const done = await scheduler.wait(undefined);
	assert.equal(done.nodes[0]?.runId, "run-a-retry");
	assert.equal(done.nodes[0]?.status, "completed");
	assert.equal(attempts, 2);
});

test("waiting approval stays resumable without re-running the executor", async (): Promise<void> => {
	let executions: number = 0;
	const scheduler = new SubagentGraphScheduler(snapshot([node("approval")]), {
		persist: async (): Promise<void> => undefined,
		execute: async () => {
			executions += 1;
			return { status: "waiting_approval" };
		}
	});

	await scheduler.start();
	const waiting = await scheduler.wait(["approval"]);
	assert.equal(waiting.graph.status, "blocked");
	assert.equal(waiting.nodes[0]?.status, "waiting_approval");
	await scheduler.resume("approval");
	const done = await scheduler.complete("approval", RESULT);
	assert.equal(done.graph.status, "completed");
	assert.equal(executions, 1);
});

test("start recovers interrupted running nodes with a fresh run id", async (): Promise<void> => {
	const pending = node("recovered", [], "run-before-restart");
	const ready = transitionSubagentNode(pending, "ready");
	const running = transitionSubagentNode(ready, "running");
	const initial = snapshot([running]);
	initial.graph = transitionSubagentGraph(initial.graph, "running");
	let observedRunId: string | null = null;
	const scheduler = new SubagentGraphScheduler(initial, {
		persist: async (): Promise<void> => undefined,
		createRunId: (): string => "run-after-restart",
		execute: async (candidate) => {
			observedRunId = candidate.runId;
			return { status: "completed", result: RESULT };
		}
	});

	await scheduler.start();
	const done = await scheduler.wait(undefined);
	assert.equal(observedRunId, "run-after-restart");
	assert.equal(done.nodes[0]?.status, "completed");
});
