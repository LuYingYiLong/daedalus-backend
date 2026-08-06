export const DEFAULT_TOOL_STEPS: number = 16;

export type ToolBudgetLevel = "simple" | "normal" | "codegen" | "project_edit";

const TOOL_BUDGET_MAP: Record<ToolBudgetLevel, number> = {
	simple: 10,
	normal: 20,
	codegen: 32,
	project_edit: 48
};

const SKILL_BUDGET_MAP: Record<string, number> = {
	"gdscript.review": 12,
	"godot.project_init": 20,
	"file.creator": 24,
	"scene.builder": 32,
	"backend.helper": 16,
	"builtin:gdscript-review": 12,
	"builtin:godot-project-init": 20,
	"builtin:file-creator": 24,
	"builtin:scene-builder": 32,
	"builtin:backend-helper": 16,
	"builtin:skill-creator": 24
};

export function resolveToolBudget(
	budgetLevel?: ToolBudgetLevel | string,
	skillId?: string
): number {
	if (budgetLevel && TOOL_BUDGET_MAP[budgetLevel as ToolBudgetLevel]) {
		return TOOL_BUDGET_MAP[budgetLevel as ToolBudgetLevel];
	}

	if (skillId && SKILL_BUDGET_MAP[skillId]) {
		return SKILL_BUDGET_MAP[skillId];
	}

	return DEFAULT_TOOL_STEPS;
}

export const MAX_TOOL_RESULT_CHARS: number = 24000;
export const MAX_TOTAL_TOOL_RESULT_CHARS: number = 128000;
/** Chat answers need room for history, system prompts, and finalization. */
export const CHAT_TOOL_RESULT_CHAR_LIMIT: number = 48000;
export const TOOL_BUDGET_CONTINUE_STEPS: number = 16;
export const TOOL_RESULT_CONTINUE_CHARS: number = 64000;
