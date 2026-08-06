import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { getSessionDir } from "../session/session-store.js";
import { getSessionDatabase, parseSqlJson, sqlJson } from "../session/session-database.js";

const PLAN_ID_PATTERN: RegExp = /^plan-[a-zA-Z0-9_-]+$/;

export type PlanStatus = "clarification_required" | "ready" | "approved" | "executing";

export type PlanRecommendedReply = {
	label: string;
	text: string;
	description?: string | undefined;
};

export type PlanSkippedClarification = {
	question: string;
	skippedAt: string;
};

export type StoredPlanMetadata = {
	schemaVersion: 1;
	planId: string;
	sessionId: string;
	requestId: string;
	status: PlanStatus;
	title: string;
	originalMessage: string;
	previewMarkdown: string;
	clarificationQuestion?: string | undefined;
	recommendedReplies?: PlanRecommendedReply[] | undefined;
	clarifications: string[];
	skippedClarifications: PlanSkippedClarification[];
	revisions: string[];
	createdAt: string;
	updatedAt: string;
	approvedAt?: string | undefined;
	executedRequestId?: string | undefined;
	planPath: string;
};

export type StoredPlan = {
	metadata: StoredPlanMetadata;
	markdown: string;
};

function assertSafePlanId(planId: string): string {
	if (!PLAN_ID_PATTERN.test(planId)) {
		throw new Error(`Invalid plan id: ${planId}`);
	}
	return planId;
}

export function createPlanId(): string {
	return `plan-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function getPlanDir(sessionId: string, planId: string): string {
	return path.join(getSessionDir(sessionId), "plans", assertSafePlanId(planId));
}

export function createPlanMetadata(params: {
	sessionId: string;
	requestId: string;
	status: PlanStatus;
	title: string;
	originalMessage: string;
	previewMarkdown?: string | undefined;
	clarificationQuestion?: string | undefined;
	recommendedReplies?: PlanRecommendedReply[] | undefined;
	clarifications?: string[] | undefined;
	skippedClarifications?: PlanSkippedClarification[] | undefined;
	revisions?: string[] | undefined;
	now?: string | undefined;
}): StoredPlanMetadata {
	const planId: string = createPlanId();
	const timestamp: string = params.now ?? new Date().toISOString();
	return {
		schemaVersion: 1,
		planId,
		sessionId: params.sessionId,
		requestId: params.requestId,
		status: params.status,
		title: params.title,
		originalMessage: params.originalMessage,
		previewMarkdown: params.previewMarkdown ?? "",
		clarificationQuestion: params.clarificationQuestion,
		recommendedReplies: params.recommendedReplies,
		clarifications: params.clarifications ?? [],
		skippedClarifications: params.skippedClarifications ?? [],
		revisions: params.revisions ?? [],
		createdAt: timestamp,
		updatedAt: timestamp,
		planPath: `plans/${planId}/PLAN.md`
	};
}

export async function writeStoredPlan(metadata: StoredPlanMetadata, markdown: string): Promise<StoredPlan> {
	const db = await getSessionDatabase();
	db.prepare(`
		INSERT INTO plans(plan_id, session_id, request_id, status, metadata_json, markdown, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(plan_id) DO UPDATE SET
			request_id = excluded.request_id,
			status = excluded.status,
			metadata_json = excluded.metadata_json,
			markdown = excluded.markdown,
			updated_at = excluded.updated_at
	`).run(
		metadata.planId,
		metadata.sessionId,
		metadata.requestId,
		metadata.status,
		sqlJson(metadata),
		markdown,
		metadata.createdAt,
		metadata.updatedAt
	);
	return {
		metadata,
		markdown
	};
}

export async function readStoredPlan(sessionId: string, planId: string): Promise<StoredPlan> {
	assertSafePlanId(planId);
	const row = (await getSessionDatabase()).prepare(`
		SELECT metadata_json, markdown FROM plans WHERE session_id = ? AND plan_id = ?
	`).get(sessionId, planId) as Record<string, unknown> | undefined;
	if (row === undefined) {
		throw new Error(`Plan not found: ${planId}`);
	}
	const parsedMetadata: StoredPlanMetadata = parseSqlJson<StoredPlanMetadata>(row.metadata_json);
	const metadata: StoredPlanMetadata = {
		...parsedMetadata,
		clarifications: Array.isArray(parsedMetadata.clarifications)
			? parsedMetadata.clarifications.filter((item: unknown): item is string => typeof item === "string")
			: [],
		skippedClarifications: Array.isArray(parsedMetadata.skippedClarifications)
			? parsedMetadata.skippedClarifications.filter((item: unknown): item is PlanSkippedClarification => (
				typeof item === "object"
				&& item !== null
				&& typeof (item as Record<string, unknown>).question === "string"
				&& typeof (item as Record<string, unknown>).skippedAt === "string"
			))
			: [],
		revisions: Array.isArray(parsedMetadata.revisions)
			? parsedMetadata.revisions.filter((item: unknown): item is string => typeof item === "string")
			: []
	};
	if (metadata.sessionId !== sessionId || metadata.planId !== planId) {
		throw new Error("Plan metadata does not match requested session or plan id.");
	}
	return {
		metadata,
		markdown: String(row.markdown)
	};
}

export async function updateStoredPlan(
	sessionId: string,
	planId: string,
	update: (plan: StoredPlan) => StoredPlan | Promise<StoredPlan>
): Promise<StoredPlan> {
	const current: StoredPlan = await readStoredPlan(sessionId, planId);
	const next: StoredPlan = await update(current);
	const updatedMetadata: StoredPlanMetadata = {
		...next.metadata,
		updatedAt: new Date().toISOString()
	};
	return writeStoredPlan(updatedMetadata, next.markdown);
}

export function createPlanEventPayload(plan: StoredPlan): Record<string, unknown> {
	return {
		planId: plan.metadata.planId,
		sessionId: plan.metadata.sessionId,
		requestId: plan.metadata.requestId,
		status: plan.metadata.status,
		title: plan.metadata.title,
		previewMarkdown: plan.metadata.previewMarkdown,
		question: plan.metadata.clarificationQuestion ?? "",
		recommendedReplies: plan.metadata.recommendedReplies ?? [],
		createdAt: plan.metadata.createdAt,
		updatedAt: plan.metadata.updatedAt
	};
}

export function createPlanGetResult(plan: StoredPlan): Record<string, unknown> {
	return {
		...createPlanEventPayload(plan),
		markdown: plan.markdown,
		metadata: plan.metadata
	};
}
