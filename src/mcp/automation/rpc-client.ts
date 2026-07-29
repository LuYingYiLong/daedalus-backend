import WebSocket from "ws";
import type { AutomationConfig } from "./config.js";
import { redactAutomationResult } from "./security.js";

type RpcRequest = {
	protocolVersion: 3;
	type: "request";
	id: string;
	method: string;
	params?: unknown;
};

export type AutomationServerMessage = {
	sequence: number;
	raw: Record<string, unknown>;
};

type PendingRequest = {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

export type WaitForEventFilter = {
	eventName?: string | undefined;
	requestId?: string | undefined;
	planId?: string | undefined;
	afterSequence?: number | undefined;
	timeoutMs?: number | undefined;
};

export type WaitForRunInput = {
	requestId: string;
	timeoutMs?: number | undefined;
	includeTimeline?: boolean | undefined;
};

export type AutomationRunErrorStatus = {
	event?: string | undefined;
	status?: string | undefined;
	code?: string | undefined;
	title?: string | undefined;
	details?: string | undefined;
	message?: string | undefined;
	sequence?: number | undefined;
};

export type WaitForRunResult = {
	requestId: string;
	completed: boolean;
	failed: boolean;
	activeRunStatus: string;
	finalWorkbenchRevision: number | null;
	assistantStatus?: string | undefined;
	errorStatuses: AutomationRunErrorStatus[];
	timelineBlocks?: unknown[] | undefined;
};

type RunWorkbenchSnapshot = {
	activeRunStatus: string;
	revision: number | null;
	sessionId?: string | undefined;
	sequence: number;
};

function createRequestId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getMessageEventName(message: Record<string, unknown>): string | undefined {
	if (typeof message.event === "string") {
		return message.event;
	}
	if (typeof message.method === "string") {
		return message.method;
	}
	return undefined;
}

function getMessageRequestId(message: Record<string, unknown>): string | undefined {
	if (typeof message.requestId === "string") {
		return message.requestId;
	}
	if (typeof message.id === "string" && message.type !== "response") {
		return message.id;
	}
	const data = message.data;
	if (data !== null && typeof data === "object" && typeof (data as Record<string, unknown>).requestId === "string") {
		return (data as Record<string, unknown>).requestId as string;
	}
	return undefined;
}

function getMessagePlanId(message: Record<string, unknown>): string | undefined {
	const data = message.data;
	if (data !== null && typeof data === "object") {
		const record = data as Record<string, unknown>;
		if (typeof record.planId === "string") {
			return record.planId;
		}
		if (record.plan !== null && typeof record.plan === "object" && typeof (record.plan as Record<string, unknown>).planId === "string") {
			return (record.plan as Record<string, unknown>).planId as string;
		}
	}
	if (typeof message.planId === "string") {
		return message.planId;
	}
	return undefined;
}

function matchesFilter(message: AutomationServerMessage, filter: WaitForEventFilter): boolean {
	if (filter.afterSequence !== undefined && message.sequence <= filter.afterSequence) {
		return false;
	}
	if (filter.eventName !== undefined && getMessageEventName(message.raw) !== filter.eventName) {
		return false;
	}
	if (filter.requestId !== undefined && getMessageRequestId(message.raw) !== filter.requestId) {
		return false;
	}
	if (filter.planId !== undefined && getMessagePlanId(message.raw) !== filter.planId) {
		return false;
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getWorkbenchSnapshot(message: AutomationServerMessage): RunWorkbenchSnapshot | undefined {
	const raw = message.raw;
	const data = isRecord(raw.data) ? raw.data : undefined;
	const workbench = isRecord(data?.workbench) ? data.workbench : (isRecord(raw.workbench) ? raw.workbench : undefined);
	if (workbench === undefined) {
		return undefined;
	}
	const activeRun = isRecord(workbench.activeRun) ? workbench.activeRun : undefined;
	const status = asOptionalString(activeRun?.status);
	if (status === undefined) {
		return undefined;
	}
	return {
		activeRunStatus: status,
		revision: asOptionalNumber(workbench.revision) ?? null,
		sessionId: asOptionalString(workbench.sessionId),
		sequence: message.sequence
	};
}

function getTimelineBlocks(result: unknown): unknown[] {
	if (Array.isArray(result)) {
		return result;
	}
	if (isRecord(result) && Array.isArray(result.timelineBlocks)) {
		return result.timelineBlocks;
	}
	if (isRecord(result) && Array.isArray(result.blocks)) {
		return result.blocks;
	}
	return [];
}

function getAssistantStatus(blocks: readonly unknown[], requestId: string): string | undefined {
	const assistantBlocks = blocks
		.filter((block: unknown): block is Record<string, unknown> => isRecord(block))
		.filter((block: Record<string, unknown>): boolean => block.type === "assistant" && block.requestId === requestId);
	return asOptionalString(assistantBlocks.at(-1)?.status);
}

function collectTimelineErrorStatuses(blocks: readonly unknown[], requestId: string): AutomationRunErrorStatus[] {
	const errors: AutomationRunErrorStatus[] = [];
	for (const block of blocks) {
		if (!isRecord(block) || block.type !== "assistant" || block.requestId !== requestId || !Array.isArray(block.bodyParts)) {
			continue;
		}
		for (const part of block.bodyParts) {
			if (!isRecord(part) || part.type !== "status") {
				continue;
			}
			const status = asOptionalString(part.status);
			const code = asOptionalString(part.code);
			const isError = status === "failed"
				|| status === "error"
				|| code === "agent_run_error"
				|| code === "provider_error"
				|| (code?.includes("error") ?? false);
			if (!isError) {
				continue;
			}
			errors.push({
				status,
				code,
				title: asOptionalString(part.title),
				details: asOptionalString(part.details)
			});
		}
	}
	return errors;
}

function collectMessageErrorStatuses(messages: readonly AutomationServerMessage[], requestId: string): AutomationRunErrorStatus[] {
	const errors: AutomationRunErrorStatus[] = [];
	for (const message of messages) {
		if (getMessageRequestId(message.raw) !== requestId) {
			continue;
		}
		const event = getMessageEventName(message.raw);
		const data = isRecord(message.raw.data) ? message.raw.data : {};
		const status = asOptionalString(message.raw.status) ?? asOptionalString(data.status);
		const code = asOptionalString(message.raw.code) ?? asOptionalString(data.code);
		const isError = event === "agent_run_error"
			|| event === "provider_error"
			|| status === "failed"
			|| status === "error"
			|| code === "agent_run_error"
			|| code === "provider_error"
			|| (code?.includes("error") ?? false);
		if (!isError) {
			continue;
		}
		errors.push({
			event,
			status,
			code,
			title: asOptionalString(message.raw.title) ?? asOptionalString(data.title),
			details: asOptionalString(message.raw.details) ?? asOptionalString(data.details),
			message: asOptionalString(message.raw.message) ?? asOptionalString(data.message),
			sequence: message.sequence
		});
	}
	return errors;
}

export class AutomationRpcClient {
	private socket: WebSocket | undefined;
	private connected = false;
	private helloSent = false;
	private messageSequence = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly waiters = new Set<{
		filter: WaitForEventFilter;
		resolve: (message: AutomationServerMessage) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}>();

	readonly messages: AutomationServerMessage[] = [];

	constructor(private readonly config: AutomationConfig) {}

	async ensureConnected(): Promise<void> {
		if (this.socket !== undefined && this.connected) {
			if (!this.helloSent) {
				this.helloSent = true;
				try {
					await this.sendConnectedRequest("client.hello", {
						protocolVersion: 3,
						clientType: "smoke",
						clientName: this.config.clientName,
						capabilities: {
							automationMcp: true
						}
					});
				} catch (error: unknown) {
					this.helloSent = false;
					throw error;
				}
			}
			return;
		}

		await new Promise<void>((resolve, reject): void => {
			const socket = new WebSocket(this.config.backendUrl, {
				headers: this.config.authToken === undefined
					? undefined
					: { Authorization: `Bearer ${this.config.authToken}` }
			});
			this.socket = socket;

			const rejectConnect = (error: Error): void => {
				socket.removeAllListeners();
				reject(error);
			};

			socket.once("open", (): void => {
				this.connected = true;
				socket.on("message", (data: WebSocket.RawData): void => this.handleMessage(data));
				socket.on("close", (): void => this.handleClose());
				socket.on("error", (error: Error): void => this.handleSocketError(error));
				resolve();
			});
			socket.once("error", rejectConnect);
		});

		await this.ensureConnected();
	}

	async close(): Promise<void> {
		if (this.socket === undefined) {
			return;
		}
		const socket = this.socket;
		this.socket = undefined;
		this.connected = false;
		this.helloSent = false;
		await new Promise<void>((resolve): void => {
			socket.once("close", (): void => resolve());
			socket.close();
			setTimeout(resolve, 1000).unref();
		});
	}

	async sendRequest(method: string, params?: unknown, timeoutMs: number = this.config.requestTimeoutMs): Promise<unknown> {
		await this.ensureConnected();
		return this.sendConnectedRequest(method, params, timeoutMs);
	}

	private async sendConnectedRequest(method: string, params?: unknown, timeoutMs: number = this.config.requestTimeoutMs): Promise<unknown> {
		const id = createRequestId(method.replaceAll(".", "_"));
		const request: RpcRequest = { protocolVersion: 3, type: "request", id, method, params };
		return new Promise<unknown>((resolve, reject): void => {
			const timer = setTimeout((): void => {
				this.pending.delete(id);
				reject(new Error(`RPC request timed out: ${method}`));
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, { method, resolve, reject, timer });
			this.socket?.send(JSON.stringify(request), (error?: Error | null): void => {
				if (error != null) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(error);
				}
			});
		});
	}

	async sendRequestNoWait(method: string, params?: unknown): Promise<string> {
		await this.ensureConnected();
		const id = createRequestId(method.replaceAll(".", "_"));
		const request: RpcRequest = { protocolVersion: 3, type: "request", id, method, params };
		await new Promise<void>((resolve, reject): void => {
			this.socket?.send(JSON.stringify(request), (error?: Error | null): void => {
				if (error != null) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		return id;
	}

	async waitForEvent(filter: WaitForEventFilter): Promise<AutomationServerMessage> {
		const existing = this.messages.find((message: AutomationServerMessage): boolean => matchesFilter(message, filter));
		if (existing !== undefined) {
			return existing;
		}
		await this.ensureConnected();
		const timeoutMs = filter.timeoutMs ?? this.config.requestTimeoutMs;
		return new Promise<AutomationServerMessage>((resolve, reject): void => {
			const waiter = {
				filter,
				resolve,
				reject,
				timer: setTimeout((): void => {
					this.waiters.delete(waiter);
					reject(new Error(`Timed out waiting for event: ${JSON.stringify(redactAutomationResult(filter))}`));
				}, timeoutMs)
			};
			waiter.timer.unref();
			this.waiters.add(waiter);
		});
	}

	async waitForRun(input: WaitForRunInput): Promise<WaitForRunResult> {
		await this.ensureConnected();
		const timeoutMs = input.timeoutMs ?? this.config.requestTimeoutMs;
		const startedAtMs: number = Date.now();
		let cursor: number = 0;
		let snapshot: RunWorkbenchSnapshot | undefined = this.findLatestRunWorkbenchSnapshot(input.requestId, cursor);
		if (snapshot !== undefined) {
			cursor = snapshot.sequence;
		}

		while (snapshot?.activeRunStatus !== "idle") {
			const remainingMs: number = timeoutMs - (Date.now() - startedAtMs);
			if (remainingMs <= 0) {
				break;
			}
			const message: AutomationServerMessage = await this.waitForEvent({
				eventName: "session.workbench.updated",
				requestId: input.requestId,
				afterSequence: cursor,
				timeoutMs: remainingMs
			});
			cursor = message.sequence;
			const nextSnapshot = getWorkbenchSnapshot(message);
			if (nextSnapshot !== undefined) {
				snapshot = nextSnapshot;
			}
		}

		const timelineBlocks: unknown[] = await this.readTimelineBlocks(snapshot?.sessionId, timeoutMs - (Date.now() - startedAtMs));
		const assistantStatus: string | undefined = getAssistantStatus(timelineBlocks, input.requestId);
		const timelineErrorStatuses: AutomationRunErrorStatus[] = collectTimelineErrorStatuses(timelineBlocks, input.requestId);
		const messageErrorStatuses: AutomationRunErrorStatus[] = collectMessageErrorStatuses(this.messages, input.requestId);
		const errorStatuses: AutomationRunErrorStatus[] = [...timelineErrorStatuses, ...messageErrorStatuses];
		const activeRunStatus: string = snapshot?.activeRunStatus ?? "unknown";
		const failed: boolean = assistantStatus === "failed" || errorStatuses.length > 0;
		const completed: boolean = activeRunStatus === "idle" && !failed;
		return {
			requestId: input.requestId,
			completed,
			failed,
			activeRunStatus,
			finalWorkbenchRevision: snapshot?.revision ?? null,
			assistantStatus,
			errorStatuses,
			...(input.includeTimeline === true ? { timelineBlocks } : {})
		};
	}

	private findLatestRunWorkbenchSnapshot(requestId: string, afterSequence: number): RunWorkbenchSnapshot | undefined {
		let snapshot: RunWorkbenchSnapshot | undefined;
		for (const message of this.messages) {
			if (message.sequence <= afterSequence || !matchesFilter(message, {
				eventName: "session.workbench.updated",
				requestId
			})) {
				continue;
			}
			const candidate = getWorkbenchSnapshot(message);
			if (candidate !== undefined) {
				snapshot = candidate;
			}
		}
		return snapshot;
	}

	private async readTimelineBlocks(sessionId: string | undefined, timeoutMs: number): Promise<unknown[]> {
		if (sessionId === undefined || timeoutMs <= 0) {
			return [];
		}
		try {
			const result = await this.sendRequest("session.timeline", {
				sessionId,
				limit: 50
			}, Math.max(1000, timeoutMs));
			return getTimelineBlocks(result);
		} catch {
			return [];
		}
	}

	private handleMessage(data: WebSocket.RawData): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(data.toString()) as Record<string, unknown>;
		} catch {
			return;
		}

		const sequence = this.messageSequence + 1;
		this.messageSequence = sequence;
		const stored: AutomationServerMessage = { sequence, raw: redactAutomationResult(message) };
		this.messages.push(stored);
		if (this.messages.length > 2000) {
			this.messages.splice(0, this.messages.length - 2000);
		}

		if (message.type === "response" && typeof message.id === "string") {
			const pending = this.pending.get(message.id);
			if (pending !== undefined) {
				clearTimeout(pending.timer);
				this.pending.delete(message.id);
				if (message.ok === true) {
					pending.resolve(redactAutomationResult(message.result));
				} else {
					const error = message.error !== null && typeof message.error === "object"
						? message.error as Record<string, unknown>
						: {};
					pending.reject(new Error(`${pending.method} failed: ${String(error.message ?? "Unknown RPC error")}`));
				}
			}
		}

		for (const waiter of [...this.waiters]) {
			if (matchesFilter(stored, waiter.filter)) {
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(stored);
			}
		}
	}

	private handleClose(): void {
		this.connected = false;
		this.helloSent = false;
		const error = new Error("Backend WebSocket closed");
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
		for (const waiter of [...this.waiters]) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
			this.waiters.delete(waiter);
		}
	}

	private handleSocketError(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

let sharedClient: AutomationRpcClient | undefined;

export function getAutomationRpcClient(config: AutomationConfig): AutomationRpcClient {
	if (sharedClient === undefined) {
		sharedClient = new AutomationRpcClient(config);
	}
	return sharedClient;
}

export function resetAutomationRpcClientForTests(): void {
	sharedClient = undefined;
}
