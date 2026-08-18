import { hookRuntime } from "../hooks/runtime.js";
import type { HookDecision, HookRuntimeEvent } from "../hooks/types.js";
import { logger } from "../logger.js";
import { getProviderDefaultModel } from "../providers/provider-registry.js";
import type { ClientSession } from "./client-session.js";

export type HookEventSink = (event: HookRuntimeEvent) => void;

function getModel(session: ClientSession): string {
	return session.providerModel ?? session.modelProfile.model ?? getProviderDefaultModel(session.activeProvider);
}

function addDeveloperContext(session: ClientSession, value: string | undefined): void {
	if (value === undefined || value.trim().length === 0) return;
	session.hookDeveloperContext.push(value);
	if (session.hookDeveloperContext.length > 32) session.hookDeveloperContext.splice(0, session.hookDeveloperContext.length - 32);
}

function logHookMessages(session: ClientSession, event: string, decision: HookDecision): void {
	for (const message of decision.systemMessages) {
		logger.warn("hooks", "system_message", { event, sessionId: session.sessionId, message });
	}
}

export async function runSessionStartHooks(
	session: ClientSession,
	source: "startup" | "resume" | "clear" | "compact",
	turnId?: string | undefined,
	onEvent?: HookEventSink | undefined
): Promise<HookDecision> {
	const decision: HookDecision = await hookRuntime.run({
		event: "SessionStart",
		matcherValue: source,
		input: { source },
		sessionId: session.sessionId ?? `temporary:${turnId ?? "unknown"}`,
		turnId,
		model: getModel(session),
		approvalMode: session.approvalGateway.getMode(),
		chatMode: session.workbenchComposer.chatMode,
		workspace: session.activeWorkspace
	}, onEvent);
	addDeveloperContext(session, decision.additionalContext);
	logHookMessages(session, "SessionStart", decision);
	return decision;
}

export async function runSessionEndHooks(
	session: ClientSession,
	reason: "archive" | "delete" | "shutdown" | "idle" | "other",
	turnId?: string | undefined,
	onEvent?: HookEventSink | undefined
): Promise<HookDecision> {
	const decision: HookDecision = await hookRuntime.run({
		event: "SessionEnd",
		matcherValue: "other",
		input: { reason: "other", daedalus_end_reason: reason },
		sessionId: session.sessionId ?? `temporary:${turnId ?? "unknown"}`,
		turnId,
		model: getModel(session),
		approvalMode: session.approvalGateway.getMode(),
		chatMode: session.workbenchComposer.chatMode,
		workspace: session.activeWorkspace
	}, onEvent);
	logHookMessages(session, "SessionEnd", decision);
	return decision;
}

export async function runUserPromptSubmitHooks(
	session: ClientSession,
	turnId: string,
	prompt: string,
	onEvent?: HookEventSink | undefined
): Promise<HookDecision> {
	const decision: HookDecision = await hookRuntime.run({
		event: "UserPromptSubmit",
		input: { prompt },
		sessionId: session.sessionId ?? `temporary:${turnId}`,
		turnId,
		model: getModel(session),
		approvalMode: session.approvalGateway.getMode(),
		chatMode: session.workbenchComposer.chatMode,
		workspace: session.activeWorkspace
	}, onEvent);
	addDeveloperContext(session, decision.additionalContext);
	logHookMessages(session, "UserPromptSubmit", decision);
	return decision;
}

export async function runCompactHooks(
	session: ClientSession,
	event: "PreCompact" | "PostCompact",
	trigger: "manual" | "auto",
	turnId: string,
	abortSignal?: AbortSignal | undefined,
	onEvent?: HookEventSink | undefined
): Promise<HookDecision> {
	const decision: HookDecision = await hookRuntime.run({
		event,
		matcherValue: trigger,
		input: { trigger },
		sessionId: session.sessionId ?? `temporary:${turnId}`,
		turnId,
		model: getModel(session),
		approvalMode: session.approvalGateway.getMode(),
		chatMode: session.workbenchComposer.chatMode,
		workspace: session.activeWorkspace,
		abortSignal
	}, onEvent);
	addDeveloperContext(session, decision.additionalContext);
	logHookMessages(session, event, decision);
	return decision;
}

export function consumeHookDeveloperContext(session: ClientSession): string {
	const values: string[] = [
		...session.hookDeveloperContext,
		hookRuntime.consumeAdditionalContext(session.sessionId ?? "")
	].filter((value: string): boolean => value.trim().length > 0);
	session.hookDeveloperContext = [];
	return values.join("\n\n");
}
