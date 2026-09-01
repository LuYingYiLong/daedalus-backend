import type { PromptId } from "../protocol/types.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../tools/tool-sentinels.js";
import { getRuntimeAssetKeyForSourcePath, readRuntimeAssetText } from "../runtime/runtime-assets.js";
import { parseSkillDocument } from "./frontmatter.js";

export const skillIds = [
	"godot.project_init",
	"gdscript.review",
	"scene.builder",
	"file.creator",
	"backend.helper",
	"skill.creator",
	"plugin.creator",
	"image.gen"
] as const;

export type SkillId = typeof skillIds[number];

export type Skill = {
	id: SkillId;
	name: string;
	description: string;
	promptPath: string;
	defaultPromptId?: PromptId;
	allowedTools: string[];
};

const READ_TOOLS: string[] = [
	"mcp_skills_load",
	"mcp_image_inspect",
	"mcp_godot_runtime_status",
	"mcp_godot_get_godot_version",
	"mcp_godot_search_documentation",
	"mcp_godot_get_debug_output",
	"mcp_godot_list_projects",
	"mcp_godot_get_project_summary",
	"mcp_godot_list_project_files",
	"mcp_godot_list_scenes",
	"mcp_godot_list_scripts",
	"mcp_godot_read_text_file",
	"mcp_godot_search_text",
	"mcp_godot_get_project_log_config",
	"mcp_godot_list_project_logs",
	"mcp_godot_read_project_log",
	"mcp_godot_get_project_settings",
	"mcp_godot_get_editor_config_summary",
	"mcp_godot_get_editor_settings",
	"mcp_godot_list_editor_config_files",
	"mcp_godot_read_editor_config_file",
	"mcp_godot_get_editor_project_state",
	"mcp_godot_get_recent_projects",
	"mcp_godot_get_uid",
	"mcp_godot_inspect_scene_tree",
	"mcp_godot_editor_get_context",
	"mcp_godot_editor_get_selected_nodes",
	"mcp_godot_editor_inspect_node",
	"mcp_godot_editor_capture_scene_view",
	"mcp_godot_lsp_get_status",
	"mcp_godot_lsp_get_file_diagnostics",
	"mcp_godot_lsp_get_document_symbols",
	"mcp_godot_lsp_hover",
	"mcp_godot_lsp_goto_definition",
	"mcp_godot_dap_get_status",
	"mcp_godot_dap_get_last_error",
	"mcp_godot_dap_get_stack_trace",
	"mcp_godot_dap_get_variables",
	CUSTOM_MCP_TOOLS_SENTINEL
];

const FILE_CREATE_TOOLS: string[] = [
	"mcp_godot_propose_create_text_file",
	"mcp_godot_create_text_file"
];

const VERIFY_TOOLS: string[] = [
	"mcp_godot_lsp_get_file_diagnostics",
	"mcp_terminal_run_safe_preset"
];

const TERMINAL_WRITE_TOOLS: string[] = [
	"mcp_terminal_run_write_preset",
	"mcp_terminal_run_godot_scene_script"
];

const HEADLESS_RESOURCE_WRITE_TOOLS: string[] = [
	"mcp_godot_resave_resource",
	"mcp_godot_update_project_uids",
	"mcp_godot_save_scene_variant",
	"mcp_godot_load_sprite_texture",
	"mcp_godot_export_mesh_library"
];

const FILE_EDIT_TOOLS: string[] = [
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_propose_replace_text_in_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_propose_set_project_setting",
	"mcp_godot_set_project_setting",
	"mcp_godot_propose_unset_project_setting",
	"mcp_godot_unset_project_setting"
];

const SCENE_WRITE_TOOLS: string[] = [
	"mcp_godot_propose_create_scene",
	"mcp_godot_create_scene",
	"mcp_godot_propose_add_node_to_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_propose_attach_script_to_node",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_propose_connect_signal_in_scene",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_propose_apply_scene_patch",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch"
];

const IMAGE_GENERATION_TOOLS: string[] = [
	"mcp_image_generate",
	"mcp_image_propose_import_to_workspace",
	"mcp_image_import_to_workspace",
	"mcp_image_replace_workspace_asset"
];

const PLUGIN_DEVELOPMENT_TOOLS: string[] = [
	"mcp_plugin_dev_prepare",
	"mcp_plugin_dev_apply",
	"mcp_plugin_dev_validate",
	"mcp_plugin_dev_install",
	"mcp_plugin_dev_test"
];

const PLUGIN_DEVELOPMENT_READ_TOOLS: string[] = [
	"mcp_workspace_list_files",
	"mcp_workspace_list_source_folders",
	"mcp_workspace_get_source_context",
	"mcp_workspace_read_text_file",
	"mcp_workspace_search_text"
];

const skills: Record<SkillId, Skill> = {
	"godot.project_init": {
		id: "godot.project_init",
		name: "Godot Project Init",
		description: "Inspect the Godot project and create an AGENTS.md project guide.",
		promptPath: "src/skills/builtin/godot-project-init/SKILL.md",
		defaultPromptId: "godot.assistant",
		allowedTools: [...READ_TOOLS, ...FILE_CREATE_TOOLS, ...FILE_EDIT_TOOLS, ...HEADLESS_RESOURCE_WRITE_TOOLS, ...VERIFY_TOOLS, ...TERMINAL_WRITE_TOOLS]
	},
	"gdscript.review": {
		id: "gdscript.review",
		name: "GDScript Review",
		description: "Review GDScript for type safety, Godot lifecycle issues, signals, and style.",
		promptPath: "src/skills/builtin/gdscript-review/SKILL.md",
		defaultPromptId: "gdscript.reviewer",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS]
	},
	"scene.builder": {
		id: "scene.builder",
		name: "Scene Builder",
		description: "Plan Godot scene structures and node responsibilities.",
		promptPath: "src/skills/builtin/scene-builder/SKILL.md",
		defaultPromptId: "scene.architect",
		allowedTools: [...READ_TOOLS, ...SCENE_WRITE_TOOLS, ...HEADLESS_RESOURCE_WRITE_TOOLS, ...FILE_CREATE_TOOLS, ...VERIFY_TOOLS, ...TERMINAL_WRITE_TOOLS]
	},
	"file.creator": {
		id: "file.creator",
		name: "File Creator",
		description: "Create new project files through approval-gated tools.",
		promptPath: "src/skills/builtin/file-creator/SKILL.md",
		defaultPromptId: "godot.assistant",
		allowedTools: [...READ_TOOLS, ...FILE_CREATE_TOOLS, ...FILE_EDIT_TOOLS, ...HEADLESS_RESOURCE_WRITE_TOOLS, ...VERIFY_TOOLS, ...TERMINAL_WRITE_TOOLS]
	},
	"backend.helper": {
		id: "backend.helper",
		name: "Backend Helper",
		description: "Work on the TypeScript WebSocket/MCP backend.",
		promptPath: "src/skills/builtin/backend-helper/SKILL.md",
		defaultPromptId: "backend.helper",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS]
	},
	"skill.creator": {
		id: "skill.creator",
		name: "Skill Creator",
		description: "Create a reusable project or personal skill through approval-gated tools.",
		promptPath: "src/skills/builtin/skill-creator/SKILL.md",
		defaultPromptId: "godot.assistant",
		allowedTools: [...READ_TOOLS, "mcp_skills_load", "mcp_skills_propose_create", "mcp_skills_create"]
	},
	"plugin.creator": {
		id: "plugin.creator",
		name: "Plugin Creator",
		description: "Design, generate, validate, install, review, and test a Daedalus Native plugin.",
		promptPath: "src/skills/builtin/plugin-creator/SKILL.md",
		defaultPromptId: "backend.helper",
		allowedTools: [...READ_TOOLS, ...PLUGIN_DEVELOPMENT_READ_TOOLS, ...PLUGIN_DEVELOPMENT_TOOLS]
	},
	"image.gen": {
		id: "image.gen",
		name: "Image Generator",
		description: "Generate session images and optionally import them into the active workspace.",
		promptPath: "src/skills/builtin/image-gen/SKILL.md",
		defaultPromptId: "godot.assistant",
		allowedTools: [...IMAGE_GENERATION_TOOLS]
	}
};

const skillPromptCache: Map<SkillId, string> = new Map();

export function listSkills(): Skill[] {
	return Object.values(skills);
}

export function isSkillId(value: string): value is SkillId {
	return (skillIds as readonly string[]).includes(value);
}

export function getSkill(skillId: SkillId): Skill {
	return skills[skillId];
}

export async function loadSkillPrompt(skillId: SkillId): Promise<string> {
	const cachedPrompt: string | undefined = skillPromptCache.get(skillId);
	if (cachedPrompt !== undefined) {
		return cachedPrompt;
	}

	const skill: Skill = getSkill(skillId);
	const content: string = await readRuntimeAssetText(getRuntimeAssetKeyForSourcePath(skill.promptPath));
	const trimmedContent: string = parseSkillDocument(content).body;
	skillPromptCache.set(skillId, trimmedContent);
	return trimmedContent;
}

export async function composeSkillPrompt(skillId: SkillId | undefined): Promise<string> {
	if (skillId === undefined) {
		return "";
	}

	const skill: Skill = getSkill(skillId);
	const prompt: string = await loadSkillPrompt(skillId);
	return [
		"## 当前激活 Skill",
		`- ID: ${skill.id}`,
		`- 名称: ${skill.name}`,
		`- 描述: ${skill.description}`,
		"- 允许工具:",
		...skill.allowedTools
			.filter((toolName: string): boolean => toolName !== CUSTOM_MCP_TOOLS_SENTINEL)
			.map((toolName: string): string => `  - ${toolName}`),
		"",
		prompt
	].join("\n");
}
