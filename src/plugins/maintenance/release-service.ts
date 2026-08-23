import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDaedalusPath } from "../../app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../../json-file-store.js";
import { getPluginCatalog } from "../manager.js";
import { analyzePluginDirectory } from "../manifest.js";
import { listPluginDevelopmentStatuses } from "../development/status-store.js";
import type { PluginChangelogDraft, PluginReleasePreview } from "./maintenance-types.js";
import { generatePluginChangelogDraft } from "./changelog-generator.js";
import { applyPluginChangelog } from "./changelog-writer.js";
import { buildPluginArtifact } from "./artifact-builder.js";
import { isPathInside } from "../manifest.js";
import { spawn } from "node:child_process";

function redactPublishError(value: string): string {
	return value.replace(/(authorization|token|password|_authToken)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]").slice(-4_000);
}

type DraftStore = { schemaVersion: 1; drafts: PluginChangelogDraft[] };
const EMPTY: DraftStore = { schemaVersion: 1, drafts: [] };

function parseVersion(value: string): [number, number, number, string] | null {
	const match = value.match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
	return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}

function isVersionGreater(current: string, next: string): boolean {
	const left = parseVersion(current);
	const right = parseVersion(next);
	if (left === null || right === null) return false;
	for (let index = 0; index < 3; index += 1) if (right[index]! !== left[index]!) return right[index]! > left[index]!;
	return left[3].length > 0 && right[3].length === 0;
}

async function readDrafts(): Promise<PluginChangelogDraft[]> {
	const stored = await readJsonFile<DraftStore>(getDaedalusPath("plugins.releaseDrafts"));
	return stored?.schemaVersion === 1 && Array.isArray(stored.drafts) ? stored.drafts : EMPTY.drafts;
}

async function saveDraft(draft: PluginChangelogDraft): Promise<void> {
	const drafts = await readDrafts();
	await writeJsonFileAtomic(getDaedalusPath("plugins.releaseDrafts"), { schemaVersion: 1, drafts: [...drafts.filter((item) => item.id !== draft.id), draft].slice(-100) } satisfies DraftStore);
}

export async function getPluginChangelogDraft(draftId: string): Promise<PluginChangelogDraft | null> {
	return (await readDrafts()).find((draft) => draft.id === draftId) ?? null;
}

async function findPlugin(pluginId: string) {
	const plugin = (await getPluginCatalog()).plugins.find((item) => item.id === pluginId);
	if (plugin === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
	return plugin;
}

export async function previewPluginRelease(input: { pluginId: string; nextVersion: string; aiText?: string }): Promise<PluginReleasePreview> {
	const plugin = await findPlugin(input.pluginId);
	const sourceRoot = plugin.source.type === "local" ? resolve(plugin.source.path) : resolve(plugin.packageRoot);
	const blockers: string[] = [];
	const warnings: string[] = [];
	if (!isVersionGreater(plugin.version, input.nextVersion)) blockers.push("The next plugin version must be greater than the current version.");
	if (plugin.source.type !== "local") blockers.push("A local plugin source directory is required to publish a new version.");
	const scan = await analyzePluginDirectory(sourceRoot);
	if (scan.packageName !== plugin.packageName) blockers.push("The package name changed and cannot be released from this plugin record.");
	if (scan.compatibility.classification === "unsupported") blockers.push("The plugin contains unsupported declarations.");
	const statuses = await listPluginDevelopmentStatuses();
	const status = statuses.find((item) => item.lastTest?.pluginId === plugin.id);
	const testRequired = await readFile(resolve(sourceRoot, "tests", "daedalus.plugin-tests.json"), "utf8").then(() => true).catch(() => false);
	if (testRequired && status?.lastTest?.ok !== true) blockers.push(status?.lastTest?.sandbox.available === false ? "The sandbox is unavailable." : "The latest sandbox test did not pass.");
	if (!testRequired) warnings.push("No plugin test plan was found; release requires explicit confirmation.");
	const draftInput = { plugin, sourceRoot, nextVersion: input.nextVersion, ...(status?.lastTest === undefined ? {} : { testSummary: { passed: status.lastTest.ok, runId: status.lastTest.runId } }), ...(input.aiText === undefined ? {} : { aiText: input.aiText }) };
	const draft = await generatePluginChangelogDraft(draftInput);
	await saveDraft(draft);
	const changedFiles = [...draft.sections.added, ...draft.sections.changed].map((item) => item.replace(/^(Added|Updated) /u, ""));
	return { pluginId: plugin.id, sourceRoot: "[local-plugin-source]", packageName: plugin.packageName, currentVersion: plugin.version, nextVersion: input.nextVersion, changelogDraft: { ...draft, sourceRoot: "[local-plugin-source]" }, changedFiles, capabilityChanges: Object.fromEntries((scan.nativePlugin?.capabilities ?? []).map((capability) => [capability, 1])), testSummary: { required: testRequired, passed: status?.lastTest?.ok === true, ...(status?.lastTest?.runId === undefined ? {} : { runId: status.lastTest.runId }) }, warnings, blockers };
}

export async function applyPluginChangelogDraft(input: { draftId: string; expectedRevision: string; accepted: boolean; editedText?: string }): Promise<{ applied: true }> {
	const drafts = await readDrafts();
	const draft = drafts.find((item) => item.id === input.draftId);
	if (draft === undefined) throw Object.assign(new Error("CHANGELOG draft was not found."), { code: "plugin_changelog_draft_not_found" });
	if (draft.expectedRevision !== input.expectedRevision) throw Object.assign(new Error("CHANGELOG draft is stale. Generate a new release preview."), { code: "plugin_changelog_stale" });
	if (!input.accepted) throw Object.assign(new Error("CHANGELOG draft was not accepted."), { code: "plugin_changelog_not_accepted" });
	const next = { ...draft, accepted: true };
	await applyPluginChangelog(next, input.editedText);
	await saveDraft(next);
	return { applied: true };
}

export async function confirmPluginRelease(input: { draftId: string; expectedRevision: string; editedText?: string }): Promise<PluginReleasePreview> {
	const drafts = await readDrafts();
	const draft = drafts.find((item) => item.id === input.draftId);
	if (draft === undefined || draft.expectedRevision !== input.expectedRevision) throw Object.assign(new Error("CHANGELOG draft is stale. Generate a new release preview."), { code: "plugin_release_stale" });
	const catalog = await getPluginCatalog();
	const plugin = draft.pluginId === undefined ? undefined : catalog.plugins.find((item) => item.id === draft.pluginId);
	if (plugin === undefined) throw Object.assign(new Error("Plugin release target was not found."), { code: "plugin_not_found" });
	if (plugin.source.type !== "local") throw Object.assign(new Error("A local plugin source directory is required to create a release artifact."), { code: "plugin_release_source_required" });
	const sourceRoot = resolve(plugin.source.path);
	const accepted = { ...draft, accepted: true, sourceRoot };
	if (!draft.accepted) await applyPluginChangelog(accepted, input.editedText);
	const changelogHash = createHash("sha256").update(input.editedText ?? draft.proposedText).digest("hex");
	const artifact = await buildPluginArtifact({ sourceRoot, packageName: plugin.packageName, version: draft.toVersion, fingerprint: plugin.fingerprint, changelogHash });
	await saveDraft(accepted);
	const testPlanExists = await readFile(resolve(sourceRoot, "tests", "daedalus.plugin-tests.json"), "utf8").then(() => true).catch(() => false);
	const statuses = await listPluginDevelopmentStatuses();
	const latestTest = statuses.find((item) => item.lastTest?.pluginId === plugin.id)?.lastTest;
	return { pluginId: plugin.id, sourceRoot: "[local-plugin-source]", packageName: plugin.packageName, currentVersion: plugin.version, nextVersion: draft.toVersion, changelogDraft: { ...accepted, sourceRoot: "[local-plugin-source]" }, changedFiles: [], capabilityChanges: {}, testSummary: { required: testPlanExists, passed: latestTest?.ok === true, ...(latestTest?.runId === undefined ? {} : { runId: latestTest.runId }) }, artifact, warnings: testPlanExists ? [] : ["No plugin test plan was found; release requires explicit confirmation."], blockers: [] };
}

export async function publishPluginArtifact(input: { artifactPath: string; registry: string }): Promise<{ published: true; registry: string }> {
	const releasesRoot = resolve(getDaedalusPath("plugins.releases"));
	const artifactPath = resolve(input.artifactPath);
	if (!isPathInside(releasesRoot, artifactPath) || !artifactPath.endsWith(".tgz")) throw Object.assign(new Error("Only Daedalus-managed release artifacts can be published."), { code: "plugin_release_path_escape" });
	let registry: URL;
	try { registry = new URL(input.registry); } catch { throw Object.assign(new Error("Invalid npm registry URL."), { code: "plugin_registry_invalid" }); }
	if (registry.protocol !== "https:" && registry.protocol !== "http:") throw Object.assign(new Error("The npm registry must use HTTP or HTTPS."), { code: "plugin_registry_invalid" });
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["publish", artifactPath, "--ignore-scripts", "--registry", input.registry], { shell: false, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" }, stdio: ["ignore", "ignore", "pipe"] });
		let error = "";
		child.stderr.on("data", (chunk: Buffer) => { error = `${error}${chunk.toString("utf8")}`.slice(-4000); });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolvePromise() : reject(Object.assign(new Error(redactPublishError(error || "npm publish failed.")), { code: "plugin_publish_failed" })));
	});
	return { published: true, registry: input.registry };
}
