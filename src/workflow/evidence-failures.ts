import type { ExecutionEvidence } from "./agent-run-state.js";

function collectEvidenceTargetKeys(evidence: ExecutionEvidence): Set<string> {
	return new Set([
		...(evidence.artifactFileRefs ?? []).map((fileRef): string => (
			`${fileRef.workspaceId}:${fileRef.sourceFolderId}:${fileRef.relativePath}`
		)),
		...evidence.artifactRefs.map((artifact: string): string => `${evidence.sourceFolderId ?? ""}:${artifact}`)
	]);
}

function isResolvedByLaterEvidence(
	failure: ExecutionEvidence,
	index: number,
	evidence: readonly ExecutionEvidence[]
): boolean {
	const failureTargets: Set<string> = collectEvidenceTargetKeys(failure);
	return evidence.slice(index + 1).some((candidate: ExecutionEvidence): boolean => {
		if (candidate.status !== "succeeded") return false;
		if (
			failure.recovery?.recoveryKey !== undefined
			&& candidate.recovery?.status === "recovered"
			&& candidate.recovery.recoveryKey === failure.recovery.recoveryKey
		) {
			return true;
		}
		const candidateTargets: Set<string> = collectEvidenceTargetKeys(candidate);
		if (failureTargets.size > 0 && candidateTargets.size > 0) {
			return [...failureTargets].some((target: string): boolean => candidateTargets.has(target));
		}
		return false;
	});
}

export function collectUnresolvedExecutionFailures(
	evidence: readonly ExecutionEvidence[]
): ExecutionEvidence[] {
	return evidence.filter((item: ExecutionEvidence, index: number): boolean => (
		item.status === "failed"
		&& item.failure?.category !== "environment"
		&& !isResolvedByLaterEvidence(item, index, evidence)
	));
}

export function formatExecutionFailure(evidence: ExecutionEvidence): string {
	return evidence.failure === undefined
		? evidence.summary ?? `${evidence.toolName} failed`
		: `[${evidence.failure.code}] ${evidence.failure.message}`;
}
