import type { PromptId } from "../protocol/types.js";
import { getRuntimeAssetKeyForSourcePath, readRuntimeAssetText } from "../runtime/runtime-assets.js";

export type PromptTemplate = {
	id: PromptId;
	name: string;
	description: string;
	path: string;
};

export const DEFAULT_PROMPT_ID: PromptId = "godot.assistant";

export const promptTemplates: Record<PromptId, PromptTemplate> = {
	"godot.assistant": {
		id: "godot.assistant",
		name: "Daedalus Assistant",
		description: "General Daedalus assistant with strong Godot project support",
		path: "src/prompts/templates/base/godot-assistant.md"
	},
	"gdscript.reviewer": {
		id: "gdscript.reviewer",
		name: "GDScript Reviewer",
		description: "Reviews GDScript code for type safety and style issues",
		path: "src/prompts/templates/base/gdscript-reviewer.md"
	},
	"scene.architect": {
		id: "scene.architect",
		name: "Scene Architect",
		description: "Designs Godot scene structures following scene-first principles",
		path: "src/prompts/templates/base/scene-architect.md"
	},
	"backend.helper": {
		id: "backend.helper",
		name: "Backend Helper",
		description: "TypeScript backend development for the AI Runtime",
		path: "src/prompts/templates/base/backend-helper.md"
	},
	"git.committer": {
		id: "git.committer",
		name: "Git Committer",
		description: "Generates concise Git commit messages from workspace diffs",
		path: "src/prompts/templates/base/git-committer.md"
	},
};

const promptContentCache: Map<PromptId, string> = new Map();
const extraPromptContentCache: Map<string, string> = new Map();

export const promptModeTemplatePaths = [
	"src/prompts/templates/modes/agent-mode.md",
	"src/prompts/templates/modes/ask-mode.md"
] as const;

export const promptFragmentPaths = [
	"src/prompts/templates/fragments/CORE.md",
	"src/prompts/templates/fragments/custom-instructions-boundary.md"
] as const;

export const internalPromptTemplatePaths = [
	"src/prompts/templates/internal/session-compressor.md"
] as const;

export const promptTemplatePaths: readonly string[] = [
	...Object.values(promptTemplates).map((template: PromptTemplate): string => template.path),
	...promptModeTemplatePaths
];

const MODE_PROMPT_PATHS: Partial<Record<"agent" | "ask" | "plan" | "goal", string>> = {
	agent: promptModeTemplatePaths[0],
	ask: promptModeTemplatePaths[1],
	goal: promptModeTemplatePaths[0]
};
const CORE_PROMPT_PATH: string = promptFragmentPaths[0];
const CUSTOM_INSTRUCTIONS_BOUNDARY_PROMPT_PATH: string = promptFragmentPaths[1];
const MODE_LABELS: Record<"agent" | "ask" | "plan" | "goal", string> = {
	agent: "Agent",
	ask: "Ask",
	plan: "Plan",
	goal: "Goal"
};

export function formatRuntimeDate(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// 创建运行时日期提示词（无隐写术:D）
export function createRuntimeDatePrompt(date: Date = new Date()): string {
	return [
		"## Runtime current date",
		"",
		`Today's ${formatRuntimeDate(date)}.`
	].join("\n");
}

export function listPromptTemplates(): PromptTemplate[] {
	return Object.values(promptTemplates);
}

export async function loadPromptTemplate(promptId: PromptId): Promise<string> {
	const cachedContent: string | undefined = promptContentCache.get(promptId);
	if (cachedContent !== undefined) {
		return cachedContent;
	}

	const template: PromptTemplate = promptTemplates[promptId];
	const content: string = await readRuntimeAssetText(getRuntimeAssetKeyForSourcePath(template.path));
	const trimmedContent: string = content.trim();
	promptContentCache.set(promptId, trimmedContent);
	return trimmedContent;
}

async function loadExtraPromptTemplate(templatePath: string): Promise<string> {
	const cachedContent: string | undefined = extraPromptContentCache.get(templatePath);
	if (cachedContent !== undefined) {
		return cachedContent;
	}

	const content: string = await readRuntimeAssetText(getRuntimeAssetKeyForSourcePath(templatePath));
	const trimmedContent: string = content.trim();
	extraPromptContentCache.set(templatePath, trimmedContent);
	return trimmedContent;
}

export async function composeSystemPrompt(
	promptId: PromptId | undefined,
	extraSystemPrompt: string | undefined,
	runtimeContext: string = "",
	chatMode: "agent" | "ask" | "plan" | "goal" | undefined = undefined
): Promise<string> {
	const templateContent: string = await loadPromptTemplate(promptId ?? DEFAULT_PROMPT_ID);
	const trimmedExtraPrompt: string = extraSystemPrompt?.trim() ?? "";
	const trimmedRuntimeContext: string = runtimeContext.trim();
	const runtimeContextSection: string = trimmedRuntimeContext.length > 0
		? `\n\n## Runtime 当前模型上下文\n\n${trimmedRuntimeContext}`
		: "";
	const modePromptPath: string | undefined = chatMode === undefined
		? undefined
		: MODE_PROMPT_PATHS[chatMode];
	const modePrompt: string = modePromptPath !== undefined
		? await loadExtraPromptTemplate(modePromptPath)
		: "";
	const modeFactSection: string = chatMode === undefined
		? ""
		: [
			"## Runtime 会话模式事实",
			"",
			`- conversationMode: ${chatMode}`,
			`- 当前对话模式是 ${MODE_LABELS[chatMode]} 模式。`,
			"- 这是后端协议传入的运行时事实，是判断当前模式的唯一来源。",
			"- 当前 workflow 阶段的 allowedTools、实际可用工具数量、审批等待状态或只读阶段都不是会话模式来源。",
			`- 如果用户询问当前模式，必须回答当前是 ${MODE_LABELS[chatMode]} 模式；不要根据工具列表、历史助手消息或阶段名称推断成其他模式。`
		].join("\n");
	const modeSection: string = modePrompt.length > 0
		? `\n\n## 当前对话模式\n\n${modePrompt}`
		: "";
	const corePrompt: string = await loadCorePrompt();
	const runtimeDatePrompt: string = createRuntimeDatePrompt();
	const prioritizedTemplateContent: string = `${corePrompt}\n\n${runtimeDatePrompt}\n\n${templateContent}${runtimeContextSection}${modeFactSection.length > 0 ? `\n\n${modeFactSection}` : ""}${modeSection}`;

	if (trimmedExtraPrompt.length === 0) {
		return prioritizedTemplateContent;
	}

	const customInstructionsBoundaryPrompt: string = await loadExtraPromptTemplate(CUSTOM_INSTRUCTIONS_BOUNDARY_PROMPT_PATH);
	return `${prioritizedTemplateContent}\n\n## Settings 用户提示词（本轮生效）\n\n${customInstructionsBoundaryPrompt}\n\n${trimmedExtraPrompt}`;
}

export async function loadCorePrompt(): Promise<string> {
	return loadExtraPromptTemplate(CORE_PROMPT_PATH);
}
