import type { AiChatParams } from "../protocol/types.js";
import { getPlanSafeDynamicMcpToolNames } from "../tools/dynamic-mcp-tools.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../tools/tool-sentinels.js";
import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../workflow/tool-sets.js";

export function resolveAllowedToolsForChatParams(
	params: AiChatParams,
	activeSkillTools: readonly string[] | undefined,
	workspaceId?: string | undefined
): readonly string[] | undefined {
	if (params.mode === "ask" || params.mode === "plan") {
		return [
			...READ_TOOLS.filter((toolName: string): boolean => toolName !== CUSTOM_MCP_TOOLS_SENTINEL),
			...VERIFY_TOOLS,
			...getPlanSafeDynamicMcpToolNames(workspaceId)
		];
	}

	if (activeSkillTools !== undefined) {
		return activeSkillTools;
	}

	if (params.options?.toolBudget === "project_edit") {
		return [...READ_TOOLS, ...WRITE_TOOLS, ...VERIFY_TOOLS];
	}

	return undefined;
}

export function normalizeChatParamsForMode(params: AiChatParams): AiChatParams {
	if (params.mode !== "ask" && params.mode !== "plan") {
		return params;
	}

	const { workflow: _legacyWorkflow, ...modeOptions } = params.options ?? {};
	return {
		...params,
		options: {
			...modeOptions,
			toolBudget: "normal"
		}
	};
}
