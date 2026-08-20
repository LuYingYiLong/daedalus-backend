import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getPersonalSkillsDir } from "../app-paths.js";
import { getSkill, listSkills as listBuiltinSkills, type SkillId } from "./registry.js";
import { parseSkillDocument } from "./frontmatter.js";
import { getWorkspaceSkillEnablement } from "./settings-store.js";
import type { CatalogSkill, SkillRef, SkillSource, SkillSummary, SkillWorkspace } from "./types.js";
import { getPluginSkill } from "../plugins/runtime/registries.js";

export const SKILL_SLUG_PATTERN: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BUILTIN_SLUGS: Record<SkillId, string> = {
	"godot.project_init": "godot-project-init",
	"gdscript.review": "gdscript-review",
	"scene.builder": "scene-builder",
	"file.creator": "file-creator",
	"backend.helper": "backend-helper",
	"skill.creator": "skill-creator",
	"image.gen": "image-gen"
};

function createSourceRefSuffix(sourceFolderId: string): string {
	return createHash("sha256").update(sourceFolderId).digest("hex").slice(0, 12);
}

export function createSkillRef(source: SkillSource, slug: string, sourceFolderId?: string | undefined): SkillRef {
	return source === "project" && sourceFolderId !== undefined
		? `${source}:${slug}@${createSourceRefSuffix(sourceFolderId)}`
		: `${source}:${slug}`;
}

export function legacySkillIdToRef(skillId: string): SkillRef | undefined {
	if (!(skillId in BUILTIN_SLUGS)) {
		return undefined;
	}
	return createSkillRef("builtin", BUILTIN_SLUGS[skillId as SkillId]);
}

function isInside(rootPath: string, candidatePath: string): boolean {
	const child: string = relative(rootPath, candidatePath);
	return child.length === 0 || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function scanRoot(
	source: "personal" | "project",
	rootPath: string,
	workspace: SkillWorkspace,
	enablement: Record<SkillRef, boolean>,
	sourceFolderId?: string | undefined,
	isPrimarySourceFolder: boolean = false
): Promise<CatalogSkill[]> {
	let rootRealPath: string;
	try {
		const rootStat = await lstat(rootPath);
		if (rootStat.isSymbolicLink()) {
			throw new Error(`Skill root must not be a symbolic link: ${rootPath}`);
		}
		rootRealPath = await realpath(rootPath);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const entries = await readdir(rootRealPath, { withFileTypes: true });
	const skills: CatalogSkill[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			continue;
		}
		const slug: string = entry.name;
		const ref: SkillRef = createSkillRef(source, slug, sourceFolderId);
		const filePath: string = join(rootRealPath, slug, "SKILL.md");
		const displayPath: string = source === "project"
			? `${sourceFolderId === undefined ? "" : `[${sourceFolderId}] `}.github/skills/${slug}/SKILL.md`
			: `%USERPROFILE%/.daedalus/skills/${slug}/SKILL.md`;
		let document;
		let errorMessage: string | undefined;
		let fileExists: boolean = false;
		try {
			if (!SKILL_SLUG_PATTERN.test(slug)) {
				throw new Error("Skill folder name must be lowercase kebab-case and 1-64 characters.");
			}
			const directoryStat = await lstat(join(rootRealPath, slug));
			const fileStat = await lstat(filePath);
			fileExists = fileStat.isFile();
			if (directoryStat.isSymbolicLink() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
				throw new Error("Skill directories and SKILL.md files must not be symbolic links.");
			}
			const resolvedFile: string = await realpath(filePath);
			if (!isInside(rootRealPath, resolvedFile)) {
				throw new Error("Skill path resolves outside its allowed root.");
			}
			document = parseSkillDocument(await readFile(resolvedFile, "utf8"));
		} catch (error: unknown) {
			errorMessage = error instanceof Error ? error.message : "Invalid skill.";
		}
		skills.push({
			ref,
			slug,
			name: document?.name ?? slug,
			description: document?.description ?? "",
			source,
			enabled: document !== undefined && (enablement[ref] ?? (source === "project" ? enablement[createSkillRef("project", slug)] : undefined) ?? source !== "personal"),
			valid: document !== undefined,
			editable: fileExists,
			removable: true,
			displayPath,
			workspaceId: workspace.id,
			...(sourceFolderId === undefined ? {} : { sourceFolderId, isPrimarySourceFolder }),
			...(errorMessage === undefined ? {} : { error: errorMessage }),
			filePath,
			document
		});
	}
	return skills;
}

async function scanBuiltins(workspace: SkillWorkspace, enablement: Record<SkillRef, boolean>): Promise<CatalogSkill[]> {
	const result: CatalogSkill[] = [];
	for (const builtin of listBuiltinSkills()) {
		const slug: string = BUILTIN_SLUGS[builtin.id];
		const ref: SkillRef = createSkillRef("builtin", slug);
		const filePath: string = resolve(process.cwd(), builtin.promptPath);
		try {
			const document = parseSkillDocument(await readFile(filePath, "utf8"));
			result.push({
				ref, slug, name: document.name, description: document.description,
				source: "builtin", enabled: enablement[ref] ?? true,
				valid: true, editable: false, removable: false,
				displayPath: `builtin://${slug}/SKILL.md`, filePath, document,
				defaultPromptId: builtin.defaultPromptId, allowedTools: [...builtin.allowedTools]
			});
		} catch (error: unknown) {
			result.push({
				ref, slug, name: builtin.name, description: builtin.description,
				source: "builtin", enabled: false, valid: false, editable: false, removable: false,
				displayPath: `builtin://${slug}/SKILL.md`, filePath,
				error: error instanceof Error ? error.message : "Invalid built-in skill."
			});
		}
	}
	return result;
}

export async function loadSkillCatalog(workspace: SkillWorkspace): Promise<{ skills: CatalogSkill[]; revision: string }> {
	const enablement: Record<SkillRef, boolean> = await getWorkspaceSkillEnablement(workspace.id);
	const projectSources: Array<{ id?: string; rootPath: string; primary: boolean }> = workspace.id === "studio:global"
		? []
		: workspace.sourceFolders === undefined
		? [{ rootPath: workspace.rootPath, primary: true }]
		: workspace.sourceFolders.map((sourceFolder): { id: string; rootPath: string; primary: boolean } => ({
			id: sourceFolder.id,
			rootPath: sourceFolder.rootPath,
			primary: sourceFolder.id === workspace.primarySourceFolderId
		}));
	const groups = await Promise.all([
		...projectSources.map((sourceFolder): Promise<CatalogSkill[]> => scanRoot(
			"project",
			join(sourceFolder.rootPath, ".github", "skills"),
			workspace,
			enablement,
			sourceFolder.id,
			sourceFolder.primary
		)),
		scanRoot("personal", getPersonalSkillsDir(), workspace, enablement),
		scanBuiltins(workspace, enablement)
	]);
	const skills: CatalogSkill[] = groups.flat().sort((left, right): number => left.ref.localeCompare(right.ref));
	const revision: string = createHash("sha256")
		.update(JSON.stringify(skills.map((skill): unknown => [skill.ref, skill.name, skill.description, skill.document?.body, skill.enabled, skill.valid, skill.error])))
		.digest("hex").slice(0, 16);
	return { skills, revision };
}

export async function listSkillSummaries(workspace: SkillWorkspace): Promise<{ skills: SkillSummary[]; revision: string }> {
	const catalog = await loadSkillCatalog(workspace);
	return { skills: catalog.skills.map(({ filePath: _filePath, document: _document, defaultPromptId: _promptId, allowedTools: _tools, ...summary }): SkillSummary => summary), revision: catalog.revision };
}

export async function resolveCatalogSkill(workspace: SkillWorkspace, ref: SkillRef, requireEnabled: boolean = false): Promise<CatalogSkill> {
	const skill: CatalogSkill = await resolveCatalogEntry(workspace, ref);
	if (!skill.valid || skill.document === undefined) {
		throw new Error(`Skill ${ref} is invalid: ${skill.error ?? "unknown validation error"}`);
	}
	if (requireEnabled && !skill.enabled) {
		throw new Error(`Skill ${ref} is disabled for workspace ${workspace.id}.`);
	}
	return skill;
}

export async function resolveCatalogEntry(workspace: SkillWorkspace, ref: SkillRef): Promise<CatalogSkill> {
	const pluginSkill = getPluginSkill(ref);
	if (pluginSkill !== undefined) {
		return {
			ref: pluginSkill.ref,
			slug: pluginSkill.slug,
			name: pluginSkill.name,
			description: pluginSkill.description,
			source: "plugin",
			enabled: true,
			valid: true,
			editable: false,
			removable: false,
			displayPath: `plugin://${pluginSkill.pluginId}/${pluginSkill.slug}`,
			filePath: "",
			document: { name: pluginSkill.name, description: pluginSkill.description, body: pluginSkill.body },
			allowedTools: pluginSkill.allowedTools
		};
	}
	const catalog = await loadSkillCatalog(workspace);
	let skill: CatalogSkill | undefined = catalog.skills.find((entry): boolean => entry.ref === ref);
	if (skill === undefined && /^project:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(ref)) {
		const slug: string = ref.slice("project:".length);
		skill = catalog.skills.find((entry): boolean => entry.source === "project" && entry.slug === slug && entry.isPrimarySourceFolder === true);
	}
	if (skill === undefined) {
		throw new Error(`Unknown skill reference: ${ref}`);
	}
	return skill;
}

export function getBuiltinSkillIdByRef(ref: SkillRef): SkillId | undefined {
	for (const [id, slug] of Object.entries(BUILTIN_SLUGS) as Array<[SkillId, string]>) {
		if (ref === createSkillRef("builtin", slug)) {
			return getSkill(id).id;
		}
	}
	return undefined;
}
