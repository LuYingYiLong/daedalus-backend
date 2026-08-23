import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getDaedalusPath } from "../app-paths.js";
import { analyzePluginDirectory, isPathInside, readPluginPresentation } from "./manifest.js";
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
import type { PluginCatalogResult, PluginCompatibility, PluginProfile, PluginRecord, PluginScanResult, PluginSource, PluginTrustStatus, PluginVersionRecord } from "./types.js";
import { readHarnessRuntimeConfig } from "./harness/config-store.js";
import { detectHarnessInstallation } from "./harness/installation.js";
import { createHarnessRuntimeFingerprint } from "./harness/trust.js";
import { archivePluginVersion, getPluginVersion, listPluginVersions } from "./versions.js";

const MAX_PROCESS_OUTPUT: number = 2 * 1024 * 1024;
const EXACT_NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/iu;
const SAFE_PROCESS_ENV_KEYS = new Set([
	"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "COMSPEC",
	"LANG", "LC_ALL", "CI", "NPM_CONFIG_IGNORE_SCRIPTS", "NPM_CONFIG_YES", "NPM_CONFIG_AUDIT", "NPM_CONFIG_FUND", "GIT_CONFIG_NOSYSTEM"
]);

function shouldCopyPluginEntry(source: string): boolean {
	const name = basename(source);
	return name !== "node_modules" && name !== ".git";
}

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
	const seen = new Set<string>();
	for (const entry of listing.stdout.split(/\r?\n/u).map((value): string => value.trim()).filter(Boolean)) {
		validateArchiveEntry(entry);
		const normalized = entry.replace(/\\/gu, "/").replace(/\/$/u, "");
		if (seen.has(normalized)) throw Object.assign(new Error(`Plugin archive contains a duplicate path: ${entry}`), { code: "plugin_archive_duplicate" });
		seen.add(normalized);
	}
	// Inspect entry types before extraction. A symlink or special file could
	// otherwise redirect a later archive entry outside the empty staging root.
	const metadata = await runProcess("tar", ["-tvzf", archivePath], destination);
	if (metadata.exitCode !== 0) throw new Error(`Unable to inspect plugin archive entries: ${metadata.stderr.trim()}`);
	for (const line of metadata.stdout.split(/\r?\n/u).map((value): string => value.trim()).filter(Boolean)) {
		const type = line[0];
		if (type !== "-" && type !== "d") throw Object.assign(new Error("Plugin archive contains a symlink or unsupported file type."), { code: "plugin_archive_unsafe_type" });
	}
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

function createFingerprint(source: PluginSource, contentHash: string, manifestHash: string, compatibility: PluginCompatibility, nativePlugin?: unknown, dependencyLockHash?: string, harnessBundle?: unknown, p2?: unknown): string {
	return createHash("sha256").update(JSON.stringify({ source, contentHash, manifestHash, compatibility, nativePlugin, dependencyLockHash, harnessBundle, p2 })).digest("hex");
}

export function computePluginFingerprint(scan: Pick<PluginScanResult, "contentHash" | "manifestHash" | "compatibility" | "nativePlugin" | "dependencyLockHash" | "harnessBundle" | "p2">, source: PluginSource): string {
	return createFingerprint(source, scan.contentHash, scan.manifestHash, scan.compatibility, scan.nativePlugin, scan.dependencyLockHash, scan.harnessBundle, scan.p2);
}

async function copyPreparedPackage(sourceRoot: string, packageId: string, contentHash: string): Promise<string> {
	const packagesRoot: string = getDaedalusPath("plugins.packages");
	await mkdir(packagesRoot, { recursive: true });
	const safeName: string = packageId.replace(/[^a-zA-Z0-9._@-]/gu, "_");
	const target: string = join(packagesRoot, safeName);
	if (!isPathInside(packagesRoot, target)) throw new Error("Plugin target path escapes the managed package directory.");
	const temporary: string = join(packagesRoot, `.${safeName}.${randomUUID()}.staging`);
	try {
		const existing = await stat(target);
		if (!existing.isDirectory()) throw new Error("Managed plugin package path is not a directory.");
		try {
			const current = await analyzePluginDirectory(target);
			if (current.contentHash.startsWith(contentHash.slice(0, 12))) return target;
		} catch {
			// Replace an incomplete or tampered package through the same atomic path.
		}
	} catch {
		// The target does not exist yet; the commit below will create it.
	}
	await cp(sourceRoot, temporary, { recursive: true, force: false, errorOnExist: true, dereference: false, filter: shouldCopyPluginEntry });
	try {
		await analyzePluginDirectory(temporary);
		const backup: string = join(packagesRoot, `.${safeName}.${randomUUID()}.backup`);
		let movedExisting: boolean = false;
		try {
			await rename(target, backup);
			movedExisting = true;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(temporary, target);
		} catch (error: unknown) {
			if (movedExisting) await rename(backup, target).catch((): void => undefined);
			throw error;
		}
		if (movedExisting) await rm(backup, { recursive: true, force: true });
		return target;
	} finally {
		await rm(temporary, { recursive: true, force: true }).catch((): void => undefined);
	}
}

export async function installPlugin(source: PluginSource): Promise<PluginRecord> {
	const prepared = await prepareSource(source);
	try {
		const scan: PluginScanResult = await analyzePluginDirectory(prepared.root);
		const id: string = createPluginId(scan.packageName, scan.version, scan.contentHash);
		const packageRoot: string = await copyPreparedPackage(prepared.root, id, scan.contentHash);
		const now: string = new Date().toISOString();
		const trust = await readPluginTrust();
		const fingerprint: string = createFingerprint(source, scan.contentHash, scan.manifestHash, scan.compatibility, scan.nativePlugin, scan.dependencyLockHash, scan.harnessBundle, scan.p2);
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
			...(scan.presentation === undefined ? {} : { presentation: scan.presentation }),
			...(scan.nativePlugin === undefined ? {} : { nativePlugin: scan.nativePlugin }),
			...(scan.p2 === undefined ? {} : { p2: scan.p2 }),
			...(scan.dependencyLockHash === undefined ? {} : { dependencyLockHash: scan.dependencyLockHash }),
			...(scan.harnessBundle === undefined ? {} : { harnessBundle: scan.harnessBundle })
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

export async function updatePluginFromSource(pluginId: string, source: PluginSource, expectedFingerprint: string): Promise<PluginRecord> {
	const current = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
	if (current === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
	if (current.fingerprint !== expectedFingerprint) throw Object.assign(new Error("Plugin changed while preparing the update. Reload the plugin before updating."), { code: "plugin_fingerprint_stale" });
	const previousTrust = await readPluginTrust();
	const previousProfiles = await readPluginProfiles();
	const prepared = await prepareSource(source);
	try {
	const scan = await analyzePluginDirectory(prepared.root);
		if (scan.packageName !== current.packageName) throw Object.assign(new Error("Plugin update must keep the existing package name."), { code: "plugin_package_name_changed" });
		const fingerprint = createFingerprint(source, scan.contentHash, scan.manifestHash, scan.compatibility, scan.nativePlugin, scan.dependencyLockHash, scan.harnessBundle, scan.p2);
		const stagingRoot = join(getDaedalusPath("plugins.root"), "staging", randomUUID());
		await mkdir(join(getDaedalusPath("plugins.root"), "staging"), { recursive: true });
		try {
			await cp(prepared.root, stagingRoot, { recursive: true, force: false, errorOnExist: true, dereference: false, filter: shouldCopyPluginEntry });
			const runtime = await import("./runtime/manager.js");
			await runtime.stopPlugin(pluginId);
			await archivePluginVersion(current);
			await rm(current.packageRoot, { recursive: true, force: true });
			await mkdir(resolve(getDaedalusPath("plugins.packages")), { recursive: true });
			const target = join(getDaedalusPath("plugins.packages"), current.id.replace(/[^a-zA-Z0-9._@-]/gu, "_"));
			await cp(stagingRoot, target, { recursive: true, force: false, errorOnExist: true, dereference: false, filter: shouldCopyPluginEntry });
			const now = new Date().toISOString();
			const next: PluginRecord = {
				...current,
				source,
				version: scan.version,
				packageRoot: target,
				contentHash: scan.contentHash,
				manifestHash: scan.manifestHash,
				fingerprint,
				compatibility: scan.compatibility,
				trust: "review_required",
				enabled: false,
				updatedAt: now,
				...(scan.presentation === undefined ? {} : { presentation: scan.presentation }),
				...(scan.nativePlugin === undefined ? {} : { nativePlugin: scan.nativePlugin }),
				...(scan.p2 === undefined ? { p2: undefined } : { p2: scan.p2 }),
				...(scan.dependencyLockHash === undefined ? {} : { dependencyLockHash: scan.dependencyLockHash }),
				...(scan.harnessBundle === undefined ? {} : { harnessBundle: scan.harnessBundle }),
				harnessRuntimeFingerprint: undefined,
				isolation: undefined,
				lastError: undefined
			};
			await updatePluginState((records): PluginRecord[] => records.map((record): PluginRecord => record.id === pluginId ? next : record));
			await updatePluginTrust((entries): typeof entries => ({ ...entries, [pluginId]: { fingerprint, status: "review_required", updatedAt: now } }));
			await updatePluginProfiles((profiles): PluginProfile[] => profiles.map((profile): PluginProfile => ({ ...profile, pluginIds: profile.pluginIds.filter((id): boolean => id !== pluginId), updatedAt: now })));
			await appendPluginAudit({ action: "update", pluginId, previousFingerprint: current.fingerprint, fingerprint, version: scan.version });
			return next;
		} catch (error: unknown) {
			// The previous package is the recovery source if any commit step fails.
			const previous = await getPluginVersion(current.id, current.fingerprint);
			if (previous !== undefined) {
				await rm(current.packageRoot, { recursive: true, force: true }).catch((): void => undefined);
				await cp(previous.packageRoot, current.packageRoot, { recursive: true, force: false, errorOnExist: true, dereference: false }).catch((): void => undefined);
			}
			await updatePluginState((records): PluginRecord[] => records.map((record): PluginRecord => record.id === pluginId ? current : record)).catch((): void => undefined);
			await updatePluginTrust((): typeof previousTrust => previousTrust).catch((): void => undefined);
			await updatePluginProfiles((): PluginProfile[] => previousProfiles).catch((): void => undefined);
			throw error;
		} finally {
			await rm(stagingRoot, { recursive: true, force: true }).catch((): void => undefined);
		}
	} finally {
		await prepared.cleanup();
	}
}

export async function listPluginVersionRecords(pluginId: string): Promise<PluginVersionRecord[]> {
	return await listPluginVersions(pluginId);
}

export async function rollbackPluginVersion(pluginId: string, fingerprint: string): Promise<PluginRecord> {
	const current = (await readPluginRecords()).find((candidate): boolean => candidate.id === pluginId);
	const version = current === undefined ? undefined : await getPluginVersion(pluginId, fingerprint);
	if (current === undefined || version === undefined) throw Object.assign(new Error("Plugin version is unavailable."), { code: "plugin_version_unavailable" });
	if (version.record.trust !== "trusted") throw Object.assign(new Error("Only trusted plugin versions can be restored."), { code: "plugin_version_not_trusted" });
	const rollbackRoot = await mkdtemp(join(tmpdir(), "daedalus-plugin-rollback-"));
	try {
		await cp(version.packageRoot, join(rollbackRoot, "package"), { recursive: true, force: false, errorOnExist: true, dereference: false });
		const runtime = await import("./runtime/manager.js");
	await runtime.stopPlugin(pluginId);
	await archivePluginVersion(current);
	await rm(current.packageRoot, { recursive: true, force: true });
	await cp(join(rollbackRoot, "package"), current.packageRoot, { recursive: true, force: false, errorOnExist: true, dereference: false });
	const restored: PluginRecord = { ...version.record, packageRoot: current.packageRoot, updatedAt: new Date().toISOString(), lastError: undefined, isolation: undefined };
	await updatePluginState((records): PluginRecord[] => records.map((record): PluginRecord => record.id === pluginId ? restored : record));
	await updatePluginTrust((entries): typeof entries => ({ ...entries, [pluginId]: { fingerprint: restored.fingerprint, status: restored.trust, updatedAt: restored.updatedAt } }));
	await updatePluginProfiles((profiles): PluginProfile[] => profiles.map((profile): PluginProfile => profile.active
		? { ...profile, pluginIds: restored.trust === "trusted" ? [...new Set([...profile.pluginIds, pluginId])] : profile.pluginIds.filter((id): boolean => id !== pluginId), updatedAt: restored.updatedAt }
		: profile));
	await appendPluginAudit({ action: "rollback", pluginId, fingerprint: restored.fingerprint });
	return restored;
	} finally {
		await rm(rollbackRoot, { recursive: true, force: true }).catch((): void => undefined);
	}
}

export async function removePlugin(pluginId: string): Promise<void> {
	const records: PluginRecord[] = await readPluginRecords();
	const record: PluginRecord | undefined = records.find((candidate): boolean => candidate.id === pluginId);
	if (record === undefined) throw Object.assign(new Error("Plugin not found."), { code: "plugin_not_found" });
	const runtime = await import("./runtime/manager.js");
	await runtime.stopPlugin(pluginId);
	await runtime.clearPluginRuntimeQuarantine(pluginId);
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
	const expected: string = createFingerprint(record.source, record.contentHash, record.manifestHash, record.compatibility, record.nativePlugin, record.dependencyLockHash, record.harnessBundle, record.p2);
	if (expected !== fingerprint) throw Object.assign(new Error("Plugin fingerprint is stale. Rescan the plugin before updating trust."), { code: "plugin_fingerprint_stale" });
	const updatedAt: string = new Date().toISOString();
	let harnessRuntimeFingerprint: string | undefined;
	if (status === "trusted" && record.compatibility.harnessBundle) {
		const config = await readHarnessRuntimeConfig();
		const installation = await detectHarnessInstallation(config);
		if (installation.status !== "detected") throw Object.assign(new Error(installation.error ?? "Configure a compatible Harness runtime before trusting this Bundle."), { code: "plugin_harness_unavailable" });
		harnessRuntimeFingerprint = createHarnessRuntimeFingerprint(record, config, installation);
	}
	await updatePluginTrust((entries): typeof entries => ({ ...entries, [pluginId]: { fingerprint, status, updatedAt } }));
	const records: PluginRecord[] = await updatePluginState((current): PluginRecord[] => current.map((candidate): PluginRecord => {
		if (candidate.id !== pluginId) return candidate;
		const { harnessRuntimeFingerprint: _previous, ...rest } = candidate;
		return { ...rest, trust: status, enabled: status === "trusted", updatedAt, ...(harnessRuntimeFingerprint === undefined ? {} : { harnessRuntimeFingerprint }) };
	}));
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
	const hydratedPlugins: PluginRecord[] = await Promise.all(plugins.map(async (plugin): Promise<PluginRecord> => {
		if (plugin.presentation !== undefined) return plugin;
		try {
			const presentation = await readPluginPresentation(plugin.packageRoot);
			return presentation === undefined ? plugin : { ...plugin, presentation };
		} catch {
			return plugin;
		}
	}));
	if (hydratedPlugins.some((plugin, index): boolean => plugin.presentation !== undefined && plugins[index]?.presentation === undefined)) {
		await updatePluginState((current): PluginRecord[] => current.map((record): PluginRecord => {
			const hydrated: PluginRecord | undefined = hydratedPlugins.find((plugin): boolean => plugin.id === record.id);
			return hydrated?.presentation === undefined || record.presentation !== undefined
				? record
				: { ...record, presentation: hydrated.presentation };
		}));
	}
	return { plugins: hydratedPlugins.map((plugin): PluginRecord => ({ ...plugin, enabled: plugin.trust === "trusted" && activeProfile.pluginIds.includes(plugin.id) })), profiles, activeProfile };
}

export function pluginFingerprint(record: PluginRecord): string {
	return createFingerprint(record.source, record.contentHash, record.manifestHash, record.compatibility, record.nativePlugin, record.dependencyLockHash, record.harnessBundle, record.p2);
}
