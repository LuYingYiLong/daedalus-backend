import WebSocket from "ws";
import type { ExternalMcpConfig } from "./config.js";
import { redactExternalMcpResult } from "./redaction.js";

type RpcRequest = {
	protocolVersion: 3;
	type: "request";
	id: string;
	method: string;
	params?: unknown;
};

export type ExternalMcpServerMessage = {
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
	const data: unknown = message.data;
	if (data !== null && typeof data === "object" && typeof (data as Record<string, unknown>).requestId === "string") {
		return (data as Record<string, unknown>).requestId as string;
	}
	return undefined;
}

function getMessagePlanId(message: Record<string, unknown>): string | undefined {
	const data: unknown = message.data;
	if (data !== null && typeof data === "object") {
		const record: Record<string, unknown> = data as Record<string, unknown>;
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

function matchesFilter(message: ExternalMcpServerMessage, filter: WaitForEventFilter): boolean {
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

export class ExternalMcpRpcClient {
	private socket: WebSocket | undefined;
	private connected = false;
	private helloSent = false;
	private messageSequence = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly waiters = new Set<{
		filter: WaitForEventFilter;
		resolve: (message: ExternalMcpServerMessage) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}>();

	readonly messages: ExternalMcpServerMessage[] = [];

	constructor(private readonly config: ExternalMcpConfig) {}

	async ensureConnected(): Promise<void> {
		if (this.socket !== undefined && this.connected) {
			if (!this.helloSent) {
				this.helloSent = true;
				try {
					await this.sendConnectedRequest("client.hello", {
						protocolVersion: 3,
						clientType: "external_mcp",
						clientName: this.config.clientName,
						capabilities: {
							externalMcp: true
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
		const socket: WebSocket = this.socket;
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
		const id: string = createRequestId(method.replaceAll(".", "_"));
		const request: RpcRequest = { protocolVersion: 3, type: "request", id, method, params };
		return new Promise<unknown>((resolve, reject): void => {
			const timer: NodeJS.Timeout = setTimeout((): void => {
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
		const id: string = createRequestId(method.replaceAll(".", "_"));
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

	async waitForEvent(filter: WaitForEventFilter): Promise<ExternalMcpServerMessage> {
		const existing: ExternalMcpServerMessage | undefined = this.messages.find((message: ExternalMcpServerMessage): boolean => matchesFilter(message, filter));
		if (existing !== undefined) {
			return existing;
		}
		await this.ensureConnected();
		const timeoutMs: number = filter.timeoutMs ?? this.config.requestTimeoutMs;
		return new Promise<ExternalMcpServerMessage>((resolve, reject): void => {
			const waiter = {
				filter,
				resolve,
				reject,
				timer: setTimeout((): void => {
					this.waiters.delete(waiter);
					reject(new Error(`Timed out waiting for event: ${JSON.stringify(redactExternalMcpResult(filter))}`));
				}, timeoutMs)
			};
			waiter.timer.unref();
			this.waiters.add(waiter);
		});
	}

	private handleMessage(data: WebSocket.RawData): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(data.toString()) as Record<string, unknown>;
		} catch {
			return;
		}

		const sequence: number = this.messageSequence + 1;
		this.messageSequence = sequence;
		const stored: ExternalMcpServerMessage = { sequence, raw: redactExternalMcpResult(message) };
		this.messages.push(stored);
		if (this.messages.length > 2000) {
			this.messages.splice(0, this.messages.length - 2000);
		}

		if (message.type === "response" && typeof message.id === "string") {
			const pending: PendingRequest | undefined = this.pending.get(message.id);
			if (pending !== undefined) {
				clearTimeout(pending.timer);
				this.pending.delete(message.id);
				if (message.ok === true) {
					pending.resolve(redactExternalMcpResult(message.result));
				} else {
					const error: Record<string, unknown> = message.error !== null && typeof message.error === "object"
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

let sharedClient: ExternalMcpRpcClient | undefined;

export function getExternalMcpRpcClient(config: ExternalMcpConfig): ExternalMcpRpcClient {
	if (sharedClient === undefined) {
		sharedClient = new ExternalMcpRpcClient(config);
	}
	return sharedClient;
}

export function resetExternalMcpRpcClientForTests(): void {
	sharedClient = undefined;
}
