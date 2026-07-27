import type { SessionMetadata } from "../session/session-store.js";
import type { ClientSession } from "./client-session.js";

export function createRuntimeSessionUiMetadata(session: ClientSession): Partial<SessionMetadata> {
	const approvalMode = session.approvalGateway.getMode();

	return {
		provider: session.activeProvider,
		model: session.providerModel ?? session.modelProfile.model,
		reasoningEffort: session.workbenchComposer.reasoningEffort,
		chatMode: session.workbenchComposer.chatMode,
		approvalMode: approvalMode === "manual" || approvalMode === "auto-safe" || approvalMode === "full-trust" ? approvalMode : undefined
	};
}
