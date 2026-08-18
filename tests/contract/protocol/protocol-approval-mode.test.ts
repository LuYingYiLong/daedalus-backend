import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

function createApprovalModeRequest(mode: string, confirmationText?: string): Record<string, unknown> {
	return {
		type: "request",
		id: `approval-mode-${mode}`,
		method: "approval.mode.set",
		params: confirmationText === undefined ? { mode } : { mode, confirmationText }
	};
}

test("approval.mode.set accepts only public approval modes", (): void => {
	assert.equal(clientRequestSchema.safeParse(createApprovalModeRequest("manual")).success, true);
	assert.equal(clientRequestSchema.safeParse(createApprovalModeRequest("auto-safe")).success, true);
	assert.equal(clientRequestSchema.safeParse(createApprovalModeRequest("full-trust", "ENABLE FULL TRUST")).success, true);
	assert.equal(clientRequestSchema.safeParse(createApprovalModeRequest("read-only")).success, false);
});

test("approval.approve accepts consent text for cross-workspace approvals", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "approval-approve-consent",
		method: "approval.approve",
		params: {
			approvalId: "approval-123",
			consentText: "ALLOW CROSS-WORKSPACE: C:\\other-project"
		}
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "approval-approve-auto-safe",
		method: "approval.approve",
		params: {
			approvalId: "approval-123",
			enableAutoSafe: true
		}
	}).success, true);
});

test("plan.clarify has an explicit structured skip path", (): void => {
	const base = {
		type: "request",
		id: "plan-clarify-skip",
		method: "plan.clarify",
		params: { planId: "plan-123" }
	};
	assert.equal(clientRequestSchema.safeParse({ ...base, params: { ...base.params, skip: true } }).success, true);
	assert.equal(clientRequestSchema.safeParse({ ...base, params: { ...base.params, reply: "Use the existing API." } }).success, true);
	assert.equal(clientRequestSchema.safeParse(base).success, false);
});
