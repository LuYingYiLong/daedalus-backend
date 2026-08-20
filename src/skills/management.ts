import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, lstat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { getPersonalSkillsDir } from "../app-paths.js";
import { createSkillRef, loadSkillCatalog, resolveCatalogEntry, resolveCatalogSkill, SKILL_SLUG_PATTERN } from "./catalog.js";
import { parseSkillDocument } from "./frontmatter.js";
import { setSkillEnabled } from "./settings-store.js";
import type { SkillRef, SkillSource, SkillWorkspace } from "./types.js";

function skillRoot(workspace: SkillWorkspace, source: "personal" | "project"): string {
	if (source !== "project") {
		return getPersonalSkillsDir();
	}
	if (workspace.sourceFolders !== undefined && workspace.sourceFolders.length !== 1) {
		throw new Error("A single sourceFolderId is required for project skill management.");
	}
	return join(workspace.sourceFolders?.[0]?.rootPath ?? workspace.rootPath, ".github", "skills");
}

function projectSourceFolderId(workspace: SkillWorkspace, source: "personal" | "project"): string | undefined {
	return source === "project" ? workspace.sourceFolders?.[0]?.id : undefined;
}

function assertSafeSlug(slug: string): void {
	if (!SKILL_SLUG_PATTERN.test(slug)) {
		throw new Error("Skill slug must be lowercase kebab-case and 1-64 characters.");
	}
}

function isLexicallyInside(root: string, candidate: string): boolean {
	const child: string = relative(resolve(root), resolve(candidate));
	return child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath: string = `${filePath}.${process.pid}.tmp`;
	await writeFile(tempPath, content.replace(/\r\n?/g, "\n"), "utf8");
	await rename(tempPath, filePath);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await lstat(filePath);
		return true;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function assertRegularSkillFile(filePath: string): Promise<void> {
	const fileStats = await lstat(filePath);
	if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
		throw new Error("SKILL.md must be a regular file.");
	}
	parseSkillDocument(await readFile(filePath, "utf8"));
}

async function copySkillDirectory(sourceDirectory: string, destinationDirectory: string): Promise<void> {
	const sourceStats = await lstat(sourceDirectory);
	if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
		throw new Error("Skill source must be a regular directory.");
	}
	await mkdir(destinationDirectory, { recursive: true });
	const entries = await readdir(sourceDirectory, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath: string = join(sourceDirectory, entry.name);
		const destinationPath: string = join(destinationDirectory, entry.name);
		const entryStats = await lstat(sourcePath);
		if (entryStats.isSymbolicLink()) {
			throw new Error("Skill directories must not contain symbolic links.");
		}
		if (entryStats.isDirectory()) {
			await copySkillDirectory(sourcePath, destinationPath);
		} else if (entryStats.isFile()) {
			await mkdir(dirname(destinationPath), { recursive: true });
			await writeFile(destinationPath, await readFile(sourcePath));
		}
	}
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject): void => {
		const child = spawn(command, args, { windowsHide: true });
		let stdout: string = "";
		let stderr: string = "";
		const timer = setTimeout((): void => {
			child.kill();
			reject(new Error(`Command timed out: ${command}`));
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string): void => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string): void => {
			stderr += chunk;
		});
		child.on("error", (error: Error): void => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code: number | null): void => {
			clearTimeout(timer);
			resolvePromise({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
	const sourceStats = await lstat(zipPath);
	if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
		throw new Error("Skill ZIP source must be a regular file.");
	}
	const result = process.platform === "win32"
		? await runCommand("powershell.exe", [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`
		], 60000)
		: await runCommand("unzip", ["-q", zipPath, "-d", destination], 60000);
	if (result.exitCode !== 0) {
		throw new Error((result.stderr.trim() || result.stdout.trim() || "Failed to extract skill ZIP.").slice(0, 2000));
	}
}

async function resolveInstalledSkillSource(kind: "folder" | "zip", sourcePath: string, stagingRoot?: string): Promise<{ directory: string; slug: string }> {
	if (kind === "folder") {
		const directory: string = await realpath(sourcePath);
		await assertRegularSkillFile(join(directory, "SKILL.md"));
		return { directory, slug: basename(directory) };
	}

	if (stagingRoot === undefined) {
		throw new Error("ZIP staging root is required.");
	}
	const zipSlug: string = basename(sourcePath, extname(sourcePath));
	if (await pathExists(join(stagingRoot, "SKILL.md"))) {
		await assertRegularSkillFile(join(stagingRoot, "SKILL.md"));
		return { directory: stagingRoot, slug: zipSlug };
	}

	const entries = await readdir(stagingRoot, { withFileTypes: true });
	const directories = entries.filter((entry): boolean => entry.isDirectory() && !entry.isSymbolicLink());
	if (directories.length === 1) {
		const directory: string = join(stagingRoot, directories[0]!.name);
		await assertRegularSkillFile(join(directory, "SKILL.md"));
		return { directory, slug: directories[0]!.name };
	}
	throw new Error("Skill ZIP must contain SKILL.md at its root or a single skill directory.");
}

export async function getSkillContent(workspace: SkillWorkspace, ref: SkillRef): Promise<string> {
	const skill = await resolveCatalogEntry(workspace, ref);
	if (!skill.editable || skill.source === "builtin") {
		throw new Error(`Skill ${ref} is read-only.`);
	}
	return readFile(skill.filePath, "utf8");
}

export async function updateSkillContent(workspace: SkillWorkspace, ref: SkillRef, content: string): Promise<void> {
	parseSkillDocument(content);
	const skill = await resolveCatalogEntry(workspace, ref);
	if (!skill.editable || skill.source === "builtin") {
		throw new Error(`Skill ${ref} is read-only.`);
	}
	await atomicWrite(skill.filePath, content);
}

export async function createSkill(workspace: SkillWorkspace, source: "personal" | "project", slug: string, content: string): Promise<SkillRef> {
	assertSafeSlug(slug);
	parseSkillDocument(content);
	const root: string = skillRoot(workspace, source);
	const targetDirectory: string = join(root, slug);
	if (!isLexicallyInside(root, targetDirectory)) {
		throw new Error("Skill target resolves outside its allowed root.");
	}
	const ref: SkillRef = createSkillRef(source, slug, projectSourceFolderId(workspace, source));
	if ((await loadSkillCatalog(workspace)).skills.some((skill): boolean => skill.ref === ref)) {
		throw new Error(`Skill ${ref} already exists.`);
	}
	await mkdir(root, { recursive: true });
	await mkdir(targetDirectory, { recursive: false });
	try {
		await atomicWrite(join(targetDirectory, "SKILL.md"), content);
	} catch (error: unknown) {
		await rm(targetDirectory, { recursive: true, force: true });
		throw error;
	}
	await setSkillEnabled(workspace.id, ref, true);
	return ref;
}

export async function installSkillFromPath(
	workspace: SkillWorkspace,
	source: "personal" | "project",
	kind: "folder" | "zip",
	sourcePath: string
): Promise<SkillRef> {
	const stagingRoot: string | undefined = kind === "zip" ? await mkdtemp(join(tmpdir(), "daedalus-skill-install-")) : undefined;
	try {
		if (kind === "zip") {
			await extractZip(sourcePath, stagingRoot!);
		}
		const installSource = await resolveInstalledSkillSource(kind, sourcePath, stagingRoot);
		const slug: string = installSource.slug;
		assertSafeSlug(slug);
		const root: string = skillRoot(workspace, source);
		const targetDirectory: string = join(root, slug);
		if (!isLexicallyInside(root, targetDirectory)) {
			throw new Error("Skill target resolves outside its allowed root.");
		}
		const ref: SkillRef = createSkillRef(source, slug, projectSourceFolderId(workspace, source));
		if ((await loadSkillCatalog(workspace)).skills.some((skill): boolean => skill.ref === ref) || await pathExists(targetDirectory)) {
			throw new Error(`Skill ${ref} already exists.`);
		}

		await mkdir(root, { recursive: true });
		const tempDirectory: string = join(root, `.${slug}.${process.pid}.${Date.now().toString(36)}.tmp`);
		try {
			await copySkillDirectory(installSource.directory, tempDirectory);
			await rename(tempDirectory, targetDirectory);
		} catch (error: unknown) {
			await rm(tempDirectory, { recursive: true, force: true });
			throw error;
		}
		await setSkillEnabled(workspace.id, ref, true);
		return ref;
	} finally {
		if (stagingRoot !== undefined) {
			await rm(stagingRoot, { recursive: true, force: true });
		}
	}
}

export async function removeSkill(workspace: SkillWorkspace, ref: SkillRef): Promise<void> {
	const skill = await resolveCatalogEntry(workspace, ref);
	if (skill.source !== "project" && skill.source !== "personal") {
		throw new Error(`Skill ${ref} is not removable.`);
	}
	const rootReal: string = await realpath(skillRoot(workspace, skill.source));
	const directoryReal: string = await realpath(dirname(skill.filePath));
	if (!isLexicallyInside(rootReal, directoryReal) || directoryReal === rootReal) {
		throw new Error(`Refusing to remove a skill outside the ${skill.source} skill root.`);
	}
	await rm(directoryReal, { recursive: true, force: false });
}

export async function removePersonalSkill(workspace: SkillWorkspace, ref: SkillRef): Promise<void> {
	const skill = await resolveCatalogEntry(workspace, ref);
	if (skill.source !== "personal") {
		throw new Error(`Skill ${ref} is not a personal skill.`);
	}
	await removeSkill(workspace, ref);
}

export async function setWorkspaceSkillEnabled(workspace: SkillWorkspace, ref: SkillRef, enabled: boolean): Promise<void> {
	const skill = await resolveCatalogSkill(workspace, ref);
	await setSkillEnabled(workspace.id, skill.ref, enabled);
}
