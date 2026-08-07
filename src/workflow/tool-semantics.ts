/** Workflow-only semantics. These values are deliberately independent from tool display names. */
export const workflowTargetKinds = ["workspace_file", "godot_script", "godot_scene", "project_setting"] as const;
export type WorkflowTargetKind = typeof workflowTargetKinds[number];

export type WorkflowToolExecutionRole = "verification";
export type WorkflowValidationScope = "workspace" | "artifacts";

export const workflowValidationCapabilities = [
	"artifact_readback",
	"workspace_typecheck",
	"godot_script_check",
	"godot_scene_reference_check"
] as const;
export type WorkflowValidationCapability = typeof workflowValidationCapabilities[number];

export type WorkflowToolSemantics = {
	readonly validationCapabilities?: readonly WorkflowValidationCapability[];
	readonly repairFamilies?: readonly WorkflowTargetKind[];
	readonly executionRole?: WorkflowToolExecutionRole;
	readonly validationScope?: WorkflowValidationScope;
	readonly artifactRefs?: readonly string[];
};

function tokenizeSingleCommand(commandLine: string): string[] | null {
	const tokens: string[] = [];
	let token: string = "";
	let quote: "'" | '"' | null = null;
	const flush = (): void => {
		if (token.length > 0) {
			tokens.push(token);
			token = "";
		}
	};

	for (const character of commandLine.trim()) {
		if (quote !== null) {
			if (character === quote) {
				quote = null;
			} else {
				token += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			flush();
			continue;
		}
		if (";&|<>".includes(character)) {
			return null;
		}
		token += character;
	}
	if (quote !== null) return null;
	flush();
	return tokens;
}

function normalizeExplicitCommandArtifact(value: string): string | null {
	const normalized: string = value.replaceAll("\\", "/").replace(/^\.\//u, "");
	if (
		normalized.length === 0
		|| normalized.startsWith("/")
		|| /^[a-z]:\//iu.test(normalized)
		|| normalized.split("/").some((segment: string): boolean => segment === "..")
		|| /[*?\[\]]/u.test(normalized)
	) {
		return null;
	}
	return normalized;
}

function getFreeTerminalVerificationSemantics(args: Record<string, unknown>): WorkflowToolSemantics {
	// 自由终端默认没有验证资格；这里只接受无 shell 组合、精确使用 --check 的 Git 单命令。
	const commandLine: unknown = args.commandLine;
	if (typeof commandLine !== "string") return {};
	const tokens: string[] | null = tokenizeSingleCommand(commandLine);
	if (tokens === null || tokens.length < 3) return {};
	const executable: string = (tokens[0]?.split(/[\\/]/u).at(-1) ?? "").toLowerCase();
	if ((executable !== "git" && executable !== "git.exe") || tokens[1]?.toLowerCase() !== "diff") return {};
	const pathSeparatorIndex: number = tokens.indexOf("--");
	const optionTokens: string[] = pathSeparatorIndex < 0 ? tokens.slice(2) : tokens.slice(2, pathSeparatorIndex);
	if (!optionTokens.includes("--check")) return {};

	const cwd: unknown = args.cwd;
	const explicitPaths: string[] = pathSeparatorIndex < 0 ? [] : tokens.slice(pathSeparatorIndex + 1);
	if ((typeof cwd === "string" && cwd.trim().length > 0 && cwd.trim() !== ".") || explicitPaths.length === 0) {
		return { executionRole: "verification", validationScope: "workspace" };
	}
	const artifactRefs: string[] = explicitPaths.flatMap((value: string): string[] => {
		const normalized: string | null = normalizeExplicitCommandArtifact(value);
		return normalized === null ? [] : [normalized];
	});
	if (artifactRefs.length !== explicitPaths.length) {
		return { executionRole: "verification", validationScope: "workspace" };
	}
	return { executionRole: "verification", validationScope: "artifacts", artifactRefs };
}

const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_workspace_create_text_file",
	"mcp_workspace_propose_create_text_file",
	"mcp_workspace_overwrite_text_file",
	"mcp_workspace_propose_overwrite_text_file",
	"mcp_workspace_replace_text_in_file",
	"mcp_workspace_propose_replace_text_in_file",
	"mcp_workspace_replace_line_in_file",
	"mcp_workspace_propose_replace_line_in_file",
	"mcp_workspace_delete_file"
]);

const GODOT_SCRIPT_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_create_text_file",
	"mcp_godot_propose_create_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_propose_replace_text_in_file",
	"mcp_godot_delete_file"
]);

const GODOT_SCENE_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_create_scene",
	"mcp_godot_propose_create_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_propose_add_node_to_scene",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_propose_attach_script_to_node",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_propose_connect_signal_in_scene",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_propose_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch"
]);

const GODOT_SETTING_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_set_project_setting",
	"mcp_godot_propose_set_project_setting",
	"mcp_godot_unset_project_setting",
	"mcp_godot_propose_unset_project_setting",
	"mcp_godot_set_input_action",
	"mcp_godot_propose_set_input_action",
	"mcp_godot_unset_input_action",
	"mcp_godot_propose_unset_input_action",
	"mcp_godot_set_autoload",
	"mcp_godot_propose_set_autoload",
	"mcp_godot_unset_autoload",
	"mcp_godot_propose_unset_autoload"
]);

export function getWorkflowToolSemantics(
	toolName: string,
	args: Record<string, unknown> = {}
): WorkflowToolSemantics {
	if (toolName === "mcp_terminal_run_command") {
		return getFreeTerminalVerificationSemantics(args);
	}
	if (toolName === "mcp_workspace_read_text_file" || toolName === "mcp_godot_read_text_file") {
		return { validationCapabilities: ["artifact_readback"] };
	}
	if (toolName === "mcp_godot_validate_scene_script_references" || toolName === "mcp_godot_inspect_scene_tree") {
		return { validationCapabilities: ["godot_scene_reference_check"] };
	}
	if (toolName === "mcp_terminal_run_safe_preset" || toolName === "mcp_terminal_run_write_preset") {
		const presetName: unknown = args.presetName;
		if (presetName === "workspace.typecheck" || presetName === "backend.typecheck") return { validationCapabilities: ["workspace_typecheck"] };
		if (presetName === "godot.check_only") return { validationCapabilities: ["godot_script_check"] };
		if (presetName === "godot.validate_scene") return { validationCapabilities: ["godot_scene_reference_check"] };
		return {};
	}
	if (WORKSPACE_WRITE_TOOLS.has(toolName)) return { repairFamilies: ["workspace_file"] };
	if (GODOT_SCRIPT_WRITE_TOOLS.has(toolName)) return { repairFamilies: ["godot_script", "workspace_file"] };
	if (GODOT_SCENE_WRITE_TOOLS.has(toolName)) return { repairFamilies: ["godot_scene"] };
	if (GODOT_SETTING_WRITE_TOOLS.has(toolName)) return { repairFamilies: ["project_setting"] };
	return {};
}
