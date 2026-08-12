import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseSkillDocument } from "../../../src/skills/frontmatter.js";
import { listSkillSummaries, resolveCatalogSkill } from "../../../src/skills/catalog.js";
import { createSkill, installSkillFromPath, removeSkill, setWorkspaceSkillEnabled, updateSkillContent } from "../../../src/skills/management.js";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import { REQUEST_HANDLERS } from "../../../src/server/request-dispatcher.js";

const userProfileRoot: string = await mkdtemp(join(tmpdir(), "daedalus-skills-userprofile-"));
process.env.USERPROFILE = userProfileRoot;

function skillDocument(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\nFollow this workflow.`;
}

function quotePowerShellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
	return new Promise((resolvePromise, reject): void => {
		const child = spawn(command, args, { cwd, windowsHide: true });
		let stdout: string = "";
		let stderr: string = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string): void => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string): void => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code: number | null): void => {
			if (code === 0) {
				resolvePromise();
			} else {
				reject(new Error(stderr.trim() || stdout.trim() || `Command failed: ${command}`));
			}
		});
	});
}

async function createZip(sourceDirectory: string, zipPath: string): Promise<void> {
	if (process.platform === "win32") {
		await runCommand("powershell.exe", [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`Compress-Archive -Path ${quotePowerShellString(join(sourceDirectory, "*"))} -DestinationPath ${quotePowerShellString(zipPath)} -Force`
		]);
		return;
	}
	await runCommand("zip", ["-qr", zipPath, "."], sourceDirectory);
}

test("strict skill frontmatter requires name, description, and body", (): void => {
	assert.equal(parseSkillDocument(skillDocument("Review", "Review files.")).name, "Review");
	assert.throws((): unknown => parseSkillDocument("---\nname: Missing\n---\nBody"), /description/);
	assert.throws((): unknown => parseSkillDocument("---\nname: Duplicate\nname: Again\ndescription: Test\n---\nBody"), /Duplicate/);
	assert.throws((): unknown => parseSkillDocument("---\nname: Empty\ndescription: Test\n---\n"), /instruction body/);
	assert.throws((): unknown => parseSkillDocument("---\nname: Block\ndescription: |\n---\nBody"), /plain or quoted scalar/);
});

test("catalog discovers project, personal, and builtin skills without shadowing", async (): Promise<void> => {
	const projectRoot: string = await mkdtemp(join(tmpdir(), "daedalus-skills-project-"));
	const projectSkillDir: string = join(projectRoot, ".github", "skills", "shared-name");
	const personalSkillDir: string = join(userProfileRoot, ".daedalus", "skills", "shared-name");
	await mkdir(projectSkillDir, { recursive: true });
	await mkdir(personalSkillDir, { recursive: true });
	await writeFile(join(projectSkillDir, "SKILL.md"), skillDocument("Project Skill", "Project scoped."), "utf8");
	await writeFile(join(personalSkillDir, "SKILL.md"), skillDocument("Personal Skill", "Personal scoped."), "utf8");
	const workspace = { id: "catalog-workspace", rootPath: projectRoot };
	const catalog = await listSkillSummaries(workspace);
	assert.ok(catalog.skills.some((skill): boolean => skill.ref === "project:shared-name" && skill.enabled));
	assert.ok(catalog.skills.some((skill): boolean => skill.ref === "personal:shared-name" && !skill.enabled));
	assert.ok(catalog.skills.some((skill): boolean => skill.ref === "builtin:skill-creator" && skill.enabled));
	await setWorkspaceSkillEnabled(workspace, "personal:shared-name", true);
	assert.equal((await resolveCatalogSkill(workspace, "personal:shared-name", true)).name, "Personal Skill");
});

test("skill management creates atomically, validates updates, and safely removes personal or project skills", async (): Promise<void> => {
	const projectRoot: string = await mkdtemp(join(tmpdir(), "daedalus-skills-manage-"));
	const workspace = { id: "manage-workspace", rootPath: projectRoot };
	const ref: string = await createSkill(workspace, "personal", "created-skill", skillDocument("Created", "Created by AI."));
	assert.equal(ref, "personal:created-skill");
	assert.equal((await resolveCatalogSkill(workspace, ref, true)).enabled, true);
	await updateSkillContent(workspace, ref, skillDocument("Updated", "Updated safely."));
	assert.match(await readFile((await resolveCatalogSkill(workspace, ref)).filePath, "utf8"), /name: Updated/);
	await assert.rejects(updateSkillContent(workspace, ref, "invalid"), /frontmatter/);
	await removeSkill(workspace, ref);
	await assert.rejects(resolveCatalogSkill(workspace, ref), /Unknown skill/);
	const projectRef: string = await createSkill(workspace, "project", "project-skill", skillDocument("Project", "Version controlled."));
	await removeSkill(workspace, projectRef);
	await assert.rejects(resolveCatalogSkill(workspace, projectRef), /Unknown skill/);
});

test("skill install imports folders and zipped single-root skills", async (): Promise<void> => {
	const projectRoot: string = await mkdtemp(join(tmpdir(), "daedalus-skills-install-"));
	const workspace = { id: "install-workspace", rootPath: projectRoot };
	const folderSkillDir: string = join(await mkdtemp(join(tmpdir(), "daedalus-skill-source-")), "folder-skill");
	await mkdir(folderSkillDir, { recursive: true });
	await writeFile(join(folderSkillDir, "SKILL.md"), skillDocument("Folder Skill", "Installed from folder."), "utf8");
	const folderRef: string = await installSkillFromPath(workspace, "personal", "folder", folderSkillDir);
	assert.equal(folderRef, "personal:folder-skill");
	assert.equal((await resolveCatalogSkill(workspace, folderRef, true)).enabled, true);
	await assert.rejects(installSkillFromPath(workspace, "personal", "folder", folderSkillDir), /already exists/);

	const zipRoot: string = await mkdtemp(join(tmpdir(), "daedalus-skill-zip-root-"));
	const nestedSkillDir: string = join(zipRoot, "zip-skill");
	await mkdir(nestedSkillDir, { recursive: true });
	await writeFile(join(nestedSkillDir, "SKILL.md"), skillDocument("Zip Skill", "Installed from zip."), "utf8");
	const zipPath: string = join(await mkdtemp(join(tmpdir(), "daedalus-skill-zip-")), "archive.zip");
	await createZip(zipRoot, zipPath);
	const zipRef: string = await installSkillFromPath(workspace, "project", "zip", zipPath);
	assert.equal(zipRef, "project:zip-skill");
	assert.equal((await resolveCatalogSkill(workspace, zipRef, true)).enabled, true);

	const invalidDir: string = join(await mkdtemp(join(tmpdir(), "daedalus-skill-invalid-")), "missing-skill");
	await mkdir(invalidDir, { recursive: true });
	await assert.rejects(installSkillFromPath(workspace, "personal", "folder", invalidDir), /SKILL\.md/);
});

test("skill install is registered in schema and dispatcher", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "install-skill",
		method: "skill.install",
		params: { source: "personal", kind: "folder", path: "/tmp/example" }
	}).success, true);
	assert.equal(REQUEST_HANDLERS.has("skill.install"), true);
});
