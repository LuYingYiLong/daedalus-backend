import { getApprovalMode } from "../approval-settings-store.js";
import type { ApprovalMode } from "../tools/tool-policy.js";
import type { ClientSession } from "./client-session.js";

/** Scheduled runs retain their reviewed policy; interactive sessions use the global preference. */
export async function synchronizeSessionApprovalMode(session: ClientSession): Promise<ApprovalMode> {
	if (session.scheduledTaskOrigin !== undefined) {
		const scheduledMode: ApprovalMode = session.scheduledTaskOrigin.executionPolicy === "auto_safe" ? "auto-safe" : "manual";
		session.approvalGateway.setMode(scheduledMode);
		return scheduledMode;
	}
	const mode: ApprovalMode = await getApprovalMode();
	session.approvalGateway.setMode(mode);
	return mode;
}
