import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import WebSocketDefault from "ws";
import type { ServerEvent } from "../../protocol/types.js";
import { sendJson } from "../../server/send-json.js";
import type { PluginRecord } from "../types.js";

const REVIEW_TIMEOUT_MS: number = 10 * 60 * 1000;

type PendingReview = {
	reviewId: string;
	socket: WebSocket;
	sessionId: string;
	pluginId: string;
	fingerprint: string;
	timer: NodeJS.Timeout;
	resolve: (status: "trusted" | "deferred") => void;
	reject: (error: Error) => void;
	resolving: boolean;
	abortCleanup?: (() => void) | undefined;
};

export class PluginDevelopmentReviewRuntime {
	private readonly pending = new Map<string, PendingReview>();

	request(
		socket: WebSocket,
		sessionId: string,
		plugin: PluginRecord,
		revision: string,
		testCaseCount: number,
		abortSignal?: AbortSignal
	): Promise<{ reviewId: string; status: "trusted" | "deferred" }> {
		if (socket.readyState !== WebSocketDefault.OPEN) return Promise.reject(new Error("plugin_review_studio_unavailable"));
		if (abortSignal?.aborted) return Promise.reject(new Error("plugin_review_cancelled"));
		const reviewId = `plugin-review-${randomUUID()}`;
		return new Promise((resolve, reject): void => {
			const timer = setTimeout((): void => {
				const pending = this.pending.get(reviewId);
				if (pending !== undefined) this.rejectPending(pending, new Error("plugin_review_timeout"));
			}, REVIEW_TIMEOUT_MS);
			const pending: PendingReview = {
				reviewId,
				socket,
				sessionId,
				pluginId: plugin.id,
				fingerprint: plugin.fingerprint,
				timer,
				resolve: (status): void => resolve({ reviewId, status }),
				reject,
				resolving: false
			};
			if (abortSignal !== undefined) {
				const onAbort = (): void => this.rejectPending(pending, new Error("plugin_review_cancelled"));
				abortSignal.addEventListener("abort", onAbort, { once: true });
				pending.abortCleanup = (): void => abortSignal.removeEventListener("abort", onAbort);
			}
			this.pending.set(reviewId, pending);
			sendJson(socket, this.event("plugin.review.request", sessionId, reviewId, {
				reviewId,
				sessionId,
				pluginId: plugin.id,
				fingerprint: plugin.fingerprint,
				packageName: plugin.packageName,
				version: plugin.version,
				revision,
				testCaseCount,
				origin: "plugin_creator"
			}));
		});
	}

	resolve(reviewId: string, pluginId: string, fingerprint: string, status: "trusted" | "deferred"): void {
		const pending = this.getPending(reviewId, pluginId, fingerprint, true);
		this.removePending(pending);
		pending.resolve(status);
		if (pending.socket.readyState === WebSocketDefault.OPEN) sendJson(pending.socket, this.event("plugin.review.resolved", pending.sessionId, reviewId, { reviewId, pluginId, status }));
	}

	assertPending(reviewId: string, pluginId: string, fingerprint: string): void {
		this.getPending(reviewId, pluginId, fingerprint);
	}

	claim(reviewId: string, pluginId: string, fingerprint: string): void {
		const pending = this.getPending(reviewId, pluginId, fingerprint);
		pending.resolving = true;
		clearTimeout(pending.timer);
		pending.abortCleanup?.();
		pending.abortCleanup = undefined;
	}

	rejectClaim(reviewId: string, pluginId: string, fingerprint: string, error: Error): void {
		const pending = this.getPending(reviewId, pluginId, fingerprint, true);
		this.rejectPending(pending, error);
	}

	detachSocket(socket: WebSocket): void {
		for (const pending of [...this.pending.values()]) if (pending.socket === socket && !pending.resolving) this.rejectPending(pending, new Error("plugin_review_studio_disconnected"));
	}

	private event(event: "plugin.review.request" | "plugin.review.resolved", sessionId: string, reviewId: string, data: Record<string, unknown>): ServerEvent {
		return { protocolVersion: 3, type: "event", eventId: `${event}:${reviewId}`, event, sessionId, requestId: reviewId, runId: reviewId, sequence: Date.now() * 1000, createdAt: new Date().toISOString(), data };
	}

	private rejectPending(pending: PendingReview, error: Error): void {
		this.removePending(pending);
		pending.reject(error);
	}

	private getPending(reviewId: string, pluginId: string, fingerprint: string, allowResolving: boolean = false): PendingReview {
		const pending = this.pending.get(reviewId);
		if (pending === undefined) throw Object.assign(new Error("Plugin review is no longer pending."), { code: "plugin_review_not_found" });
		if (pending.pluginId !== pluginId || pending.fingerprint !== fingerprint) throw Object.assign(new Error("Plugin review does not match the installed package."), { code: "plugin_review_mismatch" });
		if (pending.resolving && !allowResolving) throw Object.assign(new Error("Plugin review is already being resolved."), { code: "plugin_review_resolving" });
		return pending;
	}

	private removePending(pending: PendingReview): void {
		clearTimeout(pending.timer);
		pending.abortCleanup?.();
		this.pending.delete(pending.reviewId);
	}
}

export const pluginDevelopmentReviewRuntime = new PluginDevelopmentReviewRuntime();
