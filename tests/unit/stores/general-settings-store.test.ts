import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("general settings default next-step hints to disabled and persist updates", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-general-settings-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../../../src/general-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../../../src/app-paths.js?case=${Date.now()}-${Math.random()}`);

		assert.equal((await store.getGeneralSettings()).nextStepHintsEnabled, false);

		const saved = await store.updateGeneralSettings({
			nextStepHintsEnabled: false
		});
	assert.equal(saved.schemaVersion, 4);
		assert.equal(saved.nextStepHintsEnabled, false);
		assert.equal(saved.autoCompactActivityDetails, true);
		assert.equal(saved.godotExecutablePath, null);
		assert.equal(saved.godotExecutableStatus, "unconfigured");
		assert.notEqual(saved.updatedAt, "");

		const rawConfig: string = await readFile(appPaths.getGeneralSettingsConfigPath(), "utf8");
		assert.match(rawConfig, /"nextStepHintsEnabled": false/u);
		assert.equal(rawConfig.includes("fontFamily"), false);
		assert.equal(rawConfig.endsWith("\n"), true);
		assert.equal((await store.getGeneralSettings()).nextStepHintsEnabled, false);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});

test("general settings fallback to defaults for invalid config without compatibility migration", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-general-settings-invalid-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../../../src/general-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../../../src/app-paths.js?case=${Date.now()}-${Math.random()}`);

		const configPath: string = appPaths.getGeneralSettingsConfigPath();
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({
			schemaVersion: 0,
			nextStepHintsEnabled: false
		}), "utf8");

		assert.deepEqual(await store.getGeneralSettings(), {
			schemaVersion: 4,
			nextStepHintsEnabled: false,
			autoCompactActivityDetails: true,
			godotExecutablePath: null,
			godotExecutableVersion: null,
			godotExecutableStatus: "unconfigured",
			godotExecutableError: null,
			updatedAt: ""
		});
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});

test("general settings ignores v1 config and rejects an invalid Godot executable", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-general-settings-v2-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../../../src/general-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../../../src/app-paths.js?case=${Date.now()}-${Math.random()}`);
		const configPath: string = appPaths.getGeneralSettingsConfigPath();
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({
			schemaVersion: 1,
			updatedAt: "2026-07-23T00:00:00.000Z"
		}), "utf8");

		assert.deepEqual(await store.getGeneralSettings(), {
			schemaVersion: 4,
			nextStepHintsEnabled: false,
			autoCompactActivityDetails: true,
			godotExecutablePath: null,
			godotExecutableVersion: null,
			godotExecutableStatus: "unconfigured",
			godotExecutableError: null,
			updatedAt: ""
		});

		await writeFile(configPath, JSON.stringify({
			schemaVersion: 3,
			godotExecutablePath: null,
			godotExecutableVersion: null,
			updatedAt: "2026-07-23T00:00:00.000Z"
		}), "utf8");

		await assert.rejects(
			() => store.updateGeneralSettings({ godotExecutablePath: join(appDataDir, "missing-godot.exe") }),
			/Godot executable/u
		);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});

test("general settings migrate schema 3 without resetting existing preferences", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-general-settings-migration-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../../../src/general-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../../../src/app-paths.js?case=${Date.now()}-${Math.random()}`);
		const configPath: string = appPaths.getGeneralSettingsConfigPath();
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({
			schemaVersion: 3,
			nextStepHintsEnabled: true,
			godotExecutablePath: null,
			godotExecutableVersion: null,
			updatedAt: "2026-07-23T00:00:00.000Z"
		}), "utf8");

		const settings = await store.getGeneralSettings();
		assert.equal(settings.schemaVersion, 4);
		assert.equal(settings.nextStepHintsEnabled, true);
		assert.equal(settings.autoCompactActivityDetails, true);
		const migrated = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
		assert.equal(migrated.schemaVersion, 4);
		assert.equal(migrated.nextStepHintsEnabled, true);
		assert.equal(migrated.autoCompactActivityDetails, true);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});
