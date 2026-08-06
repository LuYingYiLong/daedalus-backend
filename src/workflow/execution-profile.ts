import type { PromptId } from "../protocol/types.js";
import type { SkillId } from "../skills/registry.js";
import { getDefaultWorkflowToolNames } from "../tools/tool-catalog.js";
import type { WorkflowToolGroup } from "./types.js";

export const workflowExecutionProfileIds = ["godot", "workspace"] as const;

export type WorkflowExecutionProfileId = typeof workflowExecutionProfileIds[number];

export type WorkflowExecutionProfile = {
	readonly id: WorkflowExecutionProfileId;
	readonly promptId: PromptId;
	readonly writeSkillId?: SkillId | undefined;
	readonly reviewPromptId: PromptId;
	readonly reviewSkillId?: SkillId | undefined;
};

const WORKFLOW_EXECUTION_PROFILES: Record<WorkflowExecutionProfileId, WorkflowExecutionProfile> = {
	godot: {
		id: "godot",
		promptId: "godot.assistant",
		writeSkillId: "file.creator",
		reviewPromptId: "gdscript.reviewer",
		reviewSkillId: "gdscript.review"
	},
	workspace: {
		id: "workspace",
		promptId: "workspace.assistant",
		reviewPromptId: "workspace.assistant"
	}
};

export function getWorkflowExecutionProfile(id: WorkflowExecutionProfileId | undefined): WorkflowExecutionProfile {
	return WORKFLOW_EXECUTION_PROFILES[id ?? "godot"];
}

export function resolveWorkflowExecutionProfile(isGodotProject: boolean): WorkflowExecutionProfileId {
	return isGodotProject ? "godot" : "workspace";
}

export function getWorkflowToolsForProfile(
	executionProfile: WorkflowExecutionProfileId,
	toolGroup: WorkflowToolGroup
): string[] {
	if (toolGroup === "summarize") return [];
	const tools: readonly string[] = getDefaultWorkflowToolNames(toolGroup);
	const profileTools: readonly string[] = executionProfile === "godot"
		? tools
		: tools.filter((toolName: string): boolean => !toolName.startsWith("mcp_godot_"));
	// LSP is an optional live-editor diagnostic. A workflow verifier must remain
	// runnable when the editor is closed, so only explicit diagnostic requests expose it.
	return toolGroup === "verify"
		? profileTools.filter((toolName: string): boolean => toolName !== "mcp_godot_lsp_get_file_diagnostics")
		: [...profileTools];
}
