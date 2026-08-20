import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getDaedalusPath } from "../app-paths.js";
import { analyzePluginDirectory, isPathInside } from "./manifest.js";
import {
	appendPluginAudit,
	getActivePluginProfile,
	readPluginProfiles,
	readPluginRecords,
	readPluginTrust,
	updatePluginProfiles,
	updatePluginState,
	updatePluginTrust
} from "./store.js";
import type { PluginCatalogResult, PluginCompatibility, PluginProfile, PluginRecord, PluginScanResult, PluginSource, PluginTrustStatus } from "./types.js";

const MAX_PROCESS_OUTPUT: number = 2 * 1024 * 1024;
const EXACT_NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/iu;
const SAFE_PROCESS_ENV_KEYS = new Set([
	"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "COMSPEC",
	"LANG", "LC_ALL", "CI", "NPM_CONFIG_IGNORE_SCRIPTS", "NPM_CONFIG_YES", "NPM_CONFIG_AUDIT", "NPM_CONFIG_FUND", "GIT_CONFIG_NOSYSTEM"
]);

type ProcessResult = { stdout: string; stderr: string; exitCode: number | null };

function safeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || !SAFE_PROCESS_ENV_KEYS.has(key.toUpperCase())) continue;
		env[key] = value;
	}
	env.NPM_CONFIG_IGNORE_SCRIPTS = "true";
	env.GIT_CONFIG_NOSYSTEM = "1";
	return env;
}

function runProcess(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
	return new Promise((resolveResult, reject) => {
		const child = spawn(command, [...args], { cwd, env: safeEnv(), stdio: ["ignore", "pipe", "pipe"], shell: false });
		let stdout: string = "";
		let stderr: string = "";
		child.stdout.on("data", (chunk: Buffer): void => {
			stdout = `${stdout}${chunk.toString("utf8")}`.slice(-MAX_PROCESS_OUTPUT);
		});
		child.stderr.on("data", (chunk: Buffer): void => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_PROCESS_OUTPUT);
		});
		child.once("error", reject);
		child.once("close", (exitCode: number | null): void => resolveResult({ stdout, stderr, exitCode }));
	});
}

function npmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function ensureSource(source: PluginSource): void {
	if (source.type === "npm" && !EXACT_NPM_VERSION.test(source.version)) {
		throw Object.assign(new Error("npm plugins must use an exact semantic version."), { code: "plugin_version_not_exact" });
	}
	if (source.type === "git" && !GIT_COMMIT.test(source.commit)) {
		throw Object.assign(new Error("Git plugins must use a fixed commit hash."), { code: "plugin_commit_not_pinned" });
	}
	if (source.type === "git") {
		let protocol: string;
		try {
			protocol = new URL(source.url).protocol.toLowerCase();
		} catch {
			throw Object.assign(new Error("Git plugins must use a valid remote URL."), { code: "plugin_git_url_invalid" });
		}
		if (!["http:", "https:", "ssh:", "git+http:", "git+https:", "git+ssh:"].includes(protocol)) {
			throw Object.assign(new Error("Git plugins only support HTTP(S) or SSH URLs."), { code: "plugin_git_url_unsupported" });
		}
	}
}

async function validateTarball(path: string, expectedSha256?: string): Promise<void> {
	const bytes: Buffer = await readFile(path);
	if (expectedSha256 !== undefined) {
		const actual: string = createHash("sha256").update(bytes).digest("hex");
		if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
			throw Object.assign(new Error("Plugin tarball hash does not match the expected SHA-256."), { code: "plugin_hash_mismatch" });
		}
	}
}

function validateArchiveEntry(entry: string): void {
	const normalized: string = entry.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").includes("..")) {
		throw Object.assign(new Error(`Plugin archive contains an unsafe path: ${entry}`), { code: "plugin_archive_path_escape" });
	}
}

async function extractTarball(archivePath: string, destination: string): Promise<string> {
	await mkdir(destination, { recursive: true });
	const listing = await runProcess("tar", ["-tzf", archivePath], destination);
	if (listing.exitCode !== 0) throw new Error(`Unable to inspect plugin archive: ${listing.stderr.trim()}`);
	for (const entry of listing.stdout.split(/\r?\n/u).map((value): string => value.trim()).filter(Boolean)) validateArchiveEntry(entry);
	const extraction = await runProcess("tar", ["-xzf", archivePath, "-C", destination], destination);
	if (extraction.exitCode !== 0) throw new Error(`Unable to extract plugin archive: ${extraction.stderr.trim()}`);
	const packageDirectory: string = join(destination, "package");
	try {
		if ((await stat(join(packageDirectory, "package.json"))).isFile()) return packageDirectory;
	} catch {
		// Fall through and look for a package.json at the archive root.
	}
	if ((await stat(join(destination, "package.json"))).isFile()) return destination;
	throw Object.assign(new Error("Plugin archive does not contain package.json."), { code: "plugin_manifest_missing" });
}

async function packRemote(source: PluginSource, destination: string): Promise<string> {
	if (source.type !== "npm" && source.type !== "git") throw new Error("Only npm and Git sources can be packed remotely.");
	const spec: string = source.type === "npm"
		? `${source.packageName}@${source.version}`
		: `${source.url.replace(/^git\+/u, "git+")}#${source.commit}`;
	const result: ProcessResult = await runProcess(npmCommand(), ["pack", "--ignore-scripts", "--json", spec], destination);
	if (result.exitCode !== 0) throw new Error(`Failed to download plugin package: ${result.stderr.trim() || result.stdout.trim()}`);
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		const filename: unknown = Array.isArray(parsed) ? (parsed[0] as { filename?: unknown } | undefined)?.filename : undefined;
		if (typeof filename === "string") return join(destination, basename(filename));
	} catch {
		// npm versions that do not support --json are handled by the directory scan below.
	}
	const candidates = (await readdir(destination)).filter((file): boolean => file.endsWith(".tgz"));
	if (candidates.length === 1) return join(destination, candidates[0]!);
	throw new Error("npm pack did not produce a plugin tarball.");
}

async function prepareSource(source: PluginSource): Promise<{ root: string; cleanup: () => Promise<void> }> {
	ensureSource(source);
	const temporaryRoot: string = await mkdtemp(join(tmpdir(), "daedalus-plugin-"));
	try {
		if (source.type === "local") {
			const root: string = resolve(source.path);
			if (!isPathInside(root, join(root, "package.json"))) throw new Error("Invalid local plugin path.");
			return { root, cleanup: async (): Promise<void> => { await rm(temporaryRoot, { recursive: true, force: true }); } };
		}
		const archivePath: string = source.type === "tarball"
			? source.path
			: await packRemote(source, temporaryRoot);
		await validateTarball(archivePath, source.type === "tarball" ? source.sha256 : undefined);
		const extractedRoot: string = await extractTarball(archivePath, join(temporaryRoot, "extracted"));
		return { root: extractedRoot, cleanup: async (): Promise<void> => { await rm(temporaryRoot, { recursive: true, force: true }); } };
	} catch (error: unknown) {
		await rm(temporaryRoot, { recursive: true, force: true }).catch((): void => undefined);
		throw error;
	}
}

export async function scanPluginSource(source: PluginSource): Promise<PluginScanResult> {
	const prepared = await prepareSource(source);
	try {
		const result: PluginScanResult = await analyzePluginDirectory(prepared.root);
		await appendPluginAudit({ action: "scan", source: source.type, packageName: result.packageName, version: result.version, contentHash: result.contentHash });
		return { ...result, packageRoot: source.type === "local" ? resolve(source.path) : undefined };
	} finally {
		await prepared.cleanup();
	}
}

function createPluginId(packageName: string, version: string, contentHash: string): string {
	return `${packageName}@${version}:${contentHash.slice(0, 12)}`;
}

function createFingerprint(source: PluginSource, contentHash: string, manifestHash: string, compatibility: PluginCompatibility, nativePlugin?: unknown, dependencyLockHash?: string): string {
	return createHash("sha256").update(JSON.stringify({ source, contentHash, manifestHash, compatibility, nativePlugin, dependencyLockHash })).digest("hex");
}

async function copyPreparedPackage(sourceRoot: string, packageId: string, contentHash: string): Promise<string> {
	const packagesRoot: string = getDaedalusPath("plugins.packages");
	await mkdir(packagesRoot, { recursive: true });
	const safeName: string = packageId.replace(/[^a-zA-Z0-9._@-]/gu, "_");
	const target: string = join(packagesRoot, safeName);
	if (!isPathInside(packagesRoot, target)) throw new Error("Plugin target path escapes the managed package directory.");
	try {
		await stat(target);
	} catch {
		await cp(sourceRoot, target, { recursive: true, force: false, errorOnExist: true, dereference: false });
		return target;
	}
	try {
		const existing = await analyzePluginDirectory(target);
		if (existing.contentHash.startsWith(contentHash.slice(0, 12))) return target;
	} catch {
		// A tampered or incomplete managed package is replaced by the explicit reinstall.
	}
	await rm(target, { recursive: true, force: true });
	await cp(sourceRoot, target, { recursive: true, force: false, errorOnExist: true, dereference: false });
	return target;
}

export async function installPlugin(source: PluginSource): Promise<PluginRecord> {
	const prepared = await prepareSource(source);
	try {
		const scan: PluginScanResult = await analyzePluginDirectory(prepared.root);
		const id: string = createPluginId(scan.packageName, scan.version, scan.contentHash);
		const packageRoot: string = await copyPreparedPackage(prepared.root, id, scan.contentHash);
		const now: string = new Date().toISOString();
		const trust = await readPluginTrust();
		const fingerprint: string = createFingerprint(source, scan.contentHash, scan.manifestHash, scan.compatibility, scan.nativePlugin, scan.dependencyLockHash);
		const trustEntry = trust[id];
		const trustStatus: PluginTrustStatus = trustEntry?.fingerprint === fingerprint ? trustEntry.status : "review_required";
		const record: PluginRecord = {
			id,
			packageName: scan.packageName,
			version: scan.version,
			source,
			packageRoot,
			contentHash: scan.contentHash,
			manifestHash: scan.manifestHash,
			fingerprint,
			compatibility: scan.compatibility,
			trust: trustStatus,
			enabled: false,
			installedAt: now,
			updatedAt: now,
			...(scan.nativePlugin === undefined ? {} : { nativePlugin: scan.nativePlugin }),
			...(scan.dependencyLockHash === undefined ? {} : { dependencyLockHash: scan.dependencyLockHash })
		};
		const records: PluginRecord[] = await updatePluginState((current): PluginRecord[] => {
			const index: number = current.findIndex((candidate): boolean => candidate.id === id);
			if (index < 0) return [...current, record];
			const previous: PluginRecord = current[index]!;
			return current.with(index, { ...record, enabled: previous.enabled, installedAt: previous.installedAt });
		});
		await updatePluginTrust((current): typeof current => ({ ...current, [id]: { fingerprint, status: trustStatus, updatedAt: now } }));
		await appendPluginAudit({ action: "install", pluginId: id, source: source.type, contentHash: scan.contentHash });
		return records.find((candidate): boolean => candidate.id === id)!;
	} finally {
		await prepared.cleanup();
	}
}

export async function removePlugin(pluginId: string): Promise<void> {
	const records: PluginRecord[] = await readPluginRecords();
	const record: PluginRecord | undefined = records.find((candidate): boolean => candidate.id === pluginId);
	if (record === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
	const runtime = await import("./runtime/manager.js");
	await runtime.stopPlugin(pluginId);
	const packagesRoot: string = resolve(getDaedalusPath("plugins.packages"));
	const packageRoot: string = resolve(record.packageRoot);
	if (!isPathInside(packagesRoot, packageRoot) || packageRoot === packagesRoot) throw Object.assign(new Error("Plugin path is outside the managed package directory."), { code: "plugin_path_escape" });
	await rm(packageRoot, { recursive: true, force: true });
	await updatePluginState((current): PluginRecord[] => current.filter((candidate): boolean => candidate.id !== pluginId));
	await updatePluginProfiles((profiles): PluginProfile[] => profiles.map((profile): PluginProfile => ({ ...profile, pluginIds: profile.pluginIds.filter((id): boolean => id !== pluginId) })));
	await updatePluginTrust((entries): typeof entries => {
		const next = { ...entries };
		delete next[pluginId];
		return next;
	});
	await appendPluginAudit({ action: "remove", pluginId });
}

export async function updatePluginTrustStatus(pluginId: string, fingerprint: string, status: Exclude<PluginTrustStatus, "review_required">): Promise<PluginRecord> {
	const record: PluginRecord | undefined = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
	if (record === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
	const expected: string = createFingerprint(record.source, record.contentHash, record.manifestHash, record.compatibility, record.nativePlugin, record.dependencyLockHash);
	if (expected !== fingerprint) throw Object.assign(new Error("Plugin fingerprint is stale. Rescan the plugin before updating trust."), { code: "plugin_fingerprint_stale" });
	const updatedAt: string = new Date().toISOString();
	await updatePluginTrust((entries): typeof entries => ({ ...entries, [pluginId]: { fingerprint, status, updatedAt } }));
	const records: PluginRecord[] = await updatePluginState((current): PluginRecord[] => current.map((candidate): PluginRecord => candidate.id === pluginId ? { ...candidate, trust: status, enabled: status === "trusted", updatedAt } : candidate));
	await updatePluginProfiles((profiles): PluginProfile[] => profiles.map((profile): PluginProfile => {
		const active: boolean = profile.active;
		if (!active) return { ...profile, active: false };
		const pluginIds: string[] = status === "trusted"
			? [...new Set([...profile.pluginIds, pluginId])]
			: profile.pluginIds.filter((id): boolean => id !== pluginId);
		return { ...profile, pluginIds, active: true, updatedAt };
	}));
	if (status === "disabled") {
		const runtime = await import("./runtime/manager.js");
		await runtime.stopPlugin(pluginId, undefined, "disabled");
	}
	await appendPluginAudit({ action: "trust.update", pluginId, status });
	return records.find((candidate): boolean => candidate.id === pluginId)!;
}

export async function updateActivePluginProfile(pluginIds: readonly string[]): Promise<PluginCatalogResult> {
	const records: PluginRecord[] = await readPluginRecords();
	const trusted: Set<string> = new Set(records.filter((record): boolean => record.trust === "trusted").map((record): string => record.id));
	const uniqueIds: string[] = [...new Set(pluginIds)].filter((pluginId): boolean => trusted.has(pluginId));
	const updatedAt: string = new Date().toISOString();
	const profiles: PluginProfile[] = await updatePluginProfiles((current): PluginProfile[] => {
		const active: PluginProfile = getActivePluginProfile(current);
		return current.map((profile): PluginProfile => profile.id === active.id ? { ...profile, pluginIds: uniqueIds, updatedAt, active: true } : { ...profile, active: false });
	});
	await updatePluginState((current): PluginRecord[] => current.map((record): PluginRecord => ({ ...record, enabled: uniqueIds.includes(record.id), updatedAt: uniqueIds.includes(record.id) ? updatedAt : record.updatedAt })));
	await appendPluginAudit({ action: "profile.update", profileId: getActivePluginProfile(profiles).id, pluginIds: uniqueIds });
	return await getPluginCatalog();
}

export async function getPluginCatalog(): Promise<PluginCatalogResult> {
	const plugins: PluginRecord[] = await readPluginRecords();
	const profiles: PluginProfile[] = await readPluginProfiles();
	const activeProfile: PluginProfile = getActivePluginProfile(profiles);
	return { plugins: plugins.map((plugin): PluginRecord => ({ ...plugin, enabled: plugin.trust === "trusted" && activeProfile.pluginIds.includes(plugin.id) })), profiles, activeProfile };
}

export function pluginFingerprint(record: PluginRecord): string {
	return createFingerprint(record.source, record.contentHash, record.manifestHash, record.compatibility, record.nativePlugin, record.dependencyLockHash);
}
