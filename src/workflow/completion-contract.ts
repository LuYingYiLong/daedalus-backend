import type { WorkflowCompletionContract, WorkflowCompletionTarget, WorkflowToolGroup } from "./types.js";
import type { WorkflowTargetKind } from "./tool-semantics.js";

export type StructuredCompletionTargets = {
	/** String entries are accepted only while reading old in-process callers; they carry no repair semantics. */
	artifacts?: readonly (StructuredArtifactTarget | string)[] | undefined;
	projectSettings?: readonly string[] | undefined;
	sourceFolderId?: string | undefined;
};

export type StructuredArtifactTarget = {
	path: string;
	targetKind: Exclude<WorkflowTargetKind, "project_setting">;
};

const INVALID_ARTIFACT_PATH_CHARACTERS: RegExp = /[\u0000-\u001f<>:"|?*()[\]{}（）]/u;
const PROJECT_SETTING_KEY_PATTERN: RegExp = /^(?:application|display|rendering|physics|audio|network|editor|debug|input|autoload)\/[A-Za-z0-9_.\/-]+$/u;
const ARTIFACT_PATH_PATTERN: RegExp = /(?:^|\/)\.?[\p{L}\p{N}_ -]+(?:\.[\p{L}\p{N}_-]+)+$/u;

/** 仅接受可被工作区工具安全定位的相对文件路径。 */
export function normalizeWorkspaceRelativeArtifactPath(value: string): string | undefined {
	const normalized: string = value.trim()
		.replace(/^res:\/\//iu, "")
		.replaceAll("\\", "/")
		.replace(/^\.\//u, "");
	if (
		normalized.length === 0
		|| normalized.length > 260
		|| normalized.startsWith("/")
		|| normalized.startsWith("//")
		|| INVALID_ARTIFACT_PATH_CHARACTERS.test(normalized)
		|| !ARTIFACT_PATH_PATTERN.test(normalized)
	) {
		return undefined;
	}

	const segments: string[] = normalized.split("/");
	if (segments.some((segment: string): boolean => segment.length === 0 || segment === "." || segment === ".." || segment !== segment.trim())) {
		return undefined;
	}
	return normalized;
}

export function normalizeProjectSettingKey(value: string): string | undefined {
	const normalized: string = value.trim().replaceAll("\\", "/");
	return PROJECT_SETTING_KEY_PATTERN.test(normalized) ? normalized : undefined;
}

export function isValidWorkflowCompletionTarget(target: WorkflowCompletionTarget): boolean {
	return target.kind === "artifact"
		? normalizeWorkspaceRelativeArtifactPath(target.path) !== undefined
		: normalizeProjectSettingKey(target.key) !== undefined;
}

/** LLM 只能声明结构化、可验证的目标；文本指令不参与权限或完成判定。 */
export function createStructuredWorkflowCompletionContract(
	toolGroup: WorkflowToolGroup,
	targets: StructuredCompletionTargets | undefined
): WorkflowCompletionContract | undefined {
	if (toolGroup !== "write" || targets === undefined) {
		return undefined;
	}

	const completionTargets: WorkflowCompletionTarget[] = [
		...(targets.artifacts ?? []).flatMap((artifact: StructuredArtifactTarget | string): WorkflowCompletionTarget[] => {
			const path: string | undefined = normalizeWorkspaceRelativeArtifactPath(typeof artifact === "string" ? artifact : artifact.path);
			return path === undefined ? [] : [{ kind: "artifact", path, ...(typeof artifact === "string" ? {} : { targetKind: artifact.targetKind }), ...(targets.sourceFolderId === undefined ? {} : { sourceFolderId: targets.sourceFolderId }) }];
		}),
		...(targets.projectSettings ?? []).flatMap((projectSetting: string): WorkflowCompletionTarget[] => {
			const key: string | undefined = normalizeProjectSettingKey(projectSetting);
			return key === undefined ? [] : [{ kind: "project_setting", key, ...(targets.sourceFolderId === undefined ? {} : { sourceFolderId: targets.sourceFolderId }) }];
		})
	];
	if (completionTargets.length === 0) {
		return undefined;
	}
	return { targets: completionTargets, requireAll: true };
}
