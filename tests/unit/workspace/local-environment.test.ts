import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	parseLocalEnvironmentConfig,
	readLocalEnvironmentConfig,
	resolvePlatformScript,
	updateEnvironmentTrust,
	writeLocalEnvironmentConfig,
} from "../../../src/workspace/local-environment.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

function createWorkspace(rootPath: string): WorkspaceConfig {
	return {
		id: "workspace-environment-test",
		name: "Environment test",
		kind: "godot",
		rootPath,
		icon: 0,
		color: 0,
		primarySourceFolderId: "source-main",
		sourceFolders: [
			{
				id: "source-main",
				path: rootPath,
				capabilities: {
					git: false,
					godot: false,
				},
			},
		],
	};
}

test("local environment config validates limits and selects platform scripts", (): void => {
	const config = parseLocalEnvironmentConfig(JSON.stringify({
		version: 1,
		defaultEnvironmentId: "default",
		environments: [
			{
				id: "default",
				name: "Default",
				setup: {
					scripts: {
						default: "npm install",
						windows: "npm.cmd install",
					},
				},
				actions: [],
			},
		],
	}));
	assert.equal(config.defaultEnvironmentId, "default");
	assert.equal(resolvePlatformScript(config.environments[0]!.setup!.scripts, "win32"), "npm.cmd install");
	assert.equal(resolvePlatformScript(config.environments[0]!.setup!.scripts, "linux"), "npm install");
	assert.throws(
		(): void => {
			parseLocalEnvironmentConfig(JSON.stringify({
				version: 1,
				defaultEnvironmentId: "missing",
				environments: [],
			}));
		},
		/default environment/u,
	);
});

test("local environment config uses revisions and exact fingerprint trust", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const testRoot: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-environment-test-"));
	const profileRoot: string = path.join(testRoot, "profile");
	const sourceRoot: string = path.join(testRoot, "source");
	process.env.USERPROFILE = profileRoot;

	try {
		await fs.mkdir(sourceRoot, { recursive: true });
		const workspace: WorkspaceConfig = createWorkspace(sourceRoot);
		const initial = await readLocalEnvironmentConfig(workspace, "source-main");
		assert.equal(initial.exists, false);
		const content: string = `${JSON.stringify({
			version: 1,
			defaultEnvironmentId: "default",
			environments: [
				{
					id: "default",
					name: "Default",
					setup: { scripts: { default: "npm install" } },
					actions: [
						{
							id: "test",
							name: "Test",
							scripts: { default: "npm test" },
						},
					],
				},
			],
		}, null, 2)}\n`;
		const saved = await writeLocalEnvironmentConfig({
			workspace,
			sourceFolderId: "source-main",
			content,
			expectedRevision: initial.revision,
		});
		assert.equal(saved.exists, true);
		assert.equal(saved.profiles[0]?.trust, "review-required");
		await assert.rejects(
			writeLocalEnvironmentConfig({
				workspace,
				sourceFolderId: "source-main",
				content,
				expectedRevision: initial.revision,
			}),
			/environment configuration changed/u,
		);
		const fingerprint: string = saved.profiles[0]!.fingerprint;
		await updateEnvironmentTrust(fingerprint, "trusted");
		const trusted = await readLocalEnvironmentConfig(workspace, "source-main");
		assert.equal(trusted.profiles[0]?.trust, "trusted");
		assert.equal(trusted.profiles[0]?.fingerprint, fingerprint);
	} finally {
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		await fs.rm(testRoot, { recursive: true, force: true });
	}
});
