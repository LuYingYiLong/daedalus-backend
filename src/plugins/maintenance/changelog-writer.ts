import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginChangelogDraft } from "./maintenance-types.js";
import { computePluginSourceRevision } from "./changelog-generator.js";

export async function applyPluginChangelog(draft: PluginChangelogDraft, editedText?: string): Promise<void> {
	if (!draft.accepted) throw Object.assign(new Error("The CHANGELOG draft must be accepted before writing."), { code: "plugin_changelog_not_accepted" });
	const path = join(draft.sourceRoot, "CHANGELOG.md");
	const currentRevision = await computePluginSourceRevision(draft.sourceRoot, draft.toVersion);
	if (currentRevision !== draft.expectedRevision) throw Object.assign(new Error("The plugin source changed after the CHANGELOG draft was generated."), { code: "plugin_changelog_source_stale" });
	const existing = await readFile(path, "utf8").catch((error: unknown): string => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	});
	const header = `## [${draft.toVersion}]`;
	const body = (editedText ?? draft.proposedText).trim();
	if (body.length === 0 || body.length > 128_000) throw Object.assign(new Error("CHANGELOG draft is empty or too large."), { code: "plugin_changelog_invalid" });
	if (existing.includes(header)) {
		if (existing.trimStart().startsWith(body)) return;
		throw Object.assign(new Error(`CHANGELOG already contains ${header}.`), { code: "plugin_changelog_version_exists" });
	}
	const temporaryPath = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
	try {
		await writeFile(temporaryPath, `${body}\n\n${existing.trimStart()}`, "utf8");
		try {
			await rename(temporaryPath, path);
		} catch (error: unknown) {
			// Windows cannot replace an existing file in every filesystem mode.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			await rm(path, { force: true });
			await rename(temporaryPath, path);
		}
	} finally {
		await rm(temporaryPath, { force: true }).catch((): void => undefined);
	}
}
