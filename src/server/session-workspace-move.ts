import type { AdditionalContextItem } from "../protocol/types.js";
import type { ClientSession } from "./client-session.js";
import { hasOtherInFlightRequest } from "./request-lifecycle.js";

const WORKSPACE_BOUND_CONTEXT_KINDS: ReadonlySet<AdditionalContextItem["kind"]> = new Set([
	"editor_selection",
	"scene",
	"node",
	"file",
	"folder",
	"script",
	"script_selection",
	"filesystem_selection",
	"git_diff_comment",
	"file_selection"
]);

export function createSessionWorkspaceMoveError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

export function assertSessionWorkspaceMoveAllowed(
	runtime: ClientSession | undefined,
	currentRequestId: string
): void {
	if (runtime === undefined) {
		return;
	}
	const busy: boolean =
		hasOtherInFlightRequest(runtime, currentRequestId)
		|| runtime.activeAbortControllers.size > 0
		|| runtime.pendingGuides.length > 0
		|| runtime.queuedMessages.length > 0
		|| runtime.messageQueueDrainActive
		|| runtime.activeRunRequestId !== undefined
		|| runtime.workbenchActiveRun.status !== "idle"
		|| runtime.approvalGateway.listPending().length > 0
		|| runtime.pendingAiContinuations.size > 0
		|| runtime.pendingToolBudgets.size > 0
		|| runtime.nextStepHintAbortController !== undefined;
	if (busy) {
		throw createSessionWorkspaceMoveError(
			"session_workspace_move_busy",
			"Wait for the session to become idle before moving it to another project."
		);
	}
	if (runtime.workbenchComposer.additionalContext.some(
		(item: AdditionalContextItem): boolean => WORKSPACE_BOUND_CONTEXT_KINDS.has(item.kind)
	)) {
		throw createSessionWorkspaceMoveError(
			"session_workspace_context_pending",
			"Remove workspace file context from the Composer before moving this session."
		);
	}
}
