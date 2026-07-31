import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagerError } from "../../../src/manager/manager-error.js";
import { assertInside } from "../../../src/manager/paths.js";
import { isVersionNewer, parseSemver } from "../../../src/manager/semver.js";
import {
	getVersionFromGithubRelease,
	normalizeFrontendVersion,
	selectFrontendZipAsset,
	validateFrontendManifest,
	type GithubRelease
} from "../../../src/manager/frontend.js";
import { readJsonFile, writeJsonFile } from "../../../src/manager/json-file.js";
import type { BackendCurrentFile, PendingFrontendUpdate } from "../../../src/manager/types.js";
import { installBackend, rollbackBackend } from "../../../src/manager/backend.js";
import { applyFrontendUpdateWait } from "../../../src/manager/frontend.js";
import { getCachedOrFetchLatestVersion } from "../../../src/manager/latest-cache.js";
import { readStatus } from "../../../src/manager/status.js";

test("manager semver parser compares stable versions", (): void => {
	assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
	assert.equal(isVersionNewer("1.2.4", "1.2.3"), true);
	assert.equal(isVersionNewer("1.2.3", "1.2.3"), false);
	assert.equal(isVersionNewer("1.2.3", "1.3.0"), false);
	assert.equal(isVersionNewer("bad", "1.3.0"), false);
});

test("package bin entries point to packaged files", async (): Promise<void> => {
	const rawPackageJson: string = await readFile("package.json", "utf8");
	const packageJson = JSON.parse(rawPackageJson) as { bin?: Record<string, string> };
	assert.equal(typeof packageJson.bin, "object");

	for (const [binName, binPath] of Object.entries(packageJson.bin ?? {})) {
		assert.match(binName, /^godot-daedalus-/);
		await readFile(binPath, "utf8");
	}
});

test("manager path guard rejects traversal", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-path-"));
	assert.equal(assertInside(root, join(root, "backend", "current.json")), join(root, "backend", "current.json"));
	assert.throws((): void => {
		assertInside(root, join(root, "..", "outside"));
	}, ManagerError);
	await removeTempDir(root);
});

test("frontend manifest validation rejects unsafe metadata", (): void => {
	validateFrontendManifest({
		version: "1.0.0",
		tag: "v1.0.0",
		assetName: "godot-daedalus-plugin-v1.0.0.zip",
		sha256: "a".repeat(64),
		minGodotVersion: "4.4"
	});
	assert.throws((): void => {
		validateFrontendManifest({
			version: "1.0.0",
			tag: "v1.0.0",
			assetName: "godot-daedalus-plugin-v1.0.0.zip",
			sha256: "a".repeat(64)
		});
	}, ManagerError);
	assert.throws((): void => {
		validateFrontendManifest({
			version: "1.0",
			tag: "v1.0",
			assetName: "plugin.zip",
			sha256: "a".repeat(64),
			minGodotVersion: "4.4"
		});
	}, ManagerError);
	assert.throws((): void => {
		validateFrontendManifest({
			version: "1.0.0",
			tag: "v1.0.1",
			assetName: "plugin.zip",
			sha256: "a".repeat(64),
			minGodotVersion: "4.4"
		});
	}, ManagerError);
});

test("frontend release parsing accepts semantic GitHub tags", (): void => {
	assert.equal(normalizeFrontendVersion("v1.0.1"), "1.0.1");
	assert.equal(normalizeFrontendVersion("1.0.1"), "1.0.1");
	assert.equal(normalizeFrontendVersion("release-1.0.1"), null);
	assert.equal(getVersionFromGithubRelease({ tag_name: "v1.0.1" }), "1.0.1");
	assert.equal(getVersionFromGithubRelease({ tag_name: 101 }), null);
});

test("frontend release asset selection accepts legacy plugin zip names", (): void => {
	const release: GithubRelease = {
		tag_name: "v1.0.1",
		assets: [
			{ name: "source.zip", browser_download_url: "https://example.invalid/source.zip" },
			{ name: "godot_daedalus.zip", browser_download_url: "https://example.invalid/godot_daedalus.zip" }
		]
	};
	assert.equal(selectFrontendZipAsset(release, "1.0.1")?.name, "godot_daedalus.zip");
});

test("manager json file writes atomically readable current metadata", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-json-"));
	const filePath: string = join(root, "backend", "current.json");
	const value: BackendCurrentFile = {
		version: "1.0.4",
		path: join(root, "backend", "versions", "1.0.4"),
		previousVersion: "1.0.3",
		updatedAt: new Date(0).toISOString()
	};
	await writeJsonFile(filePath, value);
	assert.deepEqual(await readJsonFile<BackendCurrentFile>(filePath), value);
	assert.equal(await readFile(filePath, "utf8"), `${JSON.stringify(value, null, 2)}\n`);
	await removeTempDir(root);
});

test("manager latest cache avoids repeated network checks", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-cache-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		let fetchCount: number = 0;
		const firstVersion: string | null = await getCachedOrFetchLatestVersion("frontend", async (): Promise<string> => {
			fetchCount += 1;
			return "1.0.0";
		});
		const secondVersion: string | null = await getCachedOrFetchLatestVersion("frontend", async (): Promise<string> => {
			fetchCount += 1;
			return "1.0.1";
		});
		assert.equal(firstVersion, "1.0.0");
		assert.equal(secondVersion, "1.0.0");
		assert.equal(fetchCount, 1);
	} finally {
		if (previousAppDir === undefined) {
			delete process.env.GODOT_DAEDALUS_APP_DIR;
		} else {
			process.env.GODOT_DAEDALUS_APP_DIR = previousAppDir;
		}
		await removeTempDir(root);
	}
});

test("manager latest cache can skip network entirely", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-cache-skip-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		let fetchCount: number = 0;
		const version: string | null = await getCachedOrFetchLatestVersion("backend", async (): Promise<string> => {
			fetchCount += 1;
			return "1.0.4";
		}, { skipNetwork: true });
		assert.equal(version, null);
		assert.equal(fetchCount, 0);
	} finally {
		if (previousAppDir === undefined) {
			delete process.env.GODOT_DAEDALUS_APP_DIR;
		} else {
			process.env.GODOT_DAEDALUS_APP_DIR = previousAppDir;
		}
		await removeTempDir(root);
	}
});

test("manager latest cache falls back to cached version when network throws", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-cache-error-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		const firstVersion: string | null = await getCachedOrFetchLatestVersion("frontend", async (): Promise<string> => "1.0.1");
		const secondVersion: string | null = await getCachedOrFetchLatestVersion("frontend", async (): Promise<string> => {
			throw new Error("fetch failed");
		}, { forceRefresh: true });
		assert.equal(firstVersion, "1.0.1");
		assert.equal(secondVersion, "1.0.1");
	} finally {
		if (previousAppDir === undefined) {
			delete process.env.GODOT_DAEDALUS_APP_DIR;
		} else {
			process.env.GODOT_DAEDALUS_APP_DIR = previousAppDir;
		}
		await removeTempDir(root);
	}
});

test("frontend package fixture has addon layout", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-addon-"));
	const pluginCfgPath: string = join(root, "addons", "godot_daedalus", "plugin.cfg");
	await mkdir(join(root, "addons", "godot_daedalus"), { recursive: true });
	await writeFile(pluginCfgPath, "[plugin]\nversion=\"1.0.0\"\n", "utf8");
	assert.match(await readFile(pluginCfgPath, "utf8"), /version="1\.0\.0"/);
	await removeTempDir(root);
});

test("frontend apply-wait reports missing pending update", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-apply-wait-missing-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		await assert.rejects(
			applyFrontendUpdateWait(root, { timeoutMs: 5, intervalMs: 1 }),
			(error: unknown): boolean => error instanceof ManagerError && error.code === "frontend_update_missing"
		);
	} finally {
		restoreEnv("GODOT_DAEDALUS_APP_DIR", previousAppDir);
		await removeTempDir(root);
	}
});

test("frontend apply-wait reports missing staged directory", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-apply-wait-staged-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		await writePendingFrontendUpdate(root, join(root, "missing-staged"), "1.0.9");
		await assert.rejects(
			applyFrontendUpdateWait(root, { timeoutMs: 5, intervalMs: 1 }),
			(error: unknown): boolean => error instanceof ManagerError && error.code === "frontend_update_missing"
		);
	} finally {
		restoreEnv("GODOT_DAEDALUS_APP_DIR", previousAppDir);
		await removeTempDir(root);
	}
});

test("frontend apply-wait retries locked plugin directory and then succeeds", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-apply-wait-retry-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		const stagedDir: string = join(root, "staged");
		await mkdir(join(stagedDir, "addons", "godot_daedalus"), { recursive: true });
		await writeFile(join(stagedDir, "addons", "godot_daedalus", "plugin.cfg"), "[plugin]\nversion=\"1.0.9\"\n", "utf8");
		await writePendingFrontendUpdate(root, stagedDir, "1.0.9");
		let attempts: number = 0;
		const result = await applyFrontendUpdateWait(root, {
			// Windows 上并行测试的日志落盘可能超过 100ms，避免重试断言受调度影响。
			timeoutMs: 2_000,
			intervalMs: 1,
			applyUpdate: async (): Promise<{ applied: boolean; version: string | null }> => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("locked");
					(error as NodeJS.ErrnoException).code = "EBUSY";
					throw error;
				}
				return { applied: true, version: "1.0.9" };
			}
		});
		assert.equal(result.applied, true);
		assert.equal(result.version, "1.0.9");
		assert.equal(attempts, 3);
	} finally {
		restoreEnv("GODOT_DAEDALUS_APP_DIR", previousAppDir);
		await removeTempDir(root);
	}
});

test("manager status hides stale pending frontend update when installed version already matches", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-status-pending-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		const projectRoot: string = join(root, "project");
		await mkdir(join(projectRoot, "addons", "godot_daedalus"), { recursive: true });
		await writeFile(join(projectRoot, "addons", "godot_daedalus", "plugin.cfg"), "[plugin]\nversion=\"1.0.1\"\n", "utf8");
		const stagedDir: string = join(root, "staged");
		await mkdir(join(stagedDir, "addons", "godot_daedalus"), { recursive: true });
		await writePendingFrontendUpdate(root, stagedDir, "1.0.1");
		const status = await readStatus(projectRoot, { includeLatest: false });
		assert.equal(status.frontend.installedVersion, "1.0.1");
		assert.equal(status.frontend.pendingVersion, null);
	} finally {
		restoreEnv("GODOT_DAEDALUS_APP_DIR", previousAppDir);
		await removeTempDir(root);
	}
});

test("backend install stages local packages and rollback switches current version", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-install-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	const previousNpmDryRun: string | undefined = process.env.npm_config_dry_run;
	const previousPath: string | undefined = process.env.PATH;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	process.env.npm_config_dry_run = "true";
	try {
		const fakeNpmBinDir: string = await createFakeNpmInstallShim(root);
		process.env.PATH = previousPath === undefined ? fakeNpmBinDir : `${fakeNpmBinDir}${process.platform === "win32" ? ";" : ":"}${previousPath}`;
		const package103: string = await createFakeBackendPackage(root, "1.0.3");
		const package104: string = await createFakeBackendPackage(root, "1.0.4");
		assert.equal((await installBackend(package103)).version, "1.0.3");
		assert.equal((await installBackend(package104)).version, "1.0.4");
		const rolledBack: BackendCurrentFile = await rollbackBackend();
		assert.equal(rolledBack.version, "1.0.3");
		assert.equal(rolledBack.previousVersion, "1.0.4");
	} finally {
		if (previousAppDir === undefined) {
			delete process.env.GODOT_DAEDALUS_APP_DIR;
		} else {
			process.env.GODOT_DAEDALUS_APP_DIR = previousAppDir;
		}
		if (previousNpmDryRun === undefined) {
			delete process.env.npm_config_dry_run;
		} else {
			process.env.npm_config_dry_run = previousNpmDryRun;
		}
		restoreEnv("PATH", previousPath);
		await removeTempDir(root);
	}
});

async function createFakeBackendPackage(root: string, version: string): Promise<string> {
	const packageDir: string = join(root, `fake-${version}`);
	await mkdir(packageDir, { recursive: true });
	await writeFile(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "daedalus-backend",
			version,
			type: "module",
			bin: {
				"godot-daedalus-backend": "bin/backend.js",
				"godot-daedalus-manager": "bin/manager.js"
			}
		}, null, 2),
		"utf8"
	);
	await mkdir(join(packageDir, "bin"), { recursive: true });
	await writeFile(join(packageDir, "bin", "backend.js"), "#!/usr/bin/env node\n", "utf8");
	await writeFile(join(packageDir, "bin", "manager.js"), "#!/usr/bin/env node\n", "utf8");
	return packageDir;
}

async function createFakeNpmInstallShim(root: string): Promise<string> {
	const binDir: string = join(root, "fake-npm-bin");
	await mkdir(binDir, { recursive: true });
	const shimScriptPath: string = join(binDir, "fake-npm.cjs");
	await writeFile(shimScriptPath, [
		"const fs = require(\"node:fs\");",
		"const path = require(\"node:path\");",
		"const args = process.argv.slice(2);",
		"const prefixIndex = args.indexOf(\"--prefix\");",
		"const packageSpec = args.at(-1);",
		"if (args[0] !== \"install\" || prefixIndex < 0 || packageSpec === undefined) {",
		"  console.error(`unsupported fake npm invocation: ${args.join(\" \")}`);",
		"  process.exit(1);",
		"}",
		"const prefix = args[prefixIndex + 1];",
		"if (prefix === undefined) {",
		"  console.error(\"missing --prefix value\");",
		"  process.exit(1);",
		"}",
		"const packageRoot = path.resolve(packageSpec);",
		"const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, \"package.json\"), \"utf8\"));",
		"const target = path.join(prefix, \"node_modules\", manifest.name);",
		"fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });",
		"fs.mkdirSync(path.dirname(target), { recursive: true });",
		"fs.cpSync(packageRoot, target, { recursive: true });",
		"process.exit(0);",
		""
	].join("\n"), "utf8");
	const cmdShimPath: string = join(binDir, "npm.cmd");
	await writeFile(cmdShimPath, "@echo off\r\nnode \"%~dp0fake-npm.cjs\" %*\r\n", "utf8");
	const shellShimPath: string = join(binDir, "npm");
	await writeFile(shellShimPath, "#!/bin/sh\nnode \"$(dirname \"$0\")/fake-npm.cjs\" \"$@\"\n", "utf8");
	await chmod(shellShimPath, 0o755);
	return binDir;
}

async function writePendingFrontendUpdate(root: string, stagedDir: string, version: string): Promise<void> {
	const pending: PendingFrontendUpdate = {
		version,
		sourceZipPath: join(root, "plugin.zip"),
		stagedDir,
		manifest: {
			version,
			tag: `v${version}`,
			sha256: "a".repeat(64),
			assetName: "godot_daedalus.zip",
			minGodotVersion: "4.5"
		},
		createdAt: new Date(0).toISOString()
	};
	await writeJsonFile(join(root, "app", "frontend", "pending_frontend_update.json"), pending);
}

function restoreEnv(name: string, previousValue: string | undefined): void {
	if (previousValue === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = previousValue;
}

async function removeTempDir(root: string): Promise<void> {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 8,
		retryDelay: 250
	});
}
