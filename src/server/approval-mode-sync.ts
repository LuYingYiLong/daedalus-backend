import { getApprovalMode } from "../approval-settings-store.js";
import type { ApprovalMode } from "../tools/tool-policy.js";
import type { ClientSession } from "./client-session.js";

/**
 * Approval mode is a global safety preference. Session metadata may retain an
 * older UI value, but must never override the current runtime policy.
 */
export async function synchronizeSessionApprovalMode(session: ClientSession): Promise<ApprovalMode> {
	const mode: ApprovalMode = await getApprovalMode();
	session.approvalGateway.setMode(mode);
	return mode;
}
