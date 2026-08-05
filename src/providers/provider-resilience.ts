import { randomUUID } from "node:crypto";
import type { OnToolEvent, ToolEvent } from "../tools/tool-dispatcher.js";
import { logger } from "../logger.js";
import type {
	ProviderChatOptions,
	ProviderReconnectEvent,
	ProviderReconnectReason
} from "./provider-types.js";

/** A half-open provider stream must not keep the Studio spinner running for a minute. */
export const PROVIDER_INACTIVITY_TIMEOUT_MS: number = 30_000;
/** Surface a pending reconnect before aborting the silent request. */
export const PROVIDER_STALL_WARNING_MS: number = 12_000;
export const PROVIDER_RECONNECT_ATTEMPTS: 5 = 5;
export const PROVIDER_EXTENDED_RECONNECT_ATTEMPTS: 15 = 15;

const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const GATEWAY_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
const PERMANENT_HTTP_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 407, 422]);
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET"
]);
const TRANSIENT_ERROR_NAMES: ReadonlySet<string> = new Set([
	"APICONNECTIONERROR",
	"APICONNECTIONTIMEOUTERROR",
	"CONNECTIONERROR",
	"CONNECTIONTIMEOUTERROR"
]);
const PERMANENT_TLS_ERROR_CODES: ReadonlySet<string> = new Set([
	"CERT_EXPIRED",
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);
const TRANSIENT_MESSAGE_PATTERN: RegExp = /\bterminated\b|socket hang up|premature(?:ly)? closed|other side closed|network connection was lost|connection reset|connection closed|(?:connection|request|connect|body|headers) timed? ?out|fetch failed/iu;
const QUOTA_MESSAGE_PATTERN: RegExp = /insufficient[_ -]?(quota|balance|credits?)|quota[_ -]?exceeded|payment required|not enough balance/iu;

export class ProviderIdleTimeoutError extends Error {
	public constructor(timeoutMs: number = PROVIDER_INACTIVITY_TIMEOUT_MS) {
		super(`The provider stream produced no activity for ${timeoutMs}ms.`);
		this.name = "ProviderIdleTimeoutError";
	}
}

export class ProviderIncompleteStreamError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "ProviderIncompleteStreamError";
	}
}

export class ProviderHttpError extends Error {
	public readonly status: number;
	public readonly headers: Headers | Readonly<Record<string, string>> | undefined;

	public constructor(message: string, status: number, headers?: Headers | Readonly<Record<string, string>> | undefined) {
		super(message);
		this.name = "ProviderHttpError";
		this.status = status;
		this.headers = headers;
	}
}

export class ProviderConnectionInterruptedError extends Error {
	public readonly code: string = "provider_connection_interrupted";

	public constructor(cause: unknown) {
		super("The connection to the model provider was interrupted after all automatic reconnect attempts.", { cause });
		this.name = "ProviderConnectionInterruptedError";
	}
}

export type ProviderRetryClassification = {
	retryable: boolean;
	reason: ProviderReconnectReason;
	extensionEligible: boolean;
	retryAfterMs?: number | undefined;
};

type AttemptOutputCounters = {
	messageCodePoints: number;
	thinkingCodePoints: number;
};

export type ProviderAttemptContext = {
	signal: AbortSignal;
	markActivity: () => void;
	onEvent: OnToolEvent | undefined;
};

export type ProviderResilienceOptions<T> = {
	providerOptions: ProviderChatOptions;
	onEvent?: OnToolEvent | undefined;
	abortSignal?: AbortSignal | undefined;
	execute: (context: ProviderAttemptContext) => Promise<T>;
	inactivityTimeoutMs?: number | undefined;
	stallWarningMs?: number | undefined;
	random?: (() => number) | undefined;
	now?: (() => number) | undefined;
	sleep?: ((milliseconds: number, signal?: AbortSignal | undefined) => Promise<void>) | undefined;
	reconnectId?: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectErrorSignals(error: unknown, values: string[], seen: Set<object>, depth: number = 0): void {
	if (depth > 7 || error === null || error === undefined) return;
	if (typeof error === "string") {
		values.push(error);
		return;
	}
	if (!isRecord(error) || seen.has(error)) return;
	seen.add(error);
	for (const value of [error.name, error.code, error.message]) {
		if (typeof value === "string" && value.length > 0) values.push(value);
	}
	collectErrorSignals(error.cause, values, seen, depth + 1);
}

function getErrorStatus(error: unknown): number | undefined {
	if (!isRecord(error)) return undefined;
	for (const value of [error.status, error.statusCode]) {
		if (typeof value === "number" && Number.isInteger(value)) return value;
	}
	return undefined;
}

function getHeaderValue(headers: unknown, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (!isRecord(headers)) return undefined;
	const direct: unknown = headers[name] ?? headers[name.toLowerCase()];
	return typeof direct === "string" ? direct : undefined;
}

function parseRetryAfterMs(error: unknown, now: number): number | undefined {
	if (!isRecord(error)) return undefined;
	const raw: string | undefined = getHeaderValue(error.headers, "retry-after");
	if (raw === undefined) return undefined;
	const seconds: number = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.round(seconds * 1000));
	const retryAt: number = Date.parse(raw);
	return Number.isFinite(retryAt) ? Math.min(60_000, Math.max(0, retryAt - now)) : undefined;
}

function isAbortError(error: unknown): boolean {
	if (!isRecord(error)) return false;
	return error.name === "AbortError" || error.code === "ABORT_ERR";
}

export function classifyProviderRetry(error: unknown, now: number = Date.now()): ProviderRetryClassification {
	if (error instanceof ProviderIdleTimeoutError) {
		return { retryable: true, reason: "idle_timeout", extensionEligible: true };
	}
	if (error instanceof ProviderIncompleteStreamError) {
		return { retryable: true, reason: "transport", extensionEligible: true };
	}

	const status: number | undefined = getErrorStatus(error);
	const signals: string[] = [];
	collectErrorSignals(error, signals, new Set<object>());
	const normalizedSignals: string[] = signals.map((value: string): string => value.toUpperCase());
	const message: string = signals.join(" ");
	if (isAbortError(error) || /cancel(?:led)?|aborted/iu.test(message)) {
		return { retryable: false, reason: "transport", extensionEligible: false };
	}
	if (normalizedSignals.some((signal: string): boolean => PERMANENT_TLS_ERROR_CODES.has(signal))) {
		return { retryable: false, reason: "transport", extensionEligible: false };
	}
	if (status !== undefined && (PERMANENT_HTTP_STATUSES.has(status) || QUOTA_MESSAGE_PATTERN.test(message))) {
		return { retryable: false, reason: status === 402 ? "server" : "transport", extensionEligible: false };
	}
	if (status !== undefined && RETRYABLE_HTTP_STATUSES.has(status)) {
		const reason: ProviderReconnectReason = status === 429
			? "rate_limit"
			: GATEWAY_HTTP_STATUSES.has(status) ? "gateway" : "server";
		return {
			retryable: true,
			reason,
			extensionEligible: GATEWAY_HTTP_STATUSES.has(status),
			retryAfterMs: parseRetryAfterMs(error, now)
		};
	}
	if (
		normalizedSignals.some((signal: string): boolean => TRANSIENT_ERROR_CODES.has(signal) || TRANSIENT_ERROR_NAMES.has(signal))
		|| TRANSIENT_MESSAGE_PATTERN.test(message)
	) {
		return { retryable: true, reason: "transport", extensionEligible: true, retryAfterMs: parseRetryAfterMs(error, now) };
	}
	return { retryable: false, reason: "server", extensionEligible: false };
}

function countCodePoints(text: string): number {
	return Array.from(text).length;
}

function createAttemptEventForwarder(
	onEvent: OnToolEvent | undefined,
	counters: AttemptOutputCounters,
	markActivity: () => void,
	isActive: () => boolean
): OnToolEvent | undefined {
	if (onEvent === undefined) return undefined;
	return (event: ToolEvent): void => {
		if (!isActive()) return;
		markActivity();
		if (event.type === "ai.delta") counters.messageCodePoints += countCodePoints(event.text);
		if (event.type === "ai.thinking.delta") counters.thinkingCodePoints += countCodePoints(event.text);
		onEvent(event);
	};
}

function createAbortError(): Error {
	const error = new Error("Request cancelled");
	error.name = "AbortError";
	return error;
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal | undefined): Promise<void> {
	if (milliseconds <= 0) return;
	await new Promise<void>((resolve, reject): void => {
		const finish = (): void => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer: NodeJS.Timeout = setTimeout(finish, milliseconds);
		const abort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(createAbortError());
		};
		if (signal?.aborted === true) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function computeBackoffMs(attempt: number, random: () => number): number {
	const nominal: number = Math.min(15_000, 1000 * (2 ** Math.max(0, attempt - 1)));
	return Math.max(250, Math.round(nominal * (0.8 + random() * 0.4)));
}

function emitReconnectEvent(
	onEvent: OnToolEvent | undefined,
	base: Omit<ProviderReconnectEvent, "revision" | "status" | "attempt" | "maxAttempts" | "autoExtended" | "discardedMessageCodePoints" | "discardedThinkingCodePoints">,
	revision: number,
	status: ProviderReconnectEvent["status"],
	attempt: number,
	maxAttempts: 5 | 15,
	autoExtended: boolean,
	counters: AttemptOutputCounters,
	retryAt?: string | undefined
): void {
	if (onEvent === undefined) return;
	onEvent({
		type: "provider.reconnect",
		...base,
		revision,
		status,
		attempt,
		maxAttempts,
		autoExtended,
		discardedMessageCodePoints: counters.messageCodePoints,
		discardedThinkingCodePoints: counters.thinkingCodePoints,
		...(retryAt === undefined ? {} : { retryAt })
	});
}

export async function runProviderRequestWithResilience<T>(options: ProviderResilienceOptions<T>): Promise<T> {
	const inactivityTimeoutMs: number = options.inactivityTimeoutMs ?? PROVIDER_INACTIVITY_TIMEOUT_MS;
	const configuredStallWarningMs: number = options.stallWarningMs ?? PROVIDER_STALL_WARNING_MS;
	const stallWarningMs: number = Math.max(1, Math.min(configuredStallWarningMs, Math.max(1, inactivityTimeoutMs - 1)));
	const random: () => number = options.random ?? Math.random;
	const now: () => number = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const reconnectId: string = options.reconnectId ?? `provider-reconnect-${randomUUID()}`;
	let currentAttempt: number = 0;
	let maxAttempts: 5 | 15 = PROVIDER_RECONNECT_ATTEMPTS;
	let autoExtended: boolean = false;
	let revision: number = 0;
	let lastReason: ProviderReconnectReason = "transport";

	while (true) {
		if (options.abortSignal?.aborted === true) throw createAbortError();
		const attemptController = new AbortController();
		let attemptActive: boolean = true;
		let inactivityTimer: NodeJS.Timeout | undefined;
		let stallWarningTimer: NodeJS.Timeout | undefined;
		let stallWarningActive: boolean = false;
		let timedOut: boolean = false;
		let rejectTimeout: ((reason: unknown) => void) | undefined;
		const counters: AttemptOutputCounters = { messageCodePoints: 0, thinkingCodePoints: 0 };
		const createReconnectBase = (): Omit<ProviderReconnectEvent, "revision" | "status" | "attempt" | "maxAttempts" | "autoExtended" | "discardedMessageCodePoints" | "discardedThinkingCodePoints"> => ({
			schemaVersion: 1,
			reconnectId,
			runId: "",
			stepRunId: "",
			provider: options.providerOptions.provider,
			model: options.providerOptions.model ?? options.providerOptions.modelProfile?.model ?? "",
			reason: "idle_timeout",
			timeoutMs: inactivityTimeoutMs
		});
		const clearStallWarningTimer = (): void => {
			if (stallWarningTimer !== undefined) {
				clearTimeout(stallWarningTimer);
				stallWarningTimer = undefined;
			}
		};
		const scheduleStallWarning = (): void => {
			clearStallWarningTimer();
			if (!attemptActive || stallWarningActive) return;
			stallWarningTimer = setTimeout((): void => {
				if (!attemptActive || stallWarningActive) return;
				stallWarningTimer = undefined;
				stallWarningActive = true;
				revision += 1;
				emitReconnectEvent(
					options.onEvent,
					createReconnectBase(),
					revision,
					"waiting",
					currentAttempt + 1,
					maxAttempts,
					autoExtended,
					counters,
					new Date(now() + Math.max(0, inactivityTimeoutMs - stallWarningMs)).toISOString()
				);
			}, stallWarningMs);
		};
		const resetWatchdog = (): void => {
			if (!attemptActive) return;
			if (stallWarningActive) {
				stallWarningActive = false;
				revision += 1;
				emitReconnectEvent(options.onEvent, createReconnectBase(), revision, "recovered", currentAttempt, maxAttempts, autoExtended, {
					messageCodePoints: 0,
					thinkingCodePoints: 0
				});
			}
			if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
			inactivityTimer = setTimeout((): void => {
				timedOut = true;
				const timeoutError = new ProviderIdleTimeoutError(inactivityTimeoutMs);
				attemptController.abort(timeoutError);
				rejectTimeout?.(timeoutError);
			}, inactivityTimeoutMs);
			scheduleStallWarning();
		};
		const abortAttempt = (): void => {
			const abortError: unknown = options.abortSignal?.reason ?? createAbortError();
			attemptController.abort(abortError);
			rejectTimeout?.(abortError);
		};
		const clearAttemptResources = (): void => {
			attemptActive = false;
			if (inactivityTimer !== undefined) {
				clearTimeout(inactivityTimer);
				inactivityTimer = undefined;
			}
			clearStallWarningTimer();
			options.abortSignal?.removeEventListener("abort", abortAttempt);
			rejectTimeout = undefined;
		};
		options.abortSignal?.addEventListener("abort", abortAttempt, { once: true });
		resetWatchdog();
		const timeoutPromise = new Promise<never>((_resolve, reject): void => { rejectTimeout = reject; });
		const attemptEvent = createAttemptEventForwarder(options.onEvent, counters, resetWatchdog, (): boolean => attemptActive);

		try {
			const result: T = await Promise.race([
				options.execute({ signal: attemptController.signal, markActivity: resetWatchdog, onEvent: attemptEvent }),
				timeoutPromise
			]);
			if (currentAttempt > 0) {
				revision += 1;
				emitReconnectEvent(options.onEvent, {
					schemaVersion: 1,
					reconnectId,
					runId: "",
					stepRunId: "",
					provider: options.providerOptions.provider,
					model: options.providerOptions.model ?? options.providerOptions.modelProfile?.model ?? "",
					reason: lastReason,
					timeoutMs: inactivityTimeoutMs
				}, revision, "recovered", currentAttempt, maxAttempts, autoExtended, { messageCodePoints: 0, thinkingCodePoints: 0 });
			}
			return result;
		} catch (caught: unknown) {
			clearAttemptResources();
			const error: unknown = timedOut ? new ProviderIdleTimeoutError(inactivityTimeoutMs) : caught;
			if (Boolean(options.abortSignal?.aborted)) throw createAbortError();
			const classification: ProviderRetryClassification = classifyProviderRetry(error, now());
			lastReason = classification.reason;
			if (!classification.retryable) {
				if (currentAttempt > 0) {
					revision += 1;
					emitReconnectEvent(options.onEvent, {
						schemaVersion: 1, reconnectId, runId: "", stepRunId: "",
						provider: options.providerOptions.provider,
						model: options.providerOptions.model ?? options.providerOptions.modelProfile?.model ?? "",
						reason: classification.reason, timeoutMs: inactivityTimeoutMs
					}, revision, "failed", currentAttempt, maxAttempts, autoExtended, counters);
				}
				throw error;
			}

			if (currentAttempt >= maxAttempts && maxAttempts === PROVIDER_RECONNECT_ATTEMPTS && classification.extensionEligible) {
				maxAttempts = PROVIDER_EXTENDED_RECONNECT_ATTEMPTS;
				autoExtended = true;
			}
			if (currentAttempt >= maxAttempts) {
				revision += 1;
				emitReconnectEvent(options.onEvent, {
					schemaVersion: 1, reconnectId, runId: "", stepRunId: "",
					provider: options.providerOptions.provider,
					model: options.providerOptions.model ?? options.providerOptions.modelProfile?.model ?? "",
					reason: classification.reason, timeoutMs: inactivityTimeoutMs
				}, revision, "failed", currentAttempt, maxAttempts, autoExtended, counters);
				throw new ProviderConnectionInterruptedError(error);
			}

			const nextAttempt: number = currentAttempt + 1;
			const delayMs: number = classification.retryAfterMs ?? computeBackoffMs(nextAttempt, random);
			const retryAt: string = new Date(now() + delayMs).toISOString();
			revision += 1;
			emitReconnectEvent(options.onEvent, {
				schemaVersion: 1, reconnectId, runId: "", stepRunId: "",
				provider: options.providerOptions.provider,
				model: options.providerOptions.model ?? options.providerOptions.modelProfile?.model ?? "",
				reason: classification.reason, timeoutMs: inactivityTimeoutMs
			}, revision, "waiting", nextAttempt, maxAttempts, autoExtended, counters, retryAt);
			logger.warn("provider", "provider_reconnect_waiting", {
				provider: options.providerOptions.provider,
				model: options.providerOptions.model ?? options.providerOptions.modelProfile?.model,
				attempt: nextAttempt,
				maxAttempts,
				reason: classification.reason,
				delayMs,
				discardedMessageCodePoints: counters.messageCodePoints,
				discardedThinkingCodePoints: counters.thinkingCodePoints
			});
			await sleep(delayMs, options.abortSignal);
			currentAttempt = nextAttempt;
			revision += 1;
			emitReconnectEvent(options.onEvent, {
				schemaVersion: 1, reconnectId, runId: "", stepRunId: "",
				provider: options.providerOptions.provider,
				model: options.providerOptions.model ?? options.providerOptions.modelProfile?.model ?? "",
				reason: classification.reason, timeoutMs: inactivityTimeoutMs
			}, revision, "reconnecting", currentAttempt, maxAttempts, autoExtended, { messageCodePoints: 0, thinkingCodePoints: 0 });
		} finally {
			clearAttemptResources();
		}
	}
}
