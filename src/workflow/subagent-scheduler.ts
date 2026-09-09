import { randomUUID } from "node:crypto";
import {
	assertSubagentGraphStatusTransition,
	assertValidSubagentGraphSnapshot,
	cloneSubagentGraphSnapshot,
	transitionSubagentGraph,
	transitionSubagentNode,
	updateSubagentNodeWorktreeMetadata,
	type SubagentFailure,
	type SubagentGraphSnapshot,
	type SubagentGraphStatus,
	type SubagentNode,
	type SubagentResult,
	type SubagentWorktreeMetadata
} from "./subagent-graph.js";
import {
	alwaysAvailableSubagentResources,
	type SubagentResourceCoordinator,
	type SubagentResourceLease
} from "./subagent-resources.js";

export type SubagentNodeExecutor = (
	node: SubagentNode,
	snapshot: SubagentGraphSnapshot,
	abortSignal: AbortSignal
) => Promise<SubagentExecutionOutcome>;

export type SubagentExecutionOutcome =
	| { status: "completed"; result: SubagentResult }
	| { status: "failed"; result: SubagentResult; failure: SubagentFailure }
	| { status: "cancelled"; result: SubagentResult }
	| { status: "waiting_approval" };

export type SubagentSchedulerOptions = {
	persist: (snapshot: SubagentGraphSnapshot) => Promise<void>;
	execute: SubagentNodeExecutor;
	createRunId?: ((node: SubagentNode) => string) | undefined;
	onSnapshot?: ((snapshot: SubagentGraphSnapshot) => void) | undefined;
	resources?: SubagentResourceCoordinator | undefined;
	onRetry?: ((params: {
		node: SubagentNode;
		previousRunId: string;
		automatic: boolean;
		reason: string;
		nextRetryAt: string | null;
	}) => void) | undefined;
	now?: (() => Date) | undefined;
	setTimeout?: ((handler: () => void, timeoutMs: number) => NodeJS.Timeout) | undefined;
	clearTimeout?: ((timeout: NodeJS.Timeout) => void) | undefined;
};

type DependencyStatus = "ready" | "waiting" | "blocked";

function dependencyStatus(
	node: SubagentNode,
	statuses: ReadonlyMap<string, SubagentNode["status"]>
): DependencyStatus {
	let waiting: boolean = false;
	for (const dependencyId of node.dependsOn) {
		const status: SubagentNode["status"] | undefined = statuses.get(dependencyId);
		if (status === undefined || status === "failed" || status === "cancelled" || status === "blocked") {
			return "blocked";
		}
		if (status !== "completed") waiting = true;
	}
	return waiting ? "waiting" : "ready";
}

function deriveGraphStatus(nodes: readonly SubagentNode[]): SubagentGraphStatus {
	if (nodes.length === 0) return "draft";
	if (nodes.every((node: SubagentNode): boolean => node.status === "completed")) return "completed";
	if (nodes.some((node: SubagentNode): boolean => (
		node.status === "pending" || node.status === "ready" || node.status === "queued" || node.status === "running"
	))) return "running";
	if (nodes.some((node: SubagentNode): boolean => node.status === "waiting_approval")) return "blocked";
	if (nodes.some((node: SubagentNode): boolean => node.status === "completed")) return "completed_with_warnings";
	if (nodes.some((node: SubagentNode): boolean => node.status === "failed")) return "failed";
	return "completed_with_warnings";
}

// 每次持久化发布只增加一次 revision，即使同时更新节点和派生图状态。
function updateGraphStatus(snapshot: SubagentGraphSnapshot, status: SubagentGraphStatus): SubagentGraphSnapshot {
	if (snapshot.graph.status === status) return snapshot;
	assertSubagentGraphStatusTransition(snapshot.graph.status, status);
	return {
		...snapshot,
		graph: {
			...snapshot.graph,
			status,
			updatedAt: new Date().toISOString()
		}
	};
}

export function refreshSubagentGraph(snapshot: SubagentGraphSnapshot): SubagentGraphSnapshot {
	assertValidSubagentGraphSnapshot(snapshot);
	const mutableStatuses: Map<string, SubagentNode["status"]> = new Map(
		snapshot.nodes.map((node: SubagentNode): [string, SubagentNode["status"]] => [node.nodeId, node.status])
	);

	// 收敛到不动点，使失败或重试能在同一快照中阻塞或解锁整条后继链。
	let changed: boolean;
	do {
		changed = false;
		for (const node of snapshot.nodes) {
			const current: SubagentNode["status"] = mutableStatuses.get(node.nodeId) ?? node.status;
			if (current !== "pending" && current !== "ready" && current !== "queued" && current !== "blocked") continue;
			if (current === "queued" && node.queueReason !== null) {
				const dependency: DependencyStatus = dependencyStatus(node, mutableStatuses);
				if (dependency === "blocked") {
					mutableStatuses.set(node.nodeId, "blocked");
					changed = true;
				}
				continue;
			}
			const dependency: DependencyStatus = dependencyStatus(node, mutableStatuses);
			const next: SubagentNode["status"] = dependency === "ready"
				? "ready"
				: dependency === "waiting"
					? "pending"
					: "blocked";
			if (next !== current) {
				mutableStatuses.set(node.nodeId, next);
				changed = true;
			}
		}
	} while (changed);

	const now: string = new Date().toISOString();
	const nodes: SubagentNode[] = snapshot.nodes.map((node: SubagentNode): SubagentNode => {
		const status: SubagentNode["status"] = mutableStatuses.get(node.nodeId) ?? node.status;
		if (status === node.status) return node;
		if (status === "blocked") {
			return transitionSubagentNode(node, status, {
				failure: {
					code: "subagent_dependency_failed",
					message: "One or more subagent dependencies did not complete successfully.",
					retryable: true,
					failedAt: now
				}
			}, now);
		}
		return transitionSubagentNode(node, status, { failure: null }, now);
	});
	let next: SubagentGraphSnapshot = { graph: snapshot.graph, nodes };
	if (snapshot.graph.status !== "cancelled") next = updateGraphStatus(next, deriveGraphStatus(nodes));
	return next;
}

export function appendSubagentNodes(
	snapshot: SubagentGraphSnapshot,
	nodes: readonly SubagentNode[]
): SubagentGraphSnapshot {
	if (snapshot.graph.status === "cancelled") {
		throw new Error(`Cancelled subagent graph ${snapshot.graph.graphId} cannot be extended.`);
	}

	const existingNodeIds: Set<string> = new Set(snapshot.nodes.map((node: SubagentNode): string => node.nodeId));
	const existingRunIds: Set<string> = new Set(snapshot.nodes.map((node: SubagentNode): string => node.runId));
	for (const node of nodes) {
		if (node.graphId !== snapshot.graph.graphId) throw new Error(`Subagent node ${node.nodeId} belongs to another graph.`);
		if (existingNodeIds.has(node.nodeId)) throw new Error(`Duplicate subagent node id: ${node.nodeId}.`);
		if (existingRunIds.has(node.runId)) throw new Error(`Duplicate subagent run id: ${node.runId}.`);
		existingNodeIds.add(node.nodeId);
		existingRunIds.add(node.runId);
	}
	let next: SubagentGraphSnapshot = { graph: snapshot.graph, nodes: [...snapshot.nodes, ...nodes] };
	if (
		next.graph.status === "completed"
		|| next.graph.status === "completed_with_warnings"
		|| next.graph.status === "failed"
	) {
		next = updateGraphStatus(next, "running");
	}
	assertValidSubagentGraphSnapshot(next);
	if (next.graph.status === "draft" && next.nodes.length > 0) next = updateGraphStatus(next, "running");
	return refreshSubagentGraph(next);
}

export class SubagentGraphScheduler {
	private snapshot: SubagentGraphSnapshot;
	private readonly persist: SubagentSchedulerOptions["persist"];
	private readonly execute: SubagentNodeExecutor;
	private readonly createRunId: (node: SubagentNode) => string;
	private readonly onSnapshot: SubagentSchedulerOptions["onSnapshot"];
	private readonly resources: SubagentResourceCoordinator;
	private readonly onRetry: SubagentSchedulerOptions["onRetry"];
	private readonly now: () => Date;
	private readonly setTimer: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
	private readonly clearTimer: (timeout: NodeJS.Timeout) => void;
	private readonly controllers: Map<string, AbortController> = new Map();
	private readonly leases: Map<string, SubagentResourceLease> = new Map();
	private readonly queueTimers: Map<string, NodeJS.Timeout> = new Map();
	private readonly executions: Map<string, Promise<void>> = new Map();
	private readonly waiters: Set<() => void> = new Set();
	private readonly pendingRetryEvents: Array<NonNullable<SubagentSchedulerOptions["onRetry"]> extends (params: infer P) => void ? P : never> = [];
	private mutationTail: Promise<void> = Promise.resolve();
	private started: boolean = false;

	constructor(snapshot: SubagentGraphSnapshot, options: SubagentSchedulerOptions) {
		assertValidSubagentGraphSnapshot(snapshot);
		this.snapshot = cloneSubagentGraphSnapshot(snapshot);
		this.persist = options.persist;
		this.execute = options.execute;
		this.createRunId = options.createRunId ?? ((): string => `subagent-run-${randomUUID()}`);
		this.onSnapshot = options.onSnapshot;
		this.resources = options.resources ?? alwaysAvailableSubagentResources;
		this.onRetry = options.onRetry;
		this.now = options.now ?? (() => new Date());
		this.setTimer = options.setTimeout ?? ((handler, timeoutMs): NodeJS.Timeout => setTimeout(handler, timeoutMs));
		this.clearTimer = options.clearTimeout ?? ((timer): void => clearTimeout(timer));
	}

	getSnapshot(): SubagentGraphSnapshot {
		return cloneSubagentGraphSnapshot(this.snapshot);
	}

	async append(nodes: readonly SubagentNode[]): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			this.snapshot = appendSubagentNodes(this.snapshot, nodes);
			await this.publish();
			this.scheduleReadyNodes();
			return this.getSnapshot();
		});
	}

	async start(): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			if (!this.started) {
				this.started = true;
				this.recoverInterruptedNodesInMemory();
			}
			this.snapshot = refreshSubagentGraph(this.snapshot);
			await this.publish();
			this.scheduleReadyNodes();
			return this.getSnapshot();
		});
	}

	async recoverInterruptedNodes(): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			const recovered: boolean = this.recoverInterruptedNodesInMemory();
			this.started = true;
			if (!recovered) return this.getSnapshot();
			this.snapshot = refreshSubagentGraph(this.snapshot);
			await this.publish();
			this.scheduleReadyNodes();
			return this.getSnapshot();
		});
	}

	async cancel(nodeId?: string | undefined): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			if (nodeId !== undefined) {
				this.requireNode(nodeId);
				this.controllers.get(nodeId)?.abort();
				this.clearQueueWake(nodeId);
				let changed: boolean = false;
				this.snapshot = {
					...this.snapshot,
					nodes: this.snapshot.nodes.map((node: SubagentNode): SubagentNode => {
						if (node.nodeId !== nodeId || node.status === "completed" || node.status === "failed" || node.status === "cancelled") return node;
						changed = true;
						return transitionSubagentNode(node, "cancelled", { result: cancelledResult("Subagent node was cancelled.") });
					})
				};
				if (!changed) return this.getSnapshot();
				this.snapshot = refreshSubagentGraph(this.snapshot);
			} else {
				if (
					this.snapshot.graph.status === "completed"
					|| this.snapshot.graph.status === "completed_with_warnings"
					|| this.snapshot.graph.status === "failed"
					|| this.snapshot.graph.status === "cancelled"
				) return this.getSnapshot();
				for (const controller of this.controllers.values()) controller.abort();
				for (const nodeId of this.queueTimers.keys()) this.clearQueueWake(nodeId);
				this.snapshot = {
					graph: updateGraphStatus(this.snapshot, "cancelled").graph,
					nodes: this.snapshot.nodes.map((node: SubagentNode): SubagentNode => (
						node.status === "completed" || node.status === "failed" || node.status === "cancelled"
							? node
							: transitionSubagentNode(node, "cancelled", { result: cancelledResult("Subagent graph was cancelled.") })
					))
				};
			}
			await this.publish();
			return this.getSnapshot();
		});
	}

	async retry(nodeId: string, requestedRunId?: string | undefined): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			const node: SubagentNode = this.requireNode(nodeId);
			if (node.status !== "failed" && node.status !== "cancelled" && node.status !== "blocked") {
				throw new Error(`Subagent node ${nodeId} is not retryable from ${node.status}.`);
			}
			if (this.snapshot.graph.status === "cancelled") throw new Error(`Cancelled subagent graph ${this.snapshot.graph.graphId} cannot be retried.`);
			const runId: string = requestedRunId ?? this.createRunId(node);
			if (runId.trim().length === 0 || runId === node.runId) throw new Error(`Retrying subagent node ${nodeId} requires a new run id.`);
			const next: SubagentNode = transitionSubagentNode(node, "pending", {
				runId,
				retryOfRunId: node.runId,
				attempt: node.attempt + 1,
				result: null,
				failure: null,
				queueReason: null,
				queuedAt: null,
				nextRetryAt: null
			});
			this.replaceNode(next);
			this.queueRetryEvent({ node: next, previousRunId: node.runId, automatic: false, reason: "manual_retry", nextRetryAt: null });
			this.snapshot = refreshSubagentGraph(this.snapshot);
			await this.publish();
			this.scheduleReadyNodes();
			return this.getSnapshot();
		});
	}

	async resume(nodeId: string): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			const node: SubagentNode = this.requireNode(nodeId);
			if (node.status !== "waiting_approval") throw new Error(`Subagent node ${nodeId} is not waiting for approval.`);
			this.replaceNode(transitionSubagentNode(node, "running", { queueReason: null, queuedAt: null, nextRetryAt: null }));
			this.snapshot = refreshSubagentGraph(this.snapshot);
			await this.publish();
			this.scheduleReadyNodes();
			return this.getSnapshot();
		});
	}

	async complete(nodeId: string, result: SubagentResult): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			const node: SubagentNode = this.requireNode(nodeId);
			if (node.status !== "running" && node.status !== "waiting_approval") throw new Error(`Subagent node ${nodeId} cannot complete from ${node.status}.`);
			this.replaceNode(transitionSubagentNode(node, "completed", { result, failure: null }));
			this.snapshot = refreshSubagentGraph(this.snapshot);
			await this.publish();
			this.scheduleReadyNodes();
			return this.getSnapshot();
		});
	}

	async fail(nodeId: string, failure: SubagentFailure, result: SubagentResult | null = null): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			const node: SubagentNode = this.requireNode(nodeId);
			if (node.status === "completed" || node.status === "failed" || node.status === "cancelled") return this.getSnapshot();
			this.replaceNode(transitionSubagentNode(node, "failed", { failure, result }));
			this.snapshot = refreshSubagentGraph(this.snapshot);
			await this.publish();
			this.scheduleReadyNodes();
			return this.getSnapshot();
		});
	}

	async cancelWithResult(nodeId: string, result: SubagentResult): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			const node: SubagentNode = this.requireNode(nodeId);
			if (node.status === "completed" || node.status === "failed" || node.status === "cancelled") return this.getSnapshot();
			this.controllers.get(nodeId)?.abort();
			this.replaceNode(transitionSubagentNode(node, "cancelled", { result, failure: null }));
			this.snapshot = refreshSubagentGraph(this.snapshot);
			await this.publish();
			this.scheduleReadyNodes();
			return this.getSnapshot();
		});
	}

	async updateWorktreeMetadata(nodeId: string, metadata: SubagentWorktreeMetadata | null): Promise<SubagentGraphSnapshot> {
		return await this.enqueueMutation(async (): Promise<SubagentGraphSnapshot> => {
			this.replaceNode(updateSubagentNodeWorktreeMetadata(this.requireNode(nodeId), metadata));
			await this.publish();
			return this.getSnapshot();
		});
	}

	async wait(nodeIds: readonly string[] | undefined, abortSignal?: AbortSignal | undefined): Promise<SubagentGraphSnapshot> {
		const requested: ReadonlySet<string> | undefined = nodeIds === undefined ? undefined : new Set(nodeIds);
		for (const nodeId of requested ?? []) this.requireNode(nodeId);
		const done = (): boolean => {
			if (requested === undefined || requested.size === 0) {
				return this.snapshot.graph.status === "completed"
					|| this.snapshot.graph.status === "completed_with_warnings"
					|| this.snapshot.graph.status === "failed"
					|| this.snapshot.graph.status === "cancelled"
					|| this.snapshot.graph.status === "blocked";
			}
			return [...requested].every((nodeId: string): boolean => {
				const node: SubagentNode = this.requireNode(nodeId);
				return node.status === "completed" || node.status === "failed" || node.status === "cancelled"
					|| node.status === "blocked" || node.status === "waiting_approval";
			});
		};
		if (done()) return this.getSnapshot();
		if (abortSignal?.aborted === true) throw new Error("Subagent wait cancelled.");
		await new Promise<void>((resolve, reject): void => {
			const notify = (): void => {
				if (!done()) return;
				cleanup();
				resolve();
			};
			const onAbort = (): void => {
				cleanup();
				reject(new Error("Subagent wait cancelled."));
			};
			const cleanup = (): void => {
				this.waiters.delete(notify);
				abortSignal?.removeEventListener("abort", onAbort);
			};
			this.waiters.add(notify);
			abortSignal?.addEventListener("abort", onAbort, { once: true });
		});
		return this.getSnapshot();
	}

	async waitForChange(afterRevision: number, timeoutMs: number, abortSignal?: AbortSignal | undefined): Promise<SubagentGraphSnapshot> {
		if (this.snapshot.graph.revision > afterRevision || timeoutMs === 0) return this.getSnapshot();
		if (abortSignal?.aborted === true) throw new Error("Subagent wait cancelled.");
		await new Promise<void>((resolve, reject): void => {
			const notify = (): void => {
				if (this.snapshot.graph.revision <= afterRevision) return;
				cleanup();
				resolve();
			};
			const onAbort = (): void => {
				cleanup();
				reject(new Error("Subagent wait cancelled."));
			};
			const timer: NodeJS.Timeout = setTimeout((): void => {
				cleanup();
				resolve();
			}, Math.max(0, timeoutMs));
			const cleanup = (): void => {
				clearTimeout(timer);
				this.waiters.delete(notify);
				abortSignal?.removeEventListener("abort", onAbort);
			};
			this.waiters.add(notify);
			abortSignal?.addEventListener("abort", onAbort, { once: true });
		});
		return this.getSnapshot();
	}

	private scheduleReadyNodes(): void {
		const candidates: SubagentNode[] = this.snapshot.nodes
			.filter((node: SubagentNode): boolean => node.status === "ready" || node.status === "queued")
			.sort((left: SubagentNode, right: SubagentNode): number => left.createdAt.localeCompare(right.createdAt) || left.nodeId.localeCompare(right.nodeId));
		for (const node of candidates) {
			if (this.executions.has(node.nodeId)) continue;
			if (node.status === "queued" && node.queueReason !== "retry_backoff" && this.queueTimers.has(node.nodeId)) continue;
			if (node.status === "queued" && node.queueReason === "retry_backoff") {
				const nextRetryAt: number = node.nextRetryAt === null ? 0 : Date.parse(node.nextRetryAt);
				const delayMs: number = Math.max(0, nextRetryAt - this.now().getTime());
				this.scheduleQueueWake(node.nodeId, delayMs);
				if (delayMs > 0) continue;
			}
			const execution: Promise<void> = this.runNode(node.nodeId).finally((): void => {
				if (this.executions.get(node.nodeId) === execution) this.executions.delete(node.nodeId);
				this.controllers.delete(node.nodeId);
				this.scheduleReadyNodes();
			});
			this.executions.set(node.nodeId, execution);
		}
	}

	private async runNode(nodeId: string): Promise<void> {
		const controller: AbortController = new AbortController();
		this.controllers.set(nodeId, controller);
		const initialNode: SubagentNode = this.requireNode(nodeId);
		const resourceDecision = await this.resources.acquire(initialNode, this.getSnapshot());
		if (!resourceDecision.available) {
			await this.enqueueMutation(async (): Promise<void> => {
				const current: SubagentNode = this.requireNode(nodeId);
				if (current.status === "ready") {
					this.replaceNode(transitionSubagentNode(current, "queued", {
						queueReason: resourceDecision.reason,
						queuedAt: this.now().toISOString(),
						nextRetryAt: null
					}));
					this.snapshot = refreshSubagentGraph(this.snapshot);
					await this.publish();
				}
			});
			if (this.requireNode(nodeId).status === "queued") this.scheduleQueueWake(nodeId, 250);
			return;
		}
		this.leases.set(nodeId, resourceDecision.lease);
		try {
			const shouldExecute: boolean = await this.enqueueMutation(async (): Promise<boolean> => {
				const node: SubagentNode = this.requireNode(nodeId);
				if (node.status !== "ready" && node.status !== "queued") return false;
				this.replaceNode(transitionSubagentNode(node, "running", { queueReason: null, queuedAt: null, nextRetryAt: null }));
				this.snapshot = refreshSubagentGraph(this.snapshot);
				await this.publish();
				return true;
			});
			if (!shouldExecute) return;

			let outcome: SubagentExecutionOutcome | null = null;
			let executionFailure: SubagentFailure | null = null;
			try {
				outcome = await this.execute(this.requireNode(nodeId), this.getSnapshot(), controller.signal);
			} catch (error: unknown) {
				executionFailure = {
					code: typeof (error as { code?: unknown }).code === "string"
						? (error as { code: string }).code
						: "subagent_execution_failed",
					message: error instanceof Error ? error.message : String(error),
					retryable: !controller.signal.aborted,
					failedAt: new Date().toISOString()
				};
			}

			await this.enqueueMutation(async (): Promise<void> => {
				const node: SubagentNode = this.requireNode(nodeId);
				if (node.status === "cancelled") return;
				if (executionFailure !== null) {
					if (!controller.signal.aborted && this.shouldAutoRetry(node, executionFailure)) {
						this.scheduleRetry(node, executionFailure.message, true);
					} else this.replaceNode(transitionSubagentNode(node, controller.signal.aborted ? "cancelled" : "failed", {
						failure: executionFailure,
						result: controller.signal.aborted ? cancelledResult(executionFailure.message) : null
					}));
				} else if (outcome?.status === "waiting_approval") {
					this.replaceNode(transitionSubagentNode(node, "waiting_approval"));
				} else if (outcome?.status === "completed") {
					this.replaceNode(transitionSubagentNode(node, "completed", { result: outcome.result, failure: null }));
				} else if (outcome?.status === "failed") {
					if (this.shouldAutoRetry(node, outcome.failure)) this.scheduleRetry(node, outcome.failure.message, true);
					else this.replaceNode(transitionSubagentNode(node, "failed", { result: outcome.result, failure: outcome.failure }));
				} else if (outcome?.status === "cancelled") {
					this.replaceNode(transitionSubagentNode(node, "cancelled", { result: outcome.result, failure: null }));
				} else {
					throw new Error(`Subagent node ${nodeId} returned no execution outcome.`);
				}
				this.snapshot = refreshSubagentGraph(this.snapshot);
				await this.publish();
				this.scheduleReadyNodes();
			});
		} finally {
			await this.releaseLease(nodeId);
		}
	}

	private shouldAutoRetry(node: SubagentNode, failure: SubagentFailure): boolean {
		if (node.retryPolicy.mode !== "transient_only" || node.attempt > node.retryPolicy.maxRetries) return false;
		if (node.role === "implementer" || node.toolScope.capabilities.includes("write") || node.toolScope.capabilities.includes("destructive")) return false;
		if (!failure.retryable) return false;
		return /(?:timeout|timed_out|rate[_-]?limit|429|5\d\d|network|connection|econnreset|temporarily|unavailable)/iu.test(`${failure.code} ${failure.message}`);
	}

	private scheduleRetry(node: SubagentNode, reason: string, automatic: boolean): void {
		const previousRunId: string = node.runId;
		const runId: string = this.createRunId(node);
		const delayMs: number = Math.min(30_000, 500 * (2 ** Math.max(0, node.attempt - 1)));
		const nextRetryAt: string = new Date(this.now().getTime() + delayMs).toISOString();
		const next: SubagentNode = transitionSubagentNode(node, "queued", {
			runId,
			attempt: node.attempt + 1,
			queueReason: "retry_backoff",
			queuedAt: this.now().toISOString(),
			nextRetryAt,
			retryOfRunId: previousRunId,
			result: null,
			failure: null
		});
		this.replaceNode(next);
		this.queueRetryEvent({ node: next, previousRunId, automatic, reason, nextRetryAt });
		this.scheduleQueueWake(node.nodeId, delayMs);
	}

	private scheduleQueueWake(nodeId: string, delayMs: number): void {
		if (this.queueTimers.has(nodeId)) return;
		const timer: NodeJS.Timeout = this.setTimer((): void => {
			this.queueTimers.delete(nodeId);
			this.scheduleReadyNodes();
		}, Math.max(0, delayMs));
		this.queueTimers.set(nodeId, timer);
	}

	private clearQueueWake(nodeId: string): void {
		const timer: NodeJS.Timeout | undefined = this.queueTimers.get(nodeId);
		if (timer !== undefined) {
			this.clearTimer(timer);
			this.queueTimers.delete(nodeId);
		}
	}

	private async releaseLease(nodeId: string): Promise<void> {
		const lease: SubagentResourceLease | undefined = this.leases.get(nodeId);
		if (lease === undefined) return;
		this.leases.delete(nodeId);
		await lease.release();
	}

	private queueRetryEvent(event: Parameters<NonNullable<SubagentSchedulerOptions["onRetry"]>>[0]): void {
		this.pendingRetryEvents.push(event);
	}

	private requireNode(nodeId: string): SubagentNode {
		const node: SubagentNode | undefined = this.snapshot.nodes.find((candidate: SubagentNode): boolean => candidate.nodeId === nodeId);
		if (node === undefined) throw new Error(`Unknown subagent node: ${nodeId}.`);
		return node;
	}

	private replaceNode(node: SubagentNode): void {
		this.snapshot = {
			...this.snapshot,
			nodes: this.snapshot.nodes.map((candidate: SubagentNode): SubagentNode => candidate.nodeId === node.nodeId ? node : candidate)
		};
	}

	private recoverInterruptedNodesInMemory(): boolean {
		let recovered: boolean = false;
		this.snapshot = {
			...this.snapshot,
			nodes: this.snapshot.nodes.map((node: SubagentNode): SubagentNode => {
				if (node.status !== "running") return node;
				const runId: string = this.createRunId(node);
				if (runId === node.runId) throw new Error(`Recovered subagent node ${node.nodeId} requires a new run id.`);
				recovered = true;
				return transitionSubagentNode(node, "ready", {
					runId,
					retryOfRunId: node.runId,
					attempt: node.attempt + 1,
					result: null,
					failure: null,
					queueReason: null,
					queuedAt: null,
					nextRetryAt: null
				});
			})
		};
		return recovered;
	}

	private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result: Promise<T> = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then((): void => undefined, (): void => undefined);
		return await result;
	}

	private async publish(): Promise<void> {
		this.snapshot = {
			...this.snapshot,
			graph: transitionSubagentGraph(this.snapshot.graph, this.snapshot.graph.status)
		};
		assertValidSubagentGraphSnapshot(this.snapshot);
		const published: SubagentGraphSnapshot = this.getSnapshot();
		await this.persist(published);
		this.onSnapshot?.(cloneSubagentGraphSnapshot(published));
		const retryEvents: Array<Parameters<NonNullable<SubagentSchedulerOptions["onRetry"]>>[0]> = this.pendingRetryEvents.splice(0);
		for (const retryEvent of retryEvents) this.onRetry?.(retryEvent);
		for (const waiter of [...this.waiters]) waiter();
	}
}

function cancelledResult(summary: string): SubagentResult {
	return {
		status: "cancelled",
		summary,
		findings: [],
		changedFiles: [],
		tests: [],
		artifacts: [],
		needsParentDecision: false,
		recommendedNextAction: null
	};
}
