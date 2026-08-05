import type { ToolEvent } from "../tools/tool-dispatcher.js";
import { getEffectiveToolPolicy, getToolPolicy } from "../tools/tool-policy.js";
import { isValidWorkflowCompletionTarget, normalizeWorkspaceRelativeArtifactPath } from "./completion-contract.js";
import type {
	WorkflowCompletionTarget,
	WorkflowFailedCheck,
	WorkflowPhase,
	WorkflowPhaseOutput,
	WorkflowPhaseOutcomeStatus,
	WorkflowToolObservation
} from "./types.js";

const SUMMARY_TOOL_INTENT_PATTERN: RegExp = /(准备|将要|接下来|现在|马上|先).{0,20}(调用|使用|读取|运行|查询)|\b(I will|I'll|I am going to|I'm going to)\b/iu;
const TOOL_REFERENCE_PATTERN: RegExp = /\b(mcp_[a-z0-9_]+|read_text_file|inspect_scene_tree|replace_text_in_file|query_docs|resolve_library_id|godot\.[a-z0-9_.-]+)\b/iu;
const CONTENT_READBACK_EXTENSIONS: readonly string[] = [".md", ".mdx", ".rst", ".txt"];
const ENVIRONMENT_APPLICABILITY_CODES: ReadonlySet<string> = new Set([
	"git_repository_missing",
	"package_manifest_missing",
	"typecheck_script_missing",
	"godot_project_missing",
	"godot_runtime_unavailable",
	"diagnostics_unavailable",
	"workspace_unavailable"
]);

export function createWorkflowPhaseRunId(phaseId: string): string {
	return `phase-run-${phaseId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	for (const key of ["relativePath", "resourcePath", "scenePath", "scriptPath", "path", "presetName", "operationJson", "key"]) {
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
	for (const key of ["ok", "exitCode", "diagnosticsCount", "diagnosticsErrorCount", "validationStatus", "summary", "failedChecks", "environmentIssue", "applicabilityCode", "notApplicableReason", "artifactRefs"]) {
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
		return upsertObservation(observations, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			risk,
			status: "called",
			argsSummary: summarizeArgs(event.args),
			artifactRefs: []
		});
	}

	if (event.type === "tool.approval_required") {
		const risk: string | undefined = getEffectiveToolPolicy(event.toolName, event.args)?.risk;
		return upsertObservation(observations, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			risk,
			status: "approval_required",
			argsSummary: summarizeArgs(event.args),
			artifactRefs: []
		});
	}

	if (event.type === "tool.result") {
		const previous: WorkflowToolObservation | undefined = findObservation(observations, event.toolCallId);
		const risk: string | undefined = previous?.risk ?? getToolPolicy(event.toolName)?.risk;
		const parsedResult: Record<string, unknown> = parsedResultFromToolEvent(event);
		const validationStatus: unknown = parsedResult.validationStatus;
		const ok: unknown = parsedResult.ok;
		const failed: boolean = validationStatus !== "not_applicable" && (validationStatus === "failed" || ok === false);
		const artifactRefs: string[] | undefined = Array.isArray(event.artifactRefs)
			? event.artifactRefs.map((value: unknown): string => String(value))
			: previous?.artifactRefs;
		const fileEditFingerprints: string[] | undefined = event.fileEditDraft === undefined
			? previous?.fileEditFingerprints
			: event.fileEditDraft.edits
				.filter((edit): boolean => edit.beforeSha256 !== edit.afterSha256)
				.map((edit): string => `${edit.path}:${edit.beforeSha256 ?? "new"}:${edit.afterSha256 ?? "deleted"}`);
		return upsertObservation(observations, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			risk,
			status: failed ? "failed" : "succeeded",
			argsSummary: previous?.argsSummary,
			parsedResult,
			artifactRefs,
			fileEditFingerprints
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
			artifactRefs: previous?.artifactRefs
		});
	}

	return observations;
}

function isVerificationObservation(observation: WorkflowToolObservation): boolean {
	if (observation.risk === "verify") {
		return true;
	}

	if (isContentReadbackVerification(observation)) {
		return true;
	}

	return observation.toolName === "mcp_godot_lsp_get_file_diagnostics"
		|| observation.toolName.startsWith("mcp_godot_lsp_")
		|| observation.toolName === "mcp_godot_dap_get_last_error"
		|| observation.toolName.startsWith("mcp_godot_dap_")
		|| observation.toolName === "mcp_godot_dap_get_stack_trace"
		|| observation.toolName === "mcp_godot_inspect_scene_tree"
		|| observation.toolName === "mcp_godot_validate_scene_script_references";
}

/** A post-write readback is the deterministic validation for prose-only files. */
function isContentReadbackVerification(observation: WorkflowToolObservation): boolean {
	if (
		observation.toolName !== "mcp_workspace_read_text_file"
		&& observation.toolName !== "mcp_godot_read_text_file"
	) {
		return false;
	}

	return (observation.artifactRefs ?? []).some((artifact: string): boolean => {
		const normalized: string = artifact.replace(/^res:\/\//iu, "").toLowerCase();
		return CONTENT_READBACK_EXTENSIONS.some((extension: string): boolean => normalized.endsWith(extension));
	});
}

function isSuccessfulVerificationObservation(observation: WorkflowToolObservation): boolean {
	return observation.status === "succeeded"
		&& observation.parsedResult?.validationStatus !== "not_applicable"
		&& isVerificationObservation(observation);
}

function isEnvironmentIssueObservation(observation: WorkflowToolObservation): boolean {
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
			const applicabilityCode: string = String(observation.parsedResult?.applicabilityCode ?? "");
			const notApplicableReason: string = String(observation.parsedResult?.notApplicableReason ?? "");
			const reason: string = notApplicableReason.length > 0
				? notApplicableReason
				: observation.error
					?? (String(observation.parsedResult?.summary ?? "") || `${observation.toolName} verification environment is unavailable`);
			return applicabilityCode.length > 0 ? `[${applicabilityCode}] ${reason}` : reason;
		}))
		.map((warning: string): string => warning.length > 0
			? warning
			: "Godot verification environment is unavailable.");
}

function hasSuccessfulVerificationObservation(observations: WorkflowToolObservation[]): boolean {
	return observations.some(isSuccessfulVerificationObservation);
}

function hasSuccessfulMutationObservation(observations: WorkflowToolObservation[]): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => (
		observation.status === "succeeded" && (observation.risk === "write" || observation.risk === "destructive")
	));
}

function isNonMutationFailureInCompletedWritePhase(
	phase: WorkflowPhase,
	observation: WorkflowToolObservation,
	observations: WorkflowToolObservation[]
): boolean {
	return phase.toolGroup === "write"
		&& hasSuccessfulMutationObservation(observations)
		&& (observation.risk === "read" || observation.risk === "verify" || observation.risk === "propose");
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
		return true;
	}

	const rightSet: Set<string> = new Set(right);
	return left.some((artifact: string): boolean => rightSet.has(artifact));
}

function matchesRetryTarget(failedObservation: WorkflowToolObservation, successObservation: WorkflowToolObservation): boolean {
	return failedObservation.toolName === successObservation.toolName
		&& normalizedRecord(failedObservation.argsSummary) === normalizedRecord(successObservation.argsSummary)
		&& hasArtifactOverlap(failedObservation.artifactRefs, successObservation.artifactRefs);
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
	for (const [index, observation] of observations.entries()) {
		if (observation.status === "approval_required") {
			failedChecks.push({
				code: "approval_required",
				message: `${observation.toolName} 正在等待审批。`,
				toolCallId: observation.toolCallId,
				toolName: observation.toolName
			});
			continue;
		}

		if (isNonMutationFailureInCompletedWritePhase(phase, observation, observations)) {
			continue;
		}

		if (isResolvedByLaterSuccess(observation, index, observations)) {
			continue;
		}

		if (observation.error !== undefined) {
			if (isEnvironmentIssueObservation(observation)) {
				continue;
			}
			failedChecks.push({
				code: "tool_error",
				message: observation.error,
				toolCallId: observation.toolCallId,
				toolName: observation.toolName
			});
		}

		const parsedResult: Record<string, unknown> | undefined = observation.parsedResult;
		if (parsedResult === undefined) {
			continue;
		}
		if (isEnvironmentIssueObservation(observation)) {
			continue;
		}

		const parsedFailedChecks: unknown = parsedResult.failedChecks;
		if (Array.isArray(parsedFailedChecks)) {
			for (const failedCheck of parsedFailedChecks) {
				failedChecks.push({
					code: String(parsedResult.validationStatus ?? "tool_failed_check"),
					message: String(failedCheck),
					toolCallId: observation.toolCallId,
					toolName: observation.toolName,
					artifact: observation.artifactRefs?.[0]
				});
			}
		} else if (observation.status === "failed") {
			failedChecks.push({
				code: String(parsedResult.validationStatus ?? "tool_failed"),
				message: String(parsedResult.summary ?? `${observation.toolName} failed`),
				toolCallId: observation.toolCallId,
				toolName: observation.toolName,
				artifact: observation.artifactRefs?.[0]
			});
		}
	}

	if (
		phase.toolGroup === "summarize"
		&& observations.length === 0
		&& SUMMARY_TOOL_INTENT_PATTERN.test(agentResultText)
		&& TOOL_REFERENCE_PATTERN.test(agentResultText)
	) {
		failedChecks.push({
			code: "summary_requested_tool",
			message: "总结阶段输出了工具调用预告或后续读取动作，但 summarize 阶段不能调用工具，也不能把未执行动作当作最终交付。",
			severity: "error"
		});
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

	const expected: string = normalizeTargetValue(target.path);
	const expectedIsBareFilename: boolean = !expected.includes("/");
	return observationTargetValues(observation).some((value: string): boolean => (
		value === expected || (expectedIsBareFilename && value.endsWith(`/${expected}`))
	));
}

function isSuccessfulMutation(observation: WorkflowToolObservation): boolean {
	return observation.status === "succeeded" && (observation.risk === "write" || observation.risk === "destructive");
}

function isReadbackObservation(observation: WorkflowToolObservation): boolean {
	return observation.risk === "read"
		|| observation.risk === "verify"
		|| observation.toolName.includes("read_text_file")
		|| observation.toolName.includes("inspect_scene_tree");
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
				message: target.kind === "artifact"
					? `写入阶段没有实际创建或修改目标文件 ${target.path}。`
					: `写入阶段没有实际修改目标项目设置 ${target.key}。`,
				artifact: target.kind === "artifact" ? target.path : target.key,
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
				message: target.kind === "artifact"
					? `目标文件 ${target.path} 的回读或检查失败。`
					: `目标项目设置 ${target.key} 的回读失败。`,
				artifact: target.kind === "artifact" ? target.path : target.key,
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

	return uniqueStrings(failedChecks.map((check: WorkflowFailedCheck): string => `修复：${check.message}`));
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
		if (!hasSuccessfulVerificationObservation(observations) && !hasEnvironmentIssueObservation(observations)) {
			return "blocked";
		}
	}

	if (phase.toolGroup === "summarize" && failedChecks.length > 0) {
		return "blocked";
	}

	if (failedChecks.length > 0) {
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
	const summaries: string[] = failedChecks.some((check: WorkflowFailedCheck): boolean => check.code === "summary_requested_tool")
		? failedChecks.map((check: WorkflowFailedCheck): string => check.message)
		: collectSummaries(observations);
	const blockedReason: string | undefined = status === "blocked"
		? (phase.toolGroup === "verify"
			? hasEnvironmentIssueObservation(observations)
				? "验证环境不可用，且没有其它成功的可判定验证结果。"
				: "验证阶段没有运行任何可判定的验证工具。"
			: summaries[0])
		: undefined;
	const trimmedAgentText: string = agentResultText.trim();
	const environmentWarnings: string[] = phase.toolGroup === "verify"
		? collectEnvironmentWarnings(observations)
		: [];
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
				message: blockedReason ?? "验证阶段缺少验证工具结果。"
			}]
			: failedChecks,
		requiredFixes: createRequiredFixes(failedChecks),
		modifiedArtifacts: collectArtifacts(observations, ["write", "destructive"]),
		verifiedArtifacts: uniqueStrings(observations
			.filter((observation: WorkflowToolObservation): boolean => isVerificationObservation(observation) && observation.status === "succeeded")
			.flatMap((observation: WorkflowToolObservation): string[] => observation.artifactRefs ?? [])),
		toolObservations: observations.map((observation: WorkflowToolObservation): WorkflowToolObservation => ({ ...observation })),
		verificationStatus: phase.toolGroup === "verify"
			? environmentWarnings.length > 0 ? "unverified" : "verified"
			: undefined,
		warnings: environmentWarnings.length > 0 ? environmentWarnings : undefined,
		text: agentResultText,
		sourcePhaseId: phase.repairOf,
		blockedReason
	};
}

function observationMatchesTool(observation: WorkflowToolObservation, toolName: string): boolean {
	return observation.toolName === toolName
		&& observation.status === "succeeded"
		&& observation.parsedResult?.validationStatus !== "not_applicable";
}

function observationPresetName(observation: WorkflowToolObservation): string {
	const presetName: unknown = observation.argsSummary?.presetName;
	return typeof presetName === "string" ? presetName.toLowerCase() : "";
}

function hasLspDiagnostics(observations: WorkflowToolObservation[]): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => (
		observationMatchesTool(observation, "mcp_godot_lsp_get_file_diagnostics")
	));
}

function hasLspEnvironmentIssue(observations: WorkflowToolObservation[]): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => (
		observation.toolName.startsWith("mcp_godot_lsp_") && isEnvironmentIssueObservation(observation)
	));
}

function hasGodotCheckOnly(observations: WorkflowToolObservation[]): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => (
		(
			observationMatchesTool(observation, "mcp_terminal_run_safe_preset")
			|| observationMatchesTool(observation, "mcp_terminal_run_write_preset")
		)
		&& observationPresetName(observation).includes("check_only")
	));
}

function hasGodotCheckOnlyEnvironmentIssue(observations: WorkflowToolObservation[]): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => (
		(
			observation.toolName === "mcp_terminal_run_safe_preset"
			|| observation.toolName === "mcp_terminal_run_write_preset"
		)
		&& observationPresetName(observation).includes("check_only")
		&& isEnvironmentIssueObservation(observation)
	));
}

function hasSceneValidation(observations: WorkflowToolObservation[]): boolean {
	return observations.some((observation: WorkflowToolObservation): boolean => (
		observationMatchesTool(observation, "mcp_godot_validate_scene_script_references")
		|| (
			observationMatchesTool(observation, "mcp_terminal_run_safe_preset")
			&& (observationPresetName(observation).includes("validate_scene") || observationPresetName(observation).includes("scene"))
		)
	));
}

function collectPreviouslyModifiedArtifacts(outputs: WorkflowPhaseOutput[]): string[] {
	return uniqueStrings(outputs.flatMap((output: WorkflowPhaseOutput): string[] => output.modifiedArtifacts));
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

function createGateFailure(code: string, message: string, artifact: string): WorkflowFailedCheck {
	return {
		code,
		message,
		artifact,
		severity: "error"
	};
}

export function applyDeterministicVerificationGate(
	phase: WorkflowPhase,
	outcome: WorkflowPhaseOutput,
	previousOutputs: WorkflowPhaseOutput[]
): WorkflowPhaseOutput {
	if (phase.toolGroup !== "verify" || outcome.status !== "completed") {
		return outcome;
	}

	const modifiedArtifacts: string[] = collectPreviouslyModifiedArtifacts(previousOutputs);
	const gdArtifacts: string[] = modifiedArtifacts.filter((artifact: string): boolean => artifact.endsWith(".gd"));
	const sceneArtifacts: string[] = modifiedArtifacts.filter((artifact: string): boolean => artifact.endsWith(".tscn"));
	const verificationObservations: WorkflowToolObservation[] = collectVerificationObservations(outcome, previousOutputs);
	const gateFailures: WorkflowFailedCheck[] = [];

	if (gdArtifacts.length > 0 && !hasLspDiagnostics(verificationObservations) && !hasLspEnvironmentIssue(verificationObservations)) {
		gateFailures.push(createGateFailure(
			"lsp_diagnostics_required",
			"修改了 GDScript，但验证阶段没有运行 LSP diagnostics。",
			gdArtifacts.join(", ")
		));
	}
	if (gdArtifacts.length > 0 && !hasGodotCheckOnly(verificationObservations) && !hasGodotCheckOnlyEnvironmentIssue(verificationObservations)) {
		gateFailures.push(createGateFailure(
			"godot_check_only_required",
			"修改了 GDScript，但验证阶段没有运行 Godot check-only。",
			gdArtifacts.join(", ")
		));
	}
	if (gdArtifacts.length > 0 && !hasGodotCheckOnly(verificationObservations) && hasGodotCheckOnlyEnvironmentIssue(verificationObservations)) {
		gateFailures.push(createGateFailure(
			"validation_environment_unavailable",
			"Godot check-only 验证环境不可用，无法判定 GDScript 写入结果。",
			gdArtifacts.join(", ")
		));
	}
	if (sceneArtifacts.length > 0 && !hasSceneValidation(verificationObservations)) {
		gateFailures.push(createGateFailure(
			"scene_validation_required",
			"修改了场景文件，但验证阶段没有运行场景验证。",
			sceneArtifacts.join(", ")
		));
	}

	if (gateFailures.length === 0) {
		return outcome;
	}

	const environmentFailures: WorkflowFailedCheck[] = gateFailures.filter((failure: WorkflowFailedCheck): boolean => failure.code === "validation_environment_unavailable");
	const actionableFailures: WorkflowFailedCheck[] = gateFailures.filter((failure: WorkflowFailedCheck): boolean => failure.code !== "validation_environment_unavailable");
	const failedChecks: WorkflowFailedCheck[] = [...outcome.failedChecks, ...actionableFailures];
	const summary: string = gateFailures.map((failure: WorkflowFailedCheck): string => failure.message).join("\n");
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

export function findBlockingOutcomeBeforeSummarize(outputs: WorkflowPhaseOutput[], currentPhaseId?: string | undefined): WorkflowPhaseOutput | null {
	for (let index: number = outputs.length - 1; index >= 0; index -= 1) {
		const output: WorkflowPhaseOutput | undefined = outputs[index];
		if (output === undefined) {
			continue;
		}
		if (currentPhaseId !== undefined && output.phaseId === currentPhaseId) {
			continue;
		}
		if (output.status === "completed") {
			return null;
		}
		if (output.status === "needs_fix" || output.status === "blocked" || output.status === "failed" || output.status === "approval_required") {
			return output;
		}
	}

	return null;
}
