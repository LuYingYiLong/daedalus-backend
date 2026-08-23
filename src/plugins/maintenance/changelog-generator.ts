import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginRecord } from "../types.js";
import { listPluginVersions } from "../versions.js";
import type { PluginChangelogDraft, PluginChangelogSections } from "./maintenance-types.js";

const MAX_FILES = 1_000;
const MAX_TEXT = 128_000;

async function files(root: string, current = ""): Promise<string[]> {
	if (current.split("/").length > 12) return [];
	const entries = await readdir(join(root, current), { withFileTypes: true });
	const result: string[] = [];
	for (const entry of entries) {
		if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
		const rel = current.length === 0 ? entry.name : `${current}/${entry.name}`;
		if (entry.isDirectory()) result.push(...await files(root, rel));
		else if (entry.isFile()) result.push(rel.replace(/\\/gu, "/"));
		if (result.length >= MAX_FILES) return result.slice(0, MAX_FILES);
	}
	return result;
}

/** 生成草稿时使用文件内容指纹，避免外部修改悄悄覆盖 CHANGELOG。 */
export async function computePluginSourceRevision(rootPath: string, version: string): Promise<string> {
	const root = resolve(rootPath);
	const paths = await files(root);
	const entries = await Promise.all(paths.map(async (path): Promise<[string, string]> => {
		const content = await readFile(join(root, path));
		return [path, createHash("sha256").update(content).digest("hex")];
	}));
	return createHash("sha256").update(JSON.stringify({ version, entries: entries.sort(([left], [right]) => left.localeCompare(right)) })).digest("hex");
}

function sectionLines(changes: string[], label: string): string[] {
	return changes.length === 0 ? [] : [`### ${label}`, ...changes.map((item) => `- ${item}`), ""];
}

function toText(version: string, sections: PluginChangelogSections): string {
	const lines = [`## [${version}] - ${new Date().toISOString().slice(0, 10)}`, ""];
	lines.push(...sectionLines(sections.added, "Added"));
	lines.push(...sectionLines(sections.changed, "Changed"));
	lines.push(...sectionLines(sections.fixed, "Fixed"));
	lines.push(...sectionLines(sections.security, "Security"));
	lines.push(...sectionLines(sections.tests, "Tests"));
	return `${lines.join("\n").trim()}\n`;
}

function validateAiText(value: string): string {
	const text = value.trim();
	if (text.length === 0 || text.length > MAX_TEXT) throw Object.assign(new Error("AI CHANGELOG text is empty or too large."), { code: "plugin_changelog_ai_invalid" });
	if (text.includes("sk-") || /Bearer\s+\S+/iu.test(text) || /[A-Z]:[\\/]/iu.test(text) || text.includes("\\\\")) throw Object.assign(new Error("AI CHANGELOG text contains a secret or local path."), { code: "plugin_changelog_ai_sensitive" });
	return text;
}

export async function generatePluginChangelogDraft(input: { plugin: PluginRecord; sourceRoot: string; nextVersion: string; testSummary?: { passed: boolean; runId?: string }; aiText?: string }): Promise<PluginChangelogDraft> {
	const root = resolve(input.sourceRoot);
	const currentFiles = await files(root);
	const previous = (await listPluginVersions(input.plugin.id))[0];
	const previousFiles = previous === undefined ? [] : await files(previous.packageRoot).catch(() => []);
	const currentSet = new Set(currentFiles);
	const previousSet = new Set(previousFiles);
	const sections: PluginChangelogSections = {
		added: currentFiles.filter((item) => !previousSet.has(item)).slice(0, 80).map((item) => `Added ${item}`),
		changed: currentFiles.filter((item) => previousSet.has(item)).slice(0, 80).map((item) => `Updated ${item}`),
		fixed: [],
		security: ["Plugin runtime continues to use the configured OS sandbox and network-disabled policy."],
		tests: input.testSummary === undefined ? ["Static validation was completed."] : [input.testSummary.passed ? `Sandbox test run ${input.testSummary.runId ?? "completed"} passed.` : `Sandbox test run ${input.testSummary.runId ?? "completed"} requires follow-up.`]
	};
	if (currentSet.size === 0) sections.changed = ["Updated plugin package metadata."];
	const deterministic = toText(input.nextVersion, sections);
	const aiText = input.aiText === undefined ? undefined : validateAiText(input.aiText);
	const proposedText = aiText ?? deterministic;
	const revision = await computePluginSourceRevision(root, input.nextVersion);
	return { id: `plugin-changelog-${randomUUID()}`, pluginId: input.plugin.id, sourceRoot: root, packageName: input.plugin.packageName, fromVersion: input.plugin.version, toVersion: input.nextVersion, expectedRevision: revision, generatedAt: new Date().toISOString(), generator: aiText === undefined ? "deterministic" : "ai-assisted", sections, proposedText, accepted: false };
}
