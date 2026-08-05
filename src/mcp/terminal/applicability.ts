import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolApplicabilityCode } from "../../tools/tool-applicability.js";

export type PresetApplicabilityInput = {
	presetName: string;
	workingDirectory: string;
	requiresGodotProject?: boolean | undefined;
	godotProjectPath?: string | undefined;
};

export type PresetApplicability =
	| { applicable: true }
	| {
		applicable: false;
		applicabilityCode: ToolApplicabilityCode;
		notApplicableReason: string;
	};

type PackageManifestState = "missing" | "missing_script" | "valid" | "malformed";

function hasGitMetadata(startDirectory: string): boolean {
	let currentDirectory: string = path.resolve(startDirectory);
	while (true) {
		if (fs.existsSync(path.join(currentDirectory, ".git"))) {
			return true;
		}
		const parentDirectory: string = path.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return false;
		}
		currentDirectory = parentDirectory;
	}
}

function inspectPackageManifest(directory: string): PackageManifestState {
	const packageJsonPath: string = path.join(directory, "package.json");
	if (!fs.existsSync(packageJsonPath)) {
		return "missing";
	}

	try {
		const packageJson: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		if (packageJson === null || typeof packageJson !== "object" || Array.isArray(packageJson)) {
			return "malformed";
		}
		const scripts: unknown = (packageJson as { scripts?: unknown }).scripts;
		const typecheckScript: unknown = scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)
			? (scripts as { typecheck?: unknown }).typecheck
			: undefined;
		return typeof typecheckScript === "string" && typecheckScript.trim().length > 0
			? "valid"
			: "missing_script";
	} catch {
		// 损坏的 manifest 交给真实命令报告，避免预检掩盖实际错误。
		return "malformed";
	}
}

export function resolvePresetApplicability(input: PresetApplicabilityInput): PresetApplicability {
	const godotProjectPath: string = input.godotProjectPath ?? "";
	const hasGodotProject: boolean = godotProjectPath.length > 0
		&& fs.existsSync(path.join(godotProjectPath, "project.godot"));
	if (input.requiresGodotProject === true && !hasGodotProject) {
		return {
			applicable: false,
			applicabilityCode: "godot_project_missing",
			notApplicableReason: `${input.presetName} is not applicable because no Godot project is configured for this workspace.`
		};
	}

	if (input.presetName === "git.status" || input.presetName === "git.diff") {
		if (!hasGitMetadata(input.workingDirectory)) {
			return {
				applicable: false,
				applicabilityCode: "git_repository_missing",
				notApplicableReason: `${input.presetName} is not applicable because the workspace is not a Git repository.`
			};
		}
		return { applicable: true };
	}

	if (input.presetName === "workspace.typecheck") {
		const manifestState: PackageManifestState = inspectPackageManifest(input.workingDirectory);
		if (manifestState === "missing") {
			return {
				applicable: false,
				applicabilityCode: "package_manifest_missing",
				notApplicableReason: "workspace.typecheck is not applicable because package.json is missing from the workspace."
			};
		}
		if (manifestState === "missing_script") {
			return {
				applicable: false,
				applicabilityCode: "typecheck_script_missing",
				notApplicableReason: "workspace.typecheck is not applicable because package.json has no typecheck script."
			};
		}
	}

	return { applicable: true };
}
