import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createSourceHookSource,
	readHookConfigDocument,
	writeHookConfigDocument
} from "../../../src/hooks/config-store.js";
import { updateHookTrust } from "../../../src/hooks/trust-store.js";
import type { WorkspaceConfig, WorkspaceSourceFolder } from "../../../src/workspace/types.js";

async function withHookWorkspace(run: (params: {
	profileRoot: string;
	workspace: WorkspaceConfig;
	source: WorkspaceSourceFolder;
}) => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const profileRoot: string = await mkdtemp(join(tmpdir(), "daedalus-hooks-profile-"));
	const sourcePath: string = join(profileRoot, "workspace");
	await mkdir(sourcePath, { recursive: true });
	process.env.USERPROFILE = profileRoot;
	const source: WorkspaceSourceFolder = {
		id: "source-main",
		path: sourcePath,
		capabilities: { git: true, godot: false }
	};
	const workspace: WorkspaceConfig = {
		id: "workspace-hooks",
		name: "Hooks workspace",
		kind: "godot",
		rootPath: sourcePath,
		icon: 0,
		color: 0,
		sourceFolders: [source],
		primarySourceFolderId: source.id
	};
	try {
		await run({ profileRoot, workspace, source });
	} finally {
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		await rm(profileRoot, { recursive: true, force: true });
	}
}

test("hook config save is atomic and rejects stale revisions", async (): Promise<void> => {
	await withHookWorkspace(async ({ workspace, source }): Promise<void> => {
		const configSource = createSourceHookSource(workspace, source);
		const initial = await readHookConfigDocument(configSource);
		assert.equal(initial.exists, false);
		const content: string = JSON.stringify({
			description: "Checks",
			hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node check.mjs" }] }] }
		}, null, 2);
		const saved = await writeHookConfigDocument({ source: configSource, content, expectedRevision: initial.revision });
		assert.equal(saved.exists, true);
		assert.equal(saved.valid, true);
		assert.equal(saved.handlers.length, 1);
		await assert.rejects(
			writeHookConfigDocument({ source: configSource, content, expectedRevision: initial.revision }),
			/hooks_config_conflict/u
		);
	});
});

test("hook trust is bound to the exact config and entry script fingerprint", async (): Promise<void> => {
	await withHookWorkspace(async ({ workspace, source }): Promise<void> => {
		const configSource = createSourceHookSource(workspace, source);
		await mkdir(join(source.path, ".daedalus", "hooks"), { recursive: true });
		const scriptPath: string = join(source.path, ".daedalus", "hooks", "check.mjs");
		await writeFile(scriptPath, "console.log('{}');\n", "utf8");
		const initial = await readHookConfigDocument(configSource);
		const content: string = JSON.stringify({
			hooks: { Stop: [{ hooks: [{ type: "command", command: "node .daedalus/hooks/check.mjs" }] }] }
		}, null, 2);
		let document = await writeHookConfigDocument({ source: configSource, content, expectedRevision: initial.revision });
		const originalFingerprint: string = document.handlers[0]!.fingerprint;
		await updateHookTrust(originalFingerprint, "trusted");
		document = await readHookConfigDocument(configSource);
		assert.equal(document.handlers[0]?.trust, "trusted");

		await writeFile(scriptPath, "console.log('{\"decision\":\"block\"}');\n", "utf8");
		document = await readHookConfigDocument(configSource);
		assert.notEqual(document.handlers[0]?.fingerprint, originalFingerprint);
		assert.equal(document.handlers[0]?.trust, "review_required");
	});
});
