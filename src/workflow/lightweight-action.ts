import type { ToolEvent } from "../tools/tool-dispatcher.js";
import { applyToolEventToWorkflowObservations } from "./outcome.js";
import type { WorkflowToolObservation } from "./types.js";
import type { ExecutionDecision } from "./agent-run-state.js";

const ENVIRONMENT_APPLICABILITY_CODES: ReadonlySet<string> = new Set([
	"git_repository_missing",
	"package_manifest_missing",
	"typecheck_script_missing",
	"godot_project_missing",
	"godot_runtime_unavailable",
	"diagnostics_unavailable",
	"workspace_unavailable"
]);
const MAX_LIGHTWEIGHT_WRITE_CALLS: number = 2;

export type LightweightActionState = {
	observations: WorkflowToolObservation[];
};

export type LightweightActionCompletionStatus = {
	resultStatus: "completed" | "completed_with_warnings";
	verificationStatus: "verified" | "unverified";
	warnings: string[];
	failureMessage?: string | undefined;
};

export type LightweightActionEscalationReason =
	| "write_scope_exceeded"
	| "write_intent_not_completed";

export class LightweightActionScopeExceededError extends Error {
	readonly reason: LightweightActionEscalationReason;
	readonly executionDecision?: ExecutionDecision | undefined;

	constructor(
		reason: LightweightActionEscalationReason = "write_scope_exceeded",
		executionDecision?: ExecutionDecision | undefined
	) {
		super(reason === "write_scope_exceeded"
			? "轻量操作需要超过两个写入步骤，已升级为完整 Workflow。"
			: "轻量操作只完成了读取，没有完成用户要求的修改，已升级为完整 Workflow。");
		this.name = "LightweightActionScopeExceededError";
		this.reason = reason;
		this.executionDecision = executionDecision;
	}
}

export class LightweightActionVerificationError extends Error {
	readonly code: string = "lightweight_validation_failed";

	constructor(message: string) {
		super(message);
		this.name = "LightweightActionVerificationError";
	}
}

export function createLightweightActionState(
	observations: WorkflowToolObservation[] = []
): LightweightActionState {
	return {
		observations: observations.map(cloneObservation)
	};
}

export function cloneLightweightActionState(state: LightweightActionState): LightweightActionState {
	const rawObservations: unknown = (state as unknown as Record<string, unknown>)?.observations;
	if (!Array.isArray(rawObservations)) {
		return createLightweightActionState();
	}
	const observations: WorkflowToolObservation[] = rawObservations.filter(isWorkflowToolObservation);
	return createLightweightActionState(observations);
}

export function applyToolEventToLightweightActionState(
	state: LightweightActionState,
	event: ToolEvent,
	enforceWriteLimit: boolean = false
): void {
	if (enforceWriteLimit && event.type === "tool.call" && isWriteToolEvent(event)) {
		const completedOrActiveWriteIds: Set<string> = new Set(state.observations
			.filter(isWriteObservation)
			.map((observation: WorkflowToolObservation): string => observation.toolCallId));
		if (!completedOrActiveWriteIds.has(event.toolCallId) && completedOrActiveWriteIds.size >= MAX_LIGHTWEIGHT_WRITE_CALLS) {
			throw new LightweightActionScopeExceededError();
		}
	}

	state.observations = applyToolEventToWorkflowObservations(state.observations, event);
}

export function addLightweightActionObservation(
	state: LightweightActionState,
	observation: WorkflowToolObservation
): void {
	const existingIndex: number = state.observations.findIndex((
		item: WorkflowToolObservation
	): boolean => item.toolCallId === observation.toolCallId);
	if (existingIndex < 0) {
		state.observations.push(cloneObservation(observation));
		return;
	}
	const existing: WorkflowToolObservation | undefined = state.observations[existingIndex];
	state.observations[existingIndex] = cloneObservation({
		...existing,
		...observation,
		argsSummary: {
			...(existing?.argsSummary ?? {}),
			...(observation.argsSummary ?? {})
		},
		artifactRefs: observation.artifactRefs !== undefined && observation.artifactRefs.length > 0
			? observation.artifactRefs
			: existing?.artifactRefs,
		artifactFileRefs: observation.artifactFileRefs !== undefined && observation.artifactFileRefs.length > 0
			? observation.artifactFileRefs
			: existing?.artifactFileRefs,
		sourceFolderId: observation.sourceFolderId ?? existing?.sourceFolderId
	});
}

export function collectLightweightActionCompletionStatus(
	state: LightweightActionState
): LightweightActionCompletionStatus {
	const observations: WorkflowToolObservation[] = state.observations;
	let lastWriteIndex: number = -1;
	for (let index: number = 0; index < observations.length; index += 1) {
		if (isSuccessfulWriteObservation(observations[index])) {
			lastWriteIndex = index;
		}
	}

	if (lastWriteIndex < 0) {
		return {
			resultStatus: "completed",
			verificationStatus: "verified",
			warnings: []
		};
	}

	const modifiedPaths: Set<string> = collectModifiedPaths(observations.slice(0, lastWriteIndex + 1));
	const modifiedFamilies: Set<string> = collectModifiedFamilies(observations.slice(0, lastWriteIndex + 1));
	const laterObservations: WorkflowToolObservation[] = observations.slice(lastWriteIndex + 1);
	const relevantVerification: WorkflowToolObservation[] = laterObservations.filter((
		observation: WorkflowToolObservation
	): boolean => isRelevantVerificationObservation(observation, modifiedPaths, modifiedFamilies));
	const successfulVerification: boolean = relevantVerification.some((
		observation: WorkflowToolObservation
	): boolean => observation.status === "succeeded");
	const latestVerification: WorkflowToolObservation | undefined = [...relevantVerification]
		.reverse()
		.find((observation: WorkflowToolObservation): boolean => (
			observation.status === "failed" || observation.status === "succeeded"
		));
	const environmentWarnings: string[] = uniqueStrings(relevantVerification
		.filter(isEnvironmentIssueObservation)
		.map((observation: WorkflowToolObservation): string => summarizeObservationFailure(observation)));

	if (
		latestVerification?.status === "failed"
		&& !isEnvironmentIssueObservation(latestVerification)
	) {
		return {
			resultStatus: "completed_with_warnings",
			verificationStatus: "unverified",
			warnings: environmentWarnings,
			failureMessage: `轻量操作的验证失败：${summarizeObservationFailure(latestVerification)}`
		};
	}

	if (latestVerification?.status === "succeeded" && environmentWarnings.length === 0) {
		return {
			resultStatus: "completed",
			verificationStatus: "verified",
			warnings: []
		};
	}

	const warnings: string[] = uniqueStrings([
		...environmentWarnings,
		...(successfulVerification ? [] : ["修改已完成，但最后一次写入后没有成功的针对性验证或内容回读。"])
	]);
	return {
		resultStatus: "completed_with_warnings",
		verificationStatus: "unverified",
		warnings
	};
}

function cloneObservation(observation: WorkflowToolObservation): WorkflowToolObservation {
	return {
		...observation,
		argsSummary: observation.argsSummary === undefined ? undefined : { ...observation.argsSummary },
		parsedResult: observation.parsedResult === undefined ? undefined : { ...observation.parsedResult },
		artifactRefs: observation.artifactRefs === undefined ? undefined : [...observation.artifactRefs],
		artifactFileRefs: observation.artifactFileRefs === undefined ? undefined : observation.artifactFileRefs.map((fileRef) => ({ ...fileRef }))
	};
}

function isWorkflowToolObservation(value: unknown): value is WorkflowToolObservation {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record: Record<string, unknown> = value as Record<string, unknown>;
	return typeof record.toolCallId === "string"
		&& typeof record.toolName === "string"
		&& (
			record.status === "called"
			|| record.status === "approval_required"
			|| record.status === "succeeded"
			|| record.status === "failed"
		);
}

function isWriteToolEvent(event: Extract<ToolEvent, { type: "tool.call" }>): boolean {
	const observationState: LightweightActionState = createLightweightActionState();
	applyToolEventToLightweightActionState(observationState, event);
	return observationState.observations.some(isWriteObservation);
}

function isWriteObservation(observation: WorkflowToolObservation): boolean {
	return observation.risk === "write" || observation.risk === "destructive";
}

function isSuccessfulWriteObservation(observation: WorkflowToolObservation | undefined): boolean {
	return observation !== undefined && observation.status === "succeeded" && isWriteObservation(observation);
}

function isEnvironmentIssueObservation(observation: WorkflowToolObservation): boolean {
	if (observation.parsedResult?.environmentIssue === true || observation.parsedResult?.validationStatus === "not_applicable") {
		return true;
	}
	const applicabilityCode: unknown = observation.parsedResult?.applicabilityCode;
	return typeof applicabilityCode === "string" && ENVIRONMENT_APPLICABILITY_CODES.has(applicabilityCode);
}

function isRelevantVerificationObservation(
	observation: WorkflowToolObservation,
	modifiedPaths: Set<string>,
	modifiedFamilies: Set<string>
): boolean {
	if (observation.risk !== "read" && observation.risk !== "verify") {
		return false;
	}

	const observationPaths: Set<string> = collectObservationPaths(observation);
	if (observationPaths.size > 0 && modifiedPaths.size > 0) {
		return pathsOverlap(modifiedPaths, observationPaths);
	}

	const capabilities: readonly string[] = observation.validationCapabilities ?? [];
	if (capabilities.includes("workspace_typecheck")) {
		return modifiedFamilies.has("workspace_file") && hasMatchingSourceScope(observation, modifiedPaths);
	}
	if (capabilities.includes("godot_script_check")) {
		return modifiedFamilies.has("godot_script") && hasMatchingSourceScope(observation, modifiedPaths);
	}
	if (capabilities.includes("godot_scene_reference_check")) {
		return modifiedFamilies.has("godot_scene") && hasMatchingSourceScope(observation, modifiedPaths);
	}
	return false;
}

function hasMatchingSourceScope(observation: WorkflowToolObservation, modifiedPaths: Set<string>): boolean {
	if (modifiedPaths.size === 0) return false;
	const sourcePrefix: string = `${observation.sourceFolderId ?? ""}:`;
	return [...modifiedPaths].some((path: string): boolean => path.startsWith(sourcePrefix));
}

function collectModifiedPaths(observations: WorkflowToolObservation[]): Set<string> {
	const result: Set<string> = new Set();
	for (const observation of observations) {
		if (!isSuccessfulWriteObservation(observation)) {
			continue;
		}
		for (const pathValue of collectObservationPaths(observation)) {
			result.add(pathValue);
		}
	}
	return result;
}

function collectModifiedFamilies(observations: WorkflowToolObservation[]): Set<string> {
	const families: Set<string> = new Set();
	for (const observation of observations) {
		if (!isSuccessfulWriteObservation(observation)) continue;
		for (const family of observation.repairFamilies ?? []) families.add(family);
	}
	return families;
}

function collectObservationPaths(observation: WorkflowToolObservation): Set<string> {
	const values: string[] = [];
	for (const fileRef of observation.artifactFileRefs ?? []) {
		values.push(`${fileRef.sourceFolderId}:${fileRef.relativePath}`);
	}
	for (const key of ["relativePath", "resourcePath", "scenePath", "scriptPath", "path"]) {
		const value: unknown = observation.argsSummary?.[key];
		if (typeof value === "string") {
		values.push(`${observation.sourceFolderId ?? ""}:${value}`);
		}
	}
	values.push(...(observation.artifactRefs ?? []).map((value: string): string => `${observation.sourceFolderId ?? ""}:${value}`));
	return new Set(values.map(normalizePathValue).filter((value: string): boolean => value.length > 0));
}

function normalizePathValue(value: string): string {
	return value.trim().replace(/^res:\/\//iu, "").replace(/\\/gu, "/").toLowerCase();
}

function pathsOverlap(left: Set<string>, right: Set<string>): boolean {
	if (left.size === 0 || right.size === 0) {
		return false;
	}
	for (const leftPath of left) {
		for (const rightPath of right) {
			if (leftPath === rightPath) {
				return true;
			}
		}
	}
	return false;
}

function summarizeObservationFailure(observation: WorkflowToolObservation): string {
	const failedChecks: unknown = observation.parsedResult?.failedChecks;
	if (Array.isArray(failedChecks) && failedChecks.length > 0) {
		return failedChecks.map((value: unknown): string => String(value)).join("; ");
	}
	return observation.error
		?? (String(observation.parsedResult?.summary ?? "") || `${observation.toolName} 未通过`);
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value: string): string => value.trim()).filter((value: string): boolean => value.length > 0))];
}
