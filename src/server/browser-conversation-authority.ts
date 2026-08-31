import { randomUUID } from "node:crypto";
import {
	browserConnectArgsSchema,
	browserConsentSchema,
	browserExecuteArgsSchema,
	browserProposalArgsSchema,
	browserUrlsFromUserMessage,
	normalizeBrowserUrl,
	EXTERNAL_BROWSER_READ_TOOLS,
	type BrowserConsent,
	type BrowserProposal,
	type BrowserScope,
} from "../protocol/external-browser.js";

type Forward = (
	operation: string,
	args: Record<string, unknown>,
	scope: BrowserScope,
	signal?: AbortSignal,
) => Promise<Record<string, unknown>>;
type Turn = {
	scope: BrowserScope;
	urls: Set<string>;
	inputAllowed: boolean;
	signal: AbortSignal;
	finalReply?: string;
	approved?: { proposal: BrowserProposal; steps: Set<string> } | undefined;
	results: Map<string, Record<string, unknown>>;
	busy: boolean;
};
type Target = { scope: BrowserScope; url: string; observationId?: string };
export type BrowserAudit = {
	scope: BrowserScope;
	kind: string;
	proposalId?: string;
	stepId?: string;
	detail?: unknown;
	summary?: Record<string, unknown>;
};
const keyOf = (
	scope: Pick<BrowserScope, "connectionId" | "sessionId">,
): string => `${scope.connectionId}:${scope.sessionId}`;
function fail(code: string): never {
	throw Object.assign(new Error(code), { code, retryable: false });
}
function literal(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</gu, "\\u003c")
		.replace(/>/gu, "\\u003e");
}

export class BrowserConversationAuthority {
	private turns = new Map<string, Turn>();
	private proposals = new Map<string, BrowserProposal>();
	private targets = new Map<string, Target>();
	private seenMessages = new Set<string>();
	private discoveries = new Map<string, { urls: string[]; expires: number }>();
	constructor(
		private readonly audit: (
			event: BrowserAudit,
		) => Promise<void> = async () => {},
		private readonly now = Date.now,
	) {}
	async begin(
		scope: BrowserScope,
		message: string,
		inputAllowed: boolean,
		signal: AbortSignal,
		interpret: (proposal: string, reply: string) => Promise<BrowserConsent>,
		fresh = true,
	): Promise<string> {
		this.revokeSessionProposals(scope.sessionId, scope.connectionId);
		const key = keyOf(scope),
			messageKey = `${key}:${scope.requestId}`;
		this.turns.delete(key);
		if (!fresh || this.seenMessages.has(messageKey)) {
			this.proposals.delete(key);
			return "External browser access is not restored by retries or queued/replayed messages.";
		}
		this.seenMessages.add(messageKey);
		const turn: Turn = {
			scope,
			urls: new Set(browserUrlsFromUserMessage(message)),
			inputAllowed,
			signal,
			results: new Map(),
			busy: false,
		};
		const discovery = this.discoveries.get(key);
		this.discoveries.delete(key);
		if (discovery && discovery.expires > this.now())
			for (const url of discovery.urls) turn.urls.add(url);
		this.turns.set(key, turn);
		const proposal = this.proposals.get(key);
		if (!proposal) return "";
		this.proposals.delete(key);
		if (proposal.expiresAt <= this.now())
			return "The browser proposal expired. Inspect again and publish a new proposal before any write.";
		let consent: BrowserConsent;
		try {
			consent = browserConsentSchema.parse(
				await interpret(proposal.confirmation, message),
			);
		} catch {
			consent = { decision: "clarify", stepIds: [] };
		}
		signal.throwIfAborted();
		if (this.turns.get(key) !== turn) fail("browser_scope_stale");
		const requested = new Set(consent.stepIds),
			ids = proposal.steps.map((step) => step.id);
		const valid =
			requested.size === consent.stepIds.length &&
			requested.size > 0 &&
			[...requested].every((id) => ids.includes(id)) &&
			proposal.steps
				.filter((step) => requested.has(step.id))
				.every((step) => step.dependsOn.every((id) => requested.has(id))) &&
			(consent.decision === "approve_subset" ||
				(consent.decision === "approve_all" && requested.size === ids.length));
		if (valid && inputAllowed) turn.approved = { proposal, steps: requested };
		await this.audit({
			scope,
			kind: turn.approved ? "authorized" : "not_authorized",
			proposalId: proposal.proposalId,
			summary: {
				decision: consent.decision,
				steps: turn.approved ? [...requested] : [],
				sourceRequestId: proposal.scope.requestId,
			},
		});
		turn.urls.add(proposal.url);
		if (!turn.approved)
			return "No browser write was authorized. Explain or clarify conversationally; do not call execute_step. A new proposal is required for changes or expired consent.";
		// 确认仅授予当前运行，不能通过持久化历史或模型参数重建租约
		const target = this.targets.get(proposal.targetId);
		if (!target || keyOf(target.scope) !== key) {
			turn.approved = undefined;
			return "The browser connection was lost. Reconnect read-only and ask for a new confirmation.";
		}
		target.scope = scope;
		return `The user authorized ONLY these existing steps for this run. Use mcp_browser_execute_step, then observe the result. Proposal: ${literal({ proposalId: proposal.proposalId, targetId: proposal.targetId, steps: proposal.steps.filter((step) => requested.has(step.id)).map((step) => ({ id: step.id, action: step.action, dependsOn: step.dependsOn })) })}`;
	}
	revokeSessionProposals(sessionId: string, keepConnectionId?: string): void {
		for (const proposal of [...this.proposals.values()]) {
			const scope = proposal.scope;
			if (
				scope.sessionId === sessionId &&
				scope.connectionId !== keepConnectionId
			)
				this.revokePending(
					scope.connectionId,
					scope.sessionId,
					scope.runId,
					scope.generation,
				);
		}
	}
	private turn(scope: BrowserScope): Turn {
		const turn = this.turns.get(keyOf(scope));
		if (
			!turn ||
			turn.scope.runId !== scope.runId ||
			turn.scope.requestId !== scope.requestId ||
			turn.scope.generation !== scope.generation ||
			turn.signal.aborted
		)
			fail("browser_scope_stale");
		if (turn.finalReply) fail("browser_confirmation_pending");
		return turn;
	}
	finalReply(scope: BrowserScope): string | undefined {
		return this.turns.get(keyOf(scope))?.scope.runId === scope.runId
			? this.turns.get(keyOf(scope))?.finalReply
			: undefined;
	}
	canExecute(scope: BrowserScope): boolean {
		try {
			const turn = this.turn(scope);
			return turn.inputAllowed && !!turn.approved;
		} catch {
			return false;
		}
	}
	async execute(
		scope: BrowserScope,
		tool: string,
		raw: Record<string, unknown>,
		forward: Forward,
	): Promise<Record<string, unknown>> {
		const turn = this.turn(scope);
		if (turn.busy) fail("browser_busy");
		turn.busy = true;
		const send = async (
			operation: string,
			args: Record<string, unknown>,
		): Promise<Record<string, unknown>> => {
			this.turn(scope);
			const result = await forward(operation, args, scope, turn.signal);
			this.turn(scope);
			return result;
		};
		try {
			if (tool === "mcp_browser_connect") {
				const args = browserConnectArgsSchema.parse(raw);
				if (!turn.urls.has(args.url)) fail("browser_url_not_authorized");
				const result = await send("connect", args);
				if (result.ambiguous === true)
					this.discoveries.set(keyOf(scope), {
						urls: [args.url],
						expires: this.now() + 600000,
					});
				if (typeof result.targetId === "string" && result.url === args.url)
					this.targets.set(result.targetId, { scope, url: args.url });
				return result;
			}
			if (EXTERNAL_BROWSER_READ_TOOLS.has(tool)) {
				const target = this.target(scope, raw.targetId);
				const result = await send(tool.slice("mcp_browser_".length), raw);
				if (
					result.url !== undefined &&
					normalizeBrowserUrl(String(result.url)) !== target.url
				)
					fail("browser_page_changed");
				if (
					(tool === "mcp_browser_observe" || tool === "mcp_browser_wait") &&
					typeof result.observationId === "string"
				)
					target.observationId = result.observationId;
				if (tool === "mcp_browser_scroll") delete target.observationId;
				await this.audit({
					scope,
					kind: "observed",
					detail: { ...result, dataUrl: undefined },
					summary: { tool },
				});
				return { ...result, untrustedEvidence: true };
			}
			if (tool === "mcp_browser_propose") {
				const args = browserProposalArgsSchema.parse(raw),
					target = this.target(scope, args.targetId);
				if (target.observationId !== args.observationId)
					fail("browser_observation_stale");
				const prepared = await send("prepare", args);
				const proposalId = `browser-proposal-${randomUUID()}`;
				const cn = /[\u3400-\u9fff]/u.test(args.title + args.summary);
				const confirmation = [
					cn
						? "已只读检查页面；尚未执行以下操作。"
						: "The page was inspected read-only. None of the following actions have been executed.",
					`${cn ? "页面" : "Page"}: ${literal(target.url)}`,
					`${cn ? "方案" : "Proposal"}: ${proposalId}`,
					...args.steps.map(
						(step) =>
							`- [${step.id}] ${step.action}: ${literal((prepared.labels as Record<string, string> | undefined)?.[step.id] ?? step.elementId)}${step.value !== undefined ? ` = ${literal(step.value)}` : step.checked !== undefined ? ` = ${step.checked}` : ""}; ${literal(step.description)}`,
					),
					`${cn ? "已观察到的影响" : "Observed effects"}: ${literal(prepared.effects ?? {})}`,
					`${cn ? "说明" : "Details"}: ${literal(args.summary)}`,
					cn
						? "填写可能触发网站自动保存。是否允许执行上述步骤？可以只批准其中一部分，例如“只填写，不提交”。"
						: "Filling may trigger website autosave. May I execute these steps? You can authorize a subset, for example filling without submitting.",
				].join("\n\n");
				const proposal: BrowserProposal = {
					...args,
					scope,
					url: target.url,
					proposalId,
					prepared,
					confirmation,
					createdAt: this.now(),
					expiresAt: this.now() + 600_000,
				};
				await this.audit({
					scope,
					kind: "proposed",
					proposalId,
					detail: {
						title: args.title,
						summary: args.summary,
						steps: args.steps,
						url: target.url,
						confirmation,
					},
					summary: { steps: args.steps.length, expiresAt: proposal.expiresAt },
				});
				this.turn(scope);
				this.proposals.set(keyOf(scope), proposal);
				turn.finalReply = confirmation;
				return { proposalId, confirmation, awaitingUser: true };
			}
			if (tool === "mcp_browser_execute_step") {
				const args = browserExecuteArgsSchema.parse(raw),
					grant = turn.approved;
				if (
					!turn.inputAllowed ||
					!grant ||
					grant.proposal.proposalId !== args.proposalId ||
					!grant.steps.has(args.stepId)
				)
					fail("browser_consent_required");
				const prior = turn.results.get(args.stepId);
				if (prior) return prior;
				const step = grant.proposal.steps.find(
					(step) => step.id === args.stepId,
				)!;
				if (
					step.dependsOn.some(
						(id) => turn.results.get(id)?.status !== "dispatched",
					)
				)
					fail("browser_step_order");
				this.target(scope, grant.proposal.targetId);
				const actionId = `${args.proposalId}:${args.stepId}`;
				await this.audit({
					scope,
					kind: "dispatching",
					proposalId: args.proposalId,
					stepId: args.stepId,
					summary: { actionId, action: step.action },
				});
				// 派发前登记 unknown，超时、崩溃和迟到结果不能导致重复点击
				turn.results.set(args.stepId, { actionId, status: "unknown" });
				let result: Record<string, unknown>;
				try {
					result = await send("execute", {
						targetId: grant.proposal.targetId,
						proposalId: args.proposalId,
						actionId,
						step,
						prepared: grant.proposal.prepared,
					});
				} catch {
					result = {
						actionId,
						status: "unknown",
						code: "browser_action_unconfirmed",
					};
				}
				if (
					!["dispatched", "not_dispatched", "unknown"].includes(
						String(result.status),
					)
				)
					result = { actionId, status: "unknown" };
				turn.results.set(args.stepId, result);
				await this.audit({
					scope,
					kind: "action_result",
					proposalId: args.proposalId,
					stepId: args.stepId,
					summary: { actionId, status: result.status },
				});
				if (result.status !== "dispatched") turn.approved = undefined;
				return result;
			}
			return fail("browser_external_tool_forbidden");
		} finally {
			turn.busy = false;
		}
	}
	private target(scope: BrowserScope, targetId: unknown): Target {
		if (typeof targetId !== "string") fail("browser_target_required");
		const target = this.targets.get(targetId);
		if (
			!target ||
			keyOf(target.scope) !== keyOf(scope) ||
			!this.turn(scope).urls.has(target.url)
		)
			fail("browser_target_not_authorized");
		return target;
	}
	finish(scope: BrowserScope, cancelled = false): void {
		const key = keyOf(scope),
			turn = this.turns.get(key);
		if (turn?.scope.runId !== scope.runId) return;
		this.turns.delete(key);
		if (cancelled || !turn.finalReply) this.proposals.delete(key);
		if (turn.approved)
			void this.audit({
				scope,
				kind: "revoked",
				proposalId: turn.approved.proposal.proposalId,
				summary: { reason: cancelled ? "cancelled" : "run_finished" },
			}).catch(() => {});
		if (cancelled) this.discoveries.delete(key);
		for (const [id, target] of this.targets)
			if (keyOf(target.scope) === key && !this.proposals.has(key))
				this.targets.delete(id);
	}
	revokePending(
		connectionId: string,
		sessionId: string,
		runId: string,
		generation: string,
	): void {
		const key = keyOf({ connectionId, sessionId }),
			proposal = this.proposals.get(key);
		if (
			!proposal ||
			proposal.scope.runId !== runId ||
			proposal.scope.generation !== generation
		)
			return;
		this.proposals.delete(key);
		this.targets.delete(proposal.targetId);
		void this.audit({
			scope: proposal.scope,
			kind: "revoked",
			proposalId: proposal.proposalId,
			summary: { reason: "target_disconnected" },
		}).catch(() => {});
	}

	revoke(connectionId: string, sessionId?: string): void {
		for (const key of this.discoveries.keys())
			if (
				key.startsWith(`${connectionId}:`) &&
				(!sessionId || key === `${connectionId}:${sessionId}`)
			)
				this.discoveries.delete(key);
		if (!sessionId)
			for (const message of this.seenMessages)
				if (message.startsWith(`${connectionId}:`))
					this.seenMessages.delete(message);
		for (const [key, turn] of this.turns)
			if (
				turn.scope.connectionId === connectionId &&
				(!sessionId || turn.scope.sessionId === sessionId)
			)
				this.turns.delete(key);
		for (const [key, proposal] of this.proposals)
			if (
				proposal.scope.connectionId === connectionId &&
				(!sessionId || proposal.scope.sessionId === sessionId)
			)
				this.proposals.delete(key);
		for (const [id, target] of this.targets)
			if (
				target.scope.connectionId === connectionId &&
				(!sessionId || target.scope.sessionId === sessionId)
			)
				this.targets.delete(id);
	}
}
