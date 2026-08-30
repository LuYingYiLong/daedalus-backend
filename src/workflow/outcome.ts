import type { ToolEvent } from "../tools/tool-dispatcher.js";
import { getEffectiveToolPolicy, getToolPolicy } from "../tools/tool-policy.js";
import { isValidWorkflowCompletionTarget, normalizeWorkspaceRelativeArtifactPath } from "./completion-contract.js";
import { getWorkflowToolSemantics, type WorkflowTargetKind, type WorkflowValidationCapability } from "./tool-semantics.js";
import type { WorkspaceFileRef } from "../workspace/source-context.js";
import type {
	WorkflowCompletionTarget,
	WorkflowFailedCheck,
	WorkflowPhase,
	WorkflowPhaseOutput,
	WorkflowPhaseOutcomeStatus,
	WorkflowPlan,
	WorkflowToolObservation
} from "./types.js";

const ENVIRONMENT_APPLICABILITY_CODES: ReadonlySet<string> = new Set([
	"git_repository_missing",
	"package_manifest_missing",
	"typecheck_script_missing",
	"godot_project_missing",
	"godot_runtime_unavailable",
	"diagnostics_unavailable",
	"workspace_unavailable"
]);
const GODOT_INPUT_ACTION_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_godot_propose_set_input_action",
	"mcp_godot_set_input_action",
	"mcp_godot_propose_unset_input_action",
	"mcp_godot_unset_input_action"
]);
const GODOT_AUTOLOAD_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_godot_propose_set_autoload",
	"mcp_godot_set_autoload",
	"mcp_godot_propose_unset_autoload",
	"mcp_godot_unset_autoload"
]);

export function createWorkflowPhaseRunId(phaseId: string): string {
	return `phase-run-${phaseId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	for (const key of ["sourceFolderId", "relativePath", "resourcePath", "scenePath", "scriptPath", "path", "presetName", "operationJson", "key", "action", "name"]) {
		const value: unknown = args[key];
		if (typeof value === "string") {
			summary[key] = value.length > 240 ? `${value.slice(0, 240)}...` : value;
		}
	}

	const operations: unknown = args.operations;
	if (Array.isArray(operations)) {
		summary.operationsCount = operations.length;
	}

	return summary;
}

function parsedResultFromToolEvent(event: Extract<ToolEvent, { type: "tool.result" }>): Record<string, unknown> {
	const parsedResult: Record<string, unknown> = {};
	for (const key of ["ok", "exitCode", "diagnosticsCount", "diagnosticsErrorCount", "validationStatus", "summary", "failedChecks", "failureCode", "failure", "environmentIssue", "applicabilityCode", "notApplicableReason", "artifactRefs", "artifactFileRefs", "sourceFolderId"]) {
		const value: unknown = event[key as keyof typeof event];
		if (value !== undefined) {
			parsedResult[key] = value;
		}
	}

	return parsedResult;
}

function findObservation(observations: WorkflowToolObservation[], toolCallId: string): WorkflowToolObservation | undefined {
	return observations.find((observation: WorkflowToolObservation): boolean => observation.toolCallId === toolCallId);
}

function upsertObservation(
	observations: WorkflowToolObservation[],
	observation: WorkflowToolObservation
): WorkflowToolObservation[] {
	const existingIndex: number = observations.findIndex((item: WorkflowToolObservation): boolean => item.toolCallId === observation.toolCallId);
	if (existingIndex < 0) {
		return [...observations, observation];
	}

	const nextObservations: WorkflowToolObservation[] = [...observations];
	nextObservations[existingIndex] = {
		...nextObservations[existingIndex],
		...observation,
		argsSummary: observation.argsSummary ?? nextObservations[existingIndex]?.argsSummary,
		artifactRefs: observation.artifactRefs ?? nextObservations[existingIndex]?.artifactRefs,
		artifactFileRefs: observation.artifactFileRefs ?? nextObservations[existingIndex]?.artifactFileRefs,
		sourceFolderId: observation.sourceFolderId ?? nextObservations[existingIndex]?.sourceFolderId,
		executionRole: observation.executionRole ?? nextObservations[existingIndex]?.executionRole,
		validationScope: observation.validationScope ?? nextObservations[existingIndex]?.validationScope,
		fileEditFingerprints: observation.fileEditFingerprints ?? nextObservations[existingIndex]?.fileEditFingerprints
	};
	return nextObservations;
}

export function applyToolEventToWorkflowObservations(
	observations: WorkflowToolObservation[],
	event: ToolEvent
): WorkflowToolObservation[] {
	if (event.type === "tool.call") {
		const risk: string | undefined = getEffectiveToolPolicy(event.toolName, event.args)?.risk;
		const semantics = getWorkflowToolSemantics(event.toolName, event.args);
		return upsertObservation(observations, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			risk,
			status: "called",
			argsSummary: summarizeArgs(event.args),
			artifactRefs: semantics.artifactRefs === undefined ? [] : [...semantics.artifactRefs],
			sourceFolderId: typeof event.args.sourceFolderId === "string" ? event.args.sourceFolderId : undefined,
			validationCapabilities: semantics.validationCapabilities === undefined ? undefined : [...semantics.validationCapabilities],
			repairFamilies: semantics.repairFamilies === undefined ? undefined : [...semantics.repairFamilies],
			executionRole: semantics.executionRole,
			validationScope: semantics.validationScope
		});
	}

	if (event.type === "tool.approval_required") {
		const risk: string | undefined = getEffectiveToolPolicy(event.toolName, event.args)?.risk;
		const semantics = getWorkflowToolSemantics(event.toolName, event.args);
		return upsertObservation(observations, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			risk,
			status: "approval_required",
			argsSummary: summarizeArgs(event.args),
			artifactRefs: semantics.artifactRefs === undefined ? [] : [...semantics.artifactRefs],
			sourceFolderId: typeof event.args.sourceFolderId === "string" ? event.args.sourceFolderId : undefined,
			validationCapabilities: semantics.validationCapabilities === undefined ? undefined : [...semantics.validationCapabilities],
			repairFamilies: semantics.repairFamilies === undefined ? undefined : [...semantics.repairFamilies],
			executionRole: semantics.executionRole,
			validationScope: semantics.validationScope
		});
	}

	if (event.type === "tool.result") {
		const previous: WorkflowToolObservation | undefined = findObservation(observations, event.toolCallId);
		const risk: string | undefined = previous?.risk ?? getToolPolicy(event.toolName)?.risk;
		const parsedResult: Record<string, unknown> = parsedResultFromToolEvent(event);
		const semantics = getWorkflowToolSemantics(event.toolName, previous?.argsSummary ?? {});
		const validationStatus: unknown = parsedResult.validationStatus;
		const ok: unknown = parsedResult.ok;
		const failed: boolean = validationStatus !== "not_applicable" && (validationStatus === "failed" || ok === false);
		const resultArtifactRefs: string[] = Array.isArray(event.artifactRefs)
			? event.artifactRefs.map((value: unknown): string => String(value))
			: [];
		const artifactRefs: string[] | undefined = resultArtifactRefs.length > 0
			? resultArtifactRefs
			: previous?.artifactRefs;
		const artifactFileRefs = Array.isArray(event.artifactFileRefs) ? event.artifactFileRefs : previous?.artifactFileRefs;
		const observedSourceFolderId: string | undefined = event.sourceFolderId ?? previous?.sourceFolderId;
		const fileEditFingerprints: string[] | undefined = event.fileEditDraft === undefined
			? previous?.fileEditFingerprints
			: event.fileEditDraft.edits
				.filter((edit): boolean => edit.beforeSha256 !== edit.afterSha256)
				.map((edit): string => `${observedSourceFolderId === undefined ? "" : `${observedSourceFolderId}:`}${edit.path}:${edit.beforeSha256 ?? "new"}:${edit.afterSha256 ?? "deleted"}`);
		return upsertObservation(observations, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			risk,
			status: failed ? "failed" : "succeeded",
			argsSummary: previous?.argsSummary,
			parsedResult,
			artifactRefs,
			artifactFileRefs,
			sourceFolderId: observedSourceFolderId,
			fileEditFingerprints,
			validationCapabilities: semantics.validationCapabilities === undefined ? previous?.validationCapabilities : [...semantics.validationCapabilities],
			repairFamilies: semantics.repairFamilies === undefined ? previous?.repairFamilies : [...semantics.repairFamilies],
			executionRole: semantics.executionRole ?? previous?.executionRole,
			validationScope: semantics.validationScope ?? previous?.validationScope,
			failureCode: typeof parsedResult.failureCode === "string" ? parsedResult.failureCode : undefined,
			failure: event.failure
		});
	}

	if (event.type === "tool.error") {
		const previous: WorkflowToolObservation | undefined = findObservation(observations, event.toolCallId);
		const risk: string | undefined = previous?.risk ?? getToolPolicy(event.toolName)?.risk;
		return upsertObservation(observations, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			risk,
			status: "failed",
			argsSummary: previous?.argsSummary,
			error: event.message,
			artifactRefs: previous?.artifactRefs,
			artifactFileRefs: previous?.artifactFileRefs,
			sourceFolderId: previous?.sourceFolderId,
			executionRole: previous?.executionRole,
			validationScope: previous?.validationScope,
			failureCode: event.failure?.code,
			failure: event.failure,
			parsedResult: event.failure === undefined ? undefined : {
				ok: false,
				validationStatus: event.failure.category === "environment" ? "not_applicable" : "failed",
				environmentIssue: event.failure.category === "environment" || undefined,
				failureCode: event.failure.code,
				summary: event.failure.message,
				failedChecks: event.failure.category === "environment" ? undefined : [event.failure.message],
				failure: event.failure
			}
		});
	}

	return observations;
}

function isVerificationObservation(observation: WorkflowToolObservation): boolean {
	return (observation.validationCapabilities?.length ?? 0) > 0;
}

function isSuccessfulVerificationObservation(phase: WorkflowPhase, observation: WorkflowToolObservation): boolean {
	if (observation.status !== "succeeded" || observation.parsedResult?.validationStatus === "not_applicable") {
		return false;
	}
	const capabilities: readonly WorkflowValidationCapability[] = observation.validationCapabilities ?? [];
	return capabilities.some((capability: WorkflowValidationCapability): boolean => (
		capability !== "artifact_readback" || phase.verificationRequirements?.includes("artifact_readback") === true
	));
}

function isEnvironmentIssueObservation(observation: WorkflowToolObservation): boolean {
	if (observation.failure?.category === "environment") {
		return true;
	}
	if (observation.parsedResult?.environmentIssue === true || observation.parsedResult?.validationStatus === "not_applicable") {
		return true;
	}
	return typeof observation.parsedResult?.applicabilityCode === "string"
		&& ENVIRONMENT_APPLICABILITY_CODES.has(observation.parsedResult.applicabilityCode);
}

function hasEnvironmentIssueObservation(observations: WorkflowToolObservation[]): boolean {
	return observations.some(isEnvironmentIssueObservation);
}

function collectEnvironmentWarnings(observations: WorkflowToolObservation[]): string[] {
	return uniqueStrings(observations
		.filter(isEnvironmentIssueObservation)
		.map((observation: WorkflowToolObservation): string => {
			const applicabilityCode: string = observation.failure?.code
				?? String(observation.parsedResult?.applicabilityCode ?? "");
			const notApplicableReason: string = String(observation.parsedResult?.notApplicableReason ?? "");
			const reason: string = observation.failure?.message ?? (notApplicableReason.length > 0
				? notApplicableReason
				: observation.error
					?? (String(observation.parsedResult?.summary ?? "") || `${observation.toolName} verification environment is unavailable`));
			return applicabilityCode.length > 0 ? `[${applicabilityCode}] ${reason}` : reason;
		}))
		.map((warning: string): string => warning.length > 0
			? warning
			: "Godot verification environment is unavailable.");
}

function hasSuccessfulVerificationObservation(phase: WorkflowPhase, observations: WorkflowToolObservation[]): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => isSuccessfulVerificationObservation(phase, observation));
}

function hasSuccessfulMutationObservation(observations: WorkflowToolObservation[]): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => (
		observation.status === "succeeded" && (observation.risk === "write" || observation.risk === "destructive")
	));
}

function scopedArtifactKey(sourceFolderId: string | undefined, artifact: string): string {
	return `${sourceFolderId ?? ""}:${normalizeTargetValue(artifact)}`;
}

function collectWritePhaseTargetKeys(
	phase: WorkflowPhase,
	observations: WorkflowToolObservation[]
): Set<string> {
	const targets: Set<string> = new Set();
	for (const observation of observations) {
		if (!isSuccessfulMutation(observation)) continue;
		for (const artifact of observation.artifactRefs ?? []) {
			targets.add(scopedArtifactKey(observation.sourceFolderId, artifact));
		}
	}
	for (const target of phase.completionContract?.targets ?? []) {
		const artifact: string = target.kind === "project_setting" ? target.key : target.path;
		targets.add(scopedArtifactKey(target.sourceFolderId ?? phase.sourceFolderId, artifact));
	}
	return targets;
}

function verificationTargetsCurrentWrite(
	phase: WorkflowPhase,
	observation: WorkflowToolObservation,
	observations: WorkflowToolObservation[]
): boolean {
	if (observation.validationScope !== "artifacts" || (observation.artifactRefs?.length ?? 0) === 0) {
		return false;
	}
	const writeTargets: Set<string> = collectWritePhaseTargetKeys(phase, observations);
	return observation.artifactRefs?.some((artifact: string): boolean => (
		writeTargets.has(scopedArtifactKey(observation.sourceFolderId ?? phase.sourceFolderId, artifact))
	)) === true;
}

function isNonMutationFailureInCompletedWritePhase(
	phase: WorkflowPhase,
	observation: WorkflowToolObservation,
	observations: WorkflowToolObservation[]
): boolean {
	if (phase.toolGroup !== "write" || !hasSuccessfulMutationObservation(observations)) {
		return false;
	}
	if (observation.risk === "read" || observation.risk === "verify" || observation.risk === "propose") {
		return true;
	}
	return observation.executionRole === "verification"
		&& !verificationTargetsCurrentWrite(phase, observation, observations);
}

function collectNonBlockingWriteWarnings(
	phase: WorkflowPhase,
	observations: WorkflowToolObservation[]
): string[] {
	const warnings: string[] = [];
	for (const observation of observations) {
		if (
			(observation.status !== "failed" && observation.error === undefined)
			|| !isNonMutationFailureInCompletedWritePhase(phase, observation, observations)
		) {
			continue;
		}
		if (observation.error !== undefined) {
			warnings.push(`[non_blocking_verification] ${observation.error}`);
			continue;
		}
		const parsedFailedChecks: unknown = observation.parsedResult?.failedChecks;
		if (Array.isArray(parsedFailedChecks) && parsedFailedChecks.length > 0) {
			for (const failedCheck of parsedFailedChecks) {
				warnings.push(`[non_blocking_verification] ${String(failedCheck)}`);
			}
			continue;
		}
		warnings.push(`[non_blocking_verification] ${String(observation.parsedResult?.summary ?? `${observation.toolName} failed`)}`);
	}
	return uniqueStrings(warnings);
}

function normalizedRecord(value: Record<string, unknown> | undefined): string {
	if (value === undefined) {
		return "{}";
	}

	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = value[key];
	}
	return JSON.stringify(sorted);
}

function hasArtifactOverlap(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	if (left === undefined || right === undefined || left.length === 0 || right.length === 0) {
		return false;
	}

	const rightSet: Set<string> = new Set(right.map((artifact: string): string => normalizeTargetValue(artifact)));
	return left.some((artifact: string): boolean => rightSet.has(normalizeTargetValue(artifact)));
}

function hasFileRefOverlap(
	left: readonly WorkspaceFileRef[] | undefined,
	right: readonly WorkspaceFileRef[] | undefined
): boolean {
	if (left === undefined || right === undefined || left.length === 0 || right.length === 0) {
		return false;
	}
	return left.some((leftRef: WorkspaceFileRef): boolean => right.some((rightRef: WorkspaceFileRef): boolean => (
		leftRef.workspaceId === rightRef.workspaceId
		&& leftRef.sourceFolderId === rightRef.sourceFolderId
		&& normalizeTargetValue(leftRef.relativePath) === normalizeTargetValue(rightRef.relativePath)
	)));
}

function matchesRetryTarget(failedObservation: WorkflowToolObservation, successObservation: WorkflowToolObservation): boolean {
	if (failedObservation.sourceFolderId !== undefined
		&& successObservation.sourceFolderId !== undefined
		&& failedObservation.sourceFolderId !== successObservation.sourceFolderId) {
		return false;
	}
	if (hasFileRefOverlap(failedObservation.artifactFileRefs, successObservation.artifactFileRefs)) {
		return true;
	}
	if (hasArtifactOverlap(failedObservation.artifactRefs, successObservation.artifactRefs)) {
		return true;
	}
	// Legacy observations without structured targets can only be resolved by an
	// exact retry. This fallback never grants repair authority.
	return failedObservation.toolName === successObservation.toolName
		&& normalizedRecord(failedObservation.argsSummary) === normalizedRecord(successObservation.argsSummary);
}

function isResolvedByLaterSuccess(
	observation: WorkflowToolObservation,
	index: number,
	observations: WorkflowToolObservation[]
): boolean {
	if (observation.status !== "failed" && observation.error === undefined) {
		return false;
	}

	return observations
		.slice(index + 1)
		.some((candidate: WorkflowToolObservation): boolean => (
			candidate.status === "succeeded" && matchesRetryTarget(observation, candidate)
		));
}

function collectFailedChecks(phase: WorkflowPhase, observations: WorkflowToolObservation[], agentResultText: string): WorkflowFailedCheck[] {
	const failedChecks: WorkflowFailedCheck[] = [];
	if (phase.toolGroup === "summarize") {
		if (agentResultText.trim().length === 0) {
			failedChecks.push({ code: "summary_content_missing", failureCode: "summary_content_missing", message: "The summary phase did not produce visible content.", severity: "error" });
		}
		if (phase.allowedTools.length === 0 && observations.length > 0) {
			failedChecks.push({ code: "summary_tool_call_protocol_violation", failureCode: "summary_tool_call_protocol_violation", message: "The structured protocol for the summary phase does not allow tool calls.", severity: "error" });
		}
	}
	for (const [index, observation] of observations.entries()) {
		if (observation.status === "approval_required") {
			failedChecks.push({
				code: "approval_required",
				message: `${observation.toolName} is waiting for approval.`,
					toolCallId: observation.toolCallId,
					toolName: observation.toolName,
					sourceFolderId: observation.sourceFolderId
			});
			continue;
		}

		if (isNonMutationFailureInCompletedWritePhase(phase, observation, observations)) {
			continue;
		}

		if (isResolvedByLaterSuccess(observation, index, observations)) {
			continue;
		}

		const parsedResult: Record<string, unknown> | undefined = observation.parsedResult;
		if (isEnvironmentIssueObservation(observation)) {
			continue;
		}
		if (observation.failure !== undefined) {
			failedChecks.push({
				code: observation.failure.code,
				failureCode: observation.failure.code,
				message: observation.failure.message,
				toolCallId: observation.toolCallId,
				toolName: observation.toolName,
				artifact: observation.failure.artifactRefs[0] ?? observation.artifactRefs?.[0],
				sourceFolderId: observation.failure.sourceFolderId ?? observation.sourceFolderId,
				artifactFileRef: observation.failure.artifactFileRefs?.[0] ?? observation.artifactFileRefs?.[0],
				severity: "error"
			});
			continue;
		}
		if (parsedResult === undefined) {
			if (observation.error !== undefined) {
				failedChecks.push({
					code: "tool_execution_failed",
					failureCode: "tool_execution_failed",
					message: observation.error,
					toolCallId: observation.toolCallId,
					toolName: observation.toolName,
					sourceFolderId: observation.sourceFolderId
				});
			}
			continue;
		}

		const parsedFailedChecks: unknown = parsedResult.failedChecks;
		if (Array.isArray(parsedFailedChecks)) {
			for (const failedCheck of parsedFailedChecks) {
				failedChecks.push({
					code: String(parsedResult.validationStatus ?? "tool_failed_check"),
					failureCode: typeof parsedResult.failureCode === "string" ? parsedResult.failureCode : String(parsedResult.validationStatus ?? "tool_failed_check"),
					message: String(failedCheck),
					toolCallId: observation.toolCallId,
						toolName: observation.toolName,
						artifact: observation.artifactRefs?.[0],
						sourceFolderId: observation.sourceFolderId,
						artifactFileRef: observation.artifactFileRefs?.[0]
				});
			}
		} else if (observation.status === "failed") {
			failedChecks.push({
				code: String(parsedResult.validationStatus ?? "tool_failed"),
				failureCode: typeof parsedResult.failureCode === "string" ? parsedResult.failureCode : String(parsedResult.validationStatus ?? "tool_failed"),
				message: String(parsedResult.summary ?? `${observation.toolName} failed`),
				toolCallId: observation.toolCallId,
					toolName: observation.toolName,
					artifact: observation.artifactRefs?.[0],
					sourceFolderId: observation.sourceFolderId,
					artifactFileRef: observation.artifactFileRefs?.[0]
			});
		}
	}

	return failedChecks;
}

const COMPLETION_FAILURE_CODES: ReadonlySet<string> = new Set([
	"required_mutation_missing",
	"target_artifact_missing",
	"target_readback_failed"
]);

function normalizeTargetValue(value: string): string {
	return (normalizeWorkspaceRelativeArtifactPath(value)
		?? value.replace(/^res:\/\//iu, "").replace(/\\/g, "/").replace(/^\.\//u, "")).toLowerCase();
}

function observationTargetValues(observation: WorkflowToolObservation): string[] {
	const args: Record<string, unknown> = observation.argsSummary ?? {};
	const values: string[] = [...(observation.artifactRefs ?? [])];
	for (const key of ["relativePath", "resourcePath", "scenePath", "scriptPath", "path"]) {
		const value: unknown = args[key];
		if (typeof value === "string" && value.length > 0) {
			values.push(value);
		}
	}
	return values.map(normalizeTargetValue);
}

function observationMatchesCompletionTarget(observation: WorkflowToolObservation, target: WorkflowCompletionTarget): boolean {
	if (target.kind === "project_setting") {
		const key: unknown = observation.argsSummary?.key;
		return typeof key === "string" && normalizeTargetValue(key) === normalizeTargetValue(target.key);
	}
	if (target.fileRef !== undefined) {
		return observation.artifactFileRefs?.some((fileRef) => (
			fileRef.workspaceId === target.fileRef!.workspaceId
			&& fileRef.sourceFolderId === target.fileRef!.sourceFolderId
			&& fileRef.relativePath === target.fileRef!.relativePath
		)) === true;
	}

	const expected: string = normalizeTargetValue(target.path);
	if (target.sourceFolderId !== undefined && observation.sourceFolderId !== target.sourceFolderId) {
		return false;
	}
	return observationTargetValues(observation).some((value: string): boolean => (
		value === expected
	));
}

function isSuccessfulMutation(observation: WorkflowToolObservation): boolean {
	return observation.status === "succeeded" && (observation.risk === "write" || observation.risk === "destructive");
}

function isReadbackObservation(observation: WorkflowToolObservation): boolean {
	return observation.risk === "read"
		|| observation.risk === "verify"
		|| (observation.validationCapabilities?.includes("artifact_readback") === true)
		|| (observation.validationCapabilities?.includes("godot_scene_reference_check") === true);
}

function collectCompletionContractFailedChecks(
	phase: WorkflowPhase,
	observations: WorkflowToolObservation[]
): WorkflowFailedCheck[] {
	const contract = phase.completionContract;
	if (phase.toolGroup !== "write" || contract === undefined || contract.targets.length === 0) {
		return [];
	}
	const validTargets: WorkflowCompletionTarget[] = contract.targets.filter(isValidWorkflowCompletionTarget);
	if (validTargets.length === 0) {
		return [];
	}

	const failedChecks: WorkflowFailedCheck[] = [];
	for (const target of validTargets) {
		const matchingMutations: WorkflowToolObservation[] = observations.filter((observation: WorkflowToolObservation): boolean => (
			isSuccessfulMutation(observation) && observationMatchesCompletionTarget(observation, target)
		));
		if (matchingMutations.length === 0) {
			failedChecks.push({
				code: target.kind === "artifact" ? "target_artifact_missing" : "required_mutation_missing",
				failureCode: target.kind === "artifact" ? "target_artifact_missing" : "required_mutation_missing",
				message: target.kind === "artifact"
					? `The write phase did not create or modify the target file ${target.path}.`
					: `The write phase did not modify the target project setting ${target.key}.`,
				artifact: target.kind === "artifact" ? target.path : target.key,
				targetKind: target.kind === "artifact" ? target.targetKind : "project_setting",
				artifactFileRef: target.kind === "artifact" ? target.fileRef : undefined,
				severity: "error"
			});
			if (!contract.requireAll) {
				break;
			}
			continue;
		}

		const readbacks: WorkflowToolObservation[] = observations.filter((observation: WorkflowToolObservation): boolean => (
			isReadbackObservation(observation) && observationMatchesCompletionTarget(observation, target)
		));
		if (readbacks.length > 0 && !readbacks.some((observation: WorkflowToolObservation): boolean => observation.status === "succeeded")) {
			failedChecks.push({
				code: "target_readback_failed",
				failureCode: "target_readback_failed",
				message: target.kind === "artifact"
					? `Reading back or checking target file ${target.path} failed.`
					: `Reading back target project setting ${target.key} failed.`,
				artifact: target.kind === "artifact" ? target.path : target.key,
				targetKind: target.kind === "artifact" ? target.targetKind : "project_setting",
				artifactFileRef: target.kind === "artifact" ? target.fileRef : undefined,
				severity: "error"
			});
		}
	}
	return failedChecks;
}

function collectSummaries(observations: WorkflowToolObservation[]): string[] {
	return observations
		.map((observation: WorkflowToolObservation, index: number): string | undefined => {
			if (isResolvedByLaterSuccess(observation, index, observations)) {
				return undefined;
			}
			if (observation.parsedResult?.summary !== undefined) {
				return String(observation.parsedResult.summary);
			}
			if (observation.error !== undefined) {
				return observation.error;
			}
			return undefined;
		})
		.filter((summary: string | undefined): summary is string => summary !== undefined && summary.length > 0);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value: string | undefined): value is string => value !== undefined && value.length > 0))];
}

function collectArtifacts(observations: WorkflowToolObservation[], risks: readonly string[]): string[] {
	return uniqueStrings(observations
		.filter((observation: WorkflowToolObservation): boolean => risks.includes(observation.risk ?? "") && observation.status === "succeeded")
		.flatMap((observation: WorkflowToolObservation): string[] => observation.artifactRefs ?? []));
}

function createRequiredFixes(failedChecks: WorkflowFailedCheck[]): string[] {
	if (failedChecks.length === 0) {
		return [];
	}

	return uniqueStrings(failedChecks.map((check: WorkflowFailedCheck): string => `Fix: ${check.message}`));
}

function summarizeFailedChecks(failedChecks: WorkflowFailedCheck[]): string | undefined {
	const messages: string[] = uniqueStrings(failedChecks.map((check: WorkflowFailedCheck): string => check.message));
	if (messages.length === 0) {
		return undefined;
	}

	return messages.slice(0, 3).join("\n");
}

function createOutcomeStatus(
	phase: WorkflowPhase,
	failedChecks: WorkflowFailedCheck[],
	observations: WorkflowToolObservation[]
): WorkflowPhaseOutcomeStatus {
	if (observations.some((observation: WorkflowToolObservation): boolean => observation.status === "approval_required")) {
		return "approval_required";
	}

	if (phase.toolGroup === "verify") {
		if (failedChecks.length > 0) {
			return "needs_fix";
		}
		if (!hasSuccessfulVerificationObservation(phase, observations) && !hasEnvironmentIssueObservation(observations)) {
			return "blocked";
		}
	}

	if (phase.toolGroup === "summarize" && failedChecks.length > 0) {
		return "blocked";
	}

	if (failedChecks.length > 0) {
		if (phase.toolGroup === "read") {
			// Discovery cannot safely repair workspace state. Preserve the failed
			// evidence for the user instead of turning a read problem into write work.
			return "blocked";
		}
		if (
			phase.toolGroup === "write"
			&& failedChecks.every((check: WorkflowFailedCheck): boolean => COMPLETION_FAILURE_CODES.has(check.code))
		) {
			return "needs_fix";
		}
		return phase.toolGroup === "write" ? "failed" : "needs_fix";
	}

	return "completed";
}

export function createWorkflowPhaseOutcome(
	phase: WorkflowPhase,
	phaseRunId: string,
	agentResultText: string,
	observations: WorkflowToolObservation[]
): WorkflowPhaseOutput {
	const failedChecks: WorkflowFailedCheck[] = [
		...collectFailedChecks(phase, observations, agentResultText),
		...collectCompletionContractFailedChecks(phase, observations)
	];
	const status: WorkflowPhaseOutcomeStatus = createOutcomeStatus(phase, failedChecks, observations);
	const summaries: string[] = collectSummaries(observations);
	const blockedReason: string | undefined = status === "blocked"
		? (phase.toolGroup === "verify"
				? hasEnvironmentIssueObservation(observations)
					? "The verification environment is unavailable, and there are no other successful, conclusive verification results."
					: "The verification phase did not run any conclusive verification tool."
			: summaries[0])
		: undefined;
	const trimmedAgentText: string = agentResultText.trim();
	const environmentWarnings: string[] = collectEnvironmentWarnings(observations);
	const nonBlockingWriteWarnings: string[] = collectNonBlockingWriteWarnings(phase, observations);
	const outcomeWarnings: string[] = uniqueStrings([...environmentWarnings, ...nonBlockingWriteWarnings]);
	const summary: string = blockedReason
		?? (status === "completed" || status === "approval_required" ? undefined : summarizeFailedChecks(failedChecks))
		?? summaries[0]
		?? (trimmedAgentText.length > 0 ? trimmedAgentText : undefined)
		?? phase.title;

	return {
		phaseId: phase.id,
		phaseRunId,
		title: phase.title,
		status,
		summary,
		evidence: summaries,
		failedChecks: status === "blocked" && failedChecks.length === 0
			? [{
				code: hasEnvironmentIssueObservation(observations) ? "validation_environment_unavailable" : "verify_tool_missing",
				message: blockedReason ?? "The verification phase has no verification-tool result."
			}]
			: failedChecks,
		requiredFixes: createRequiredFixes(failedChecks),
		modifiedArtifacts: collectArtifacts(observations, ["write", "destructive"]),
		verifiedArtifacts: uniqueStrings(observations
			.filter((observation: WorkflowToolObservation): boolean => isVerificationObservation(observation) && observation.status === "succeeded")
			.flatMap((observation: WorkflowToolObservation): string[] => observation.artifactRefs ?? [])),
		toolObservations: observations.map((observation: WorkflowToolObservation): WorkflowToolObservation => ({ ...observation })),
		verificationStatus: phase.toolGroup === "verify"
			? status === "completed" && environmentWarnings.length === 0 ? "verified" : "unverified"
			: undefined,
		warnings: outcomeWarnings.length > 0 ? outcomeWarnings : undefined,
		text: agentResultText,
		sourcePhaseId: phase.repairOf,
		blockedReason
	};
}

function collectVerificationObservations(
	outcome: WorkflowPhaseOutput,
	previousOutputs: WorkflowPhaseOutput[]
): WorkflowToolObservation[] {
	return [
		...previousOutputs.flatMap((output: WorkflowPhaseOutput): WorkflowToolObservation[] => (
			output.toolObservations.filter(isVerificationObservation)
		)),
		...outcome.toolObservations.filter(isVerificationObservation)
	];
}

function createGateFailure(code: string, message: string): WorkflowFailedCheck {
	return {
		code,
		message,
		severity: "error"
	};
}
function completionTargetIdentity(target: WorkflowCompletionTarget): string {
	if (target.kind === "project_setting") {
		return `setting:${target.sourceFolderId ?? ""}:${normalizeTargetValue(target.key)}`;
	}
	if (target.fileRef !== undefined) {
		return `file:${target.fileRef.workspaceId}:${target.fileRef.sourceFolderId}:${normalizeTargetValue(target.fileRef.relativePath)}`;
	}
	return `artifact:${target.sourceFolderId ?? ""}:${normalizeTargetValue(target.path)}`;
}

function selectObservationTargetKind(
	observation: WorkflowToolObservation
): Exclude<WorkflowTargetKind, "project_setting"> | undefined {
	const families = observation.repairFamilies ?? [];
	if (families.includes("godot_scene")) return "godot_scene";
	if (families.includes("godot_script")) return "godot_script";
	if (families.includes("workspace_file")) return "workspace_file";
	return undefined;
}

function getProjectSettingObservationKey(observation: WorkflowToolObservation): string | undefined {
	const explicitKey: unknown = observation.argsSummary?.key;
	if (typeof explicitKey === "string") return explicitKey;
	const action: unknown = observation.argsSummary?.action;
	if (typeof action === "string" && GODOT_INPUT_ACTION_TOOL_NAMES.has(observation.toolName)) {
		return `input/${action}`;
	}
	const name: unknown = observation.argsSummary?.name;
	if (typeof name === "string" && GODOT_AUTOLOAD_TOOL_NAMES.has(observation.toolName)) {
		return `autoload/${name}`;
	}
	return undefined;
}

function collectRegisteredMutationTargets(
	plan: WorkflowPlan,
	previousOutputs: readonly WorkflowPhaseOutput[]
): WorkflowCompletionTarget[] {
	const targets: WorkflowCompletionTarget[] = plan.phases
		.filter((phase: WorkflowPhase): boolean => phase.toolGroup === "write")
		.flatMap((phase: WorkflowPhase): WorkflowCompletionTarget[] => phase.completionContract?.targets ?? [])
		.filter(isValidWorkflowCompletionTarget)
		.map((target: WorkflowCompletionTarget): WorkflowCompletionTarget => ({ ...target }));
	for (const observation of previousOutputs.flatMap((output: WorkflowPhaseOutput): WorkflowToolObservation[] => output.toolObservations)) {
		if (!isSuccessfulMutation(observation)) continue;
		const targetKind = selectObservationTargetKind(observation);
		for (const fileRef of observation.artifactFileRefs ?? []) {
			const path: string | undefined = normalizeWorkspaceRelativeArtifactPath(fileRef.relativePath);
			if (path === undefined || targetKind === undefined) continue;
			targets.push({
				kind: "artifact",
				path,
				targetKind,
				sourceFolderId: fileRef.sourceFolderId,
				fileRef: { ...fileRef, relativePath: path }
			});
		}
		if ((observation.artifactFileRefs?.length ?? 0) > 0 || targetKind === undefined) continue;
		for (const artifact of observation.artifactRefs ?? []) {
			const path: string | undefined = normalizeWorkspaceRelativeArtifactPath(artifact);
			if (path === undefined) continue;
			targets.push({ kind: "artifact", path, targetKind, sourceFolderId: observation.sourceFolderId });
		}
		if (observation.repairFamilies?.includes("project_setting") === true) {
			const key: string | undefined = getProjectSettingObservationKey(observation);
			if (key !== undefined) {
				targets.push({ kind: "project_setting", key, sourceFolderId: observation.sourceFolderId });
			}
		}
	}
	const uniqueTargets: Map<string, WorkflowCompletionTarget> = new Map();
	for (const target of targets) {
		if (!isValidWorkflowCompletionTarget(target)) continue;
		uniqueTargets.set(completionTargetIdentity(target), target);
	}
	return [...uniqueTargets.values()];
}

function failedCheckMatchesTarget(check: WorkflowFailedCheck, target: WorkflowCompletionTarget): boolean {
	if (target.kind === "project_setting") {
		return check.artifact !== undefined
			&& normalizeTargetValue(check.artifact) === normalizeTargetValue(target.key)
			&& (target.sourceFolderId === undefined || check.sourceFolderId === target.sourceFolderId);
	}
	if (check.artifactFileRef !== undefined && target.fileRef !== undefined) {
		return check.artifactFileRef.workspaceId === target.fileRef.workspaceId
			&& check.artifactFileRef.sourceFolderId === target.fileRef.sourceFolderId
			&& normalizeTargetValue(check.artifactFileRef.relativePath) === normalizeTargetValue(target.fileRef.relativePath);
	}
	return check.artifact !== undefined
		&& normalizeTargetValue(check.artifact) === normalizeTargetValue(target.path)
		&& (target.sourceFolderId === undefined || check.sourceFolderId === target.sourceFolderId);
}

/**
 * Verification may only trigger repair for an exact target established by a
 * completion contract or a successful write observation. Auxiliary probes and
 * guessed paths remain visible as warnings but never gain mutation authority.
 */
export function scopeVerificationOutcomeToRegisteredTargets(
	plan: WorkflowPlan,
	previousOutputs: readonly WorkflowPhaseOutput[],
	outcome: WorkflowPhaseOutput
): WorkflowPhaseOutput {
	const phase: WorkflowPhase | undefined = plan.phases.find((item: WorkflowPhase): boolean => item.id === outcome.phaseId);
	if (phase?.toolGroup !== "verify") return outcome;
	const registeredTargets: WorkflowCompletionTarget[] = collectRegisteredMutationTargets(plan, previousOutputs);
	const actionableChecks: WorkflowFailedCheck[] = [];
	const unscopedChecks: WorkflowFailedCheck[] = [];
	for (const check of outcome.failedChecks) {
		const target: WorkflowCompletionTarget | undefined = registeredTargets.find((candidate: WorkflowCompletionTarget): boolean => (
			failedCheckMatchesTarget(check, candidate)
		));
		if (target === undefined) {
			unscopedChecks.push(check);
			continue;
		}
		actionableChecks.push({
			...check,
			targetKind: target.kind === "project_setting" ? "project_setting" : target.targetKind,
			sourceFolderId: target.sourceFolderId ?? check.sourceFolderId,
			artifactFileRef: target.kind === "artifact" ? target.fileRef ?? check.artifactFileRef : check.artifactFileRef
		});
	}
	const warningDetails: string[] = unscopedChecks.map((check: WorkflowFailedCheck): string => (
		`[${check.failureCode ?? check.code}] ${check.message}`
	));
	if (outcome.status === "blocked" && warningDetails.length === 0) {
		warningDetails.push(outcome.blockedReason ?? outcome.summary);
	}
	const warnings: string[] = uniqueStrings([...(outcome.warnings ?? []), ...warningDetails]);
	if (actionableChecks.length > 0) {
		return {
			...outcome,
			failedChecks: actionableChecks,
			requiredFixes: createRequiredFixes(actionableChecks),
			verificationStatus: "unverified",
			warnings: warnings.length > 0 ? warnings : undefined
		};
	}
	if (unscopedChecks.length === 0 && outcome.status !== "blocked") {
		return outcome;
	}
	return {
		...outcome,
		status: "completed",
		summary: "Verification completed with warnings; no failure was linked to a registered mutation target.",
		failedChecks: [],
		requiredFixes: [],
		verificationStatus: "unverified",
		warnings: warnings.length > 0 ? warnings : ["Verification did not produce target-scoped evidence."],
		blockedReason: undefined
	};
}

function hasValidationCapability(
	observations: WorkflowToolObservation[],
	capability: WorkflowValidationCapability,
	sourceFolderId: string | undefined
): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => (
		observation.status === "succeeded"
		&& observation.parsedResult?.validationStatus !== "not_applicable"
		&& observation.validationCapabilities?.includes(capability) === true
		&& (sourceFolderId === undefined || observation.sourceFolderId === undefined || observation.sourceFolderId === sourceFolderId)
	));
}

export function applyDeterministicVerificationGate(
	phase: WorkflowPhase,
	outcome: WorkflowPhaseOutput,
	previousOutputs: WorkflowPhaseOutput[]
): WorkflowPhaseOutput {
	if (phase.toolGroup !== "verify" || outcome.status !== "completed") {
		return outcome;
	}

	const verificationObservations: WorkflowToolObservation[] = collectVerificationObservations(outcome, previousOutputs);
	const gateFailures: WorkflowFailedCheck[] = [];
	const environmentFailures: WorkflowFailedCheck[] = [];
	for (const requirement of phase.verificationRequirements ?? []) {
		if (hasValidationCapability(verificationObservations, requirement, phase.sourceFolderId)) continue;
		const unavailableObservation: WorkflowToolObservation | undefined = verificationObservations.find((observation: WorkflowToolObservation): boolean => (
			isEnvironmentIssueObservation(observation)
			&& observation.validationCapabilities?.includes(requirement) === true
			&& (phase.sourceFolderId === undefined || observation.sourceFolderId === undefined || observation.sourceFolderId === phase.sourceFolderId)
		));
		const failure: WorkflowFailedCheck = createGateFailure(
			`${requirement}_required`,
			`The verification phase did not produce the required structured verification capability: ${requirement}.`
		);
		if (unavailableObservation !== undefined) {
			environmentFailures.push({
				...failure,
				code: unavailableObservation.failure?.code ?? "validation_environment_unavailable",
				failureCode: unavailableObservation.failure?.code ?? "validation_environment_unavailable",
				message: unavailableObservation.failure?.message
					?? String(unavailableObservation.parsedResult?.summary ?? failure.message),
				toolCallId: unavailableObservation.toolCallId,
				toolName: unavailableObservation.toolName,
				sourceFolderId: unavailableObservation.sourceFolderId
			});
			continue;
		}
		gateFailures.push(failure);
	}

	if (gateFailures.length === 0 && environmentFailures.length === 0) {
		return outcome;
	}

	const actionableFailures: WorkflowFailedCheck[] = gateFailures;
	const failedChecks: WorkflowFailedCheck[] = [...outcome.failedChecks, ...actionableFailures];
	const summary: string = [...gateFailures, ...environmentFailures]
		.map((failure: WorkflowFailedCheck): string => failure.message)
		.join("\n");
	if (actionableFailures.length === 0) {
		return {
			...outcome,
			status: "completed",
			summary,
			failedChecks,
			requiredFixes: createRequiredFixes(failedChecks),
			verificationStatus: "unverified",
			warnings: uniqueStrings([
				...(outcome.warnings ?? []),
				...environmentFailures.map((failure: WorkflowFailedCheck): string => failure.message)
			]),
			blockedReason: undefined
		};
	}
	return {
		...outcome,
		status: "needs_fix",
		summary,
		failedChecks,
		requiredFixes: createRequiredFixes(failedChecks),
		verificationStatus: environmentFailures.length > 0 ? "unverified" : outcome.verificationStatus,
		warnings: environmentFailures.length > 0
			? uniqueStrings([
				...(outcome.warnings ?? []),
				...environmentFailures.map((failure: WorkflowFailedCheck): string => failure.message)
			])
			: outcome.warnings,
		blockedReason: outcome.blockedReason
	};
}
