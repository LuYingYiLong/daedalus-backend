import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

const WEBP_BYTES: Buffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-session-overview-"));
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	}
}

function hasGit(): boolean {
	const result = spawnSync("git", ["--version"], { encoding: "utf8" });
	return result.status === 0;
}

test("session overview lists recent plans and image sources", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const planStore = await import("../../../src/server/plan-store.js");
		const overview = await import("../../../src/server/session-overview.js");
		const metadata = await sessionStore.createSession("Overview test");

		for (let index: number = 0; index < 4; index += 1) {
			const planMetadata = planStore.createPlanMetadata({
				sessionId: metadata.id,
				requestId: `request-${index}`,
				status: "ready",
				title: `Plan ${index}`,
				originalMessage: "Plan request",
				previewMarkdown: `# Plan ${index}`,
				now: `2026-07-19T00:00:0${index}.000Z`
			});
			await planStore.writeStoredPlan(planMetadata, `# Plan ${index}\n`);
		}

		await attachments.saveImageAttachment({
			sessionId: metadata.id,
			mimeType: "image/png",
			dataUrl: "data:image/png;base64,aW1hZ2UtYXR0YWNobWVudA==",
			byteSize: Buffer.byteLength("image-attachment"),
			title: "Manual source"
		});
		await attachments.saveGeneratedImageArtifact({
			sessionId: metadata.id,
			bytes: WEBP_BYTES,
			mimeType: "image/webp",
			provider: "openai",
			model: "gpt-image-1",
			prompt: "Generated source"
		});
		await attachments.saveTextAttachment({
			sessionId: metadata.id,
			content: "Pasted notes for the current session.",
			title: "Pasted notes.txt"
		});

		const result = await overview.createSessionOverview({
			sessionId: metadata.id,
			planLimit: 3,
			sourceLimit: 3
		});

		assert.equal(result.sessionId, metadata.id);
		assert.equal(result.envInfo, null);
		assert.deepEqual(result.envInfos, []);
		assert.equal(result.plans.total, 4);
		assert.equal(result.plans.items.length, 3);
		assert.deepEqual(result.plans.items.map((plan) => plan.title), ["Plan 3", "Plan 2", "Plan 1"]);
		assert.equal(result.sources.total, 3);
		assert.equal(result.sources.items.some((source) => source.kind === "image_attachment"), true);
		assert.equal(result.sources.items.some((source) => source.kind === "generated_image"), true);
		assert.equal(result.sources.items.some((source) => source.kind === "text_attachment" && source.textPreview === "Pasted notes for the current session."), true);
		assert.equal(
			result.sources.items
				.filter((source) => source.thumbnailDataUrl !== undefined)
				.every((source) => source.thumbnailDataUrl?.startsWith(`data:${source.mimeType};base64,`) === true),
			true
		);
	});
});

test("session overview can list image metadata without reading image payloads", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const overview = await import("../../../src/server/session-overview.js");
		const metadata = await sessionStore.createSession("Overview metadata test");

		const imageAttachment = await attachments.saveImageAttachment({
			sessionId: metadata.id,
			mimeType: "image/png",
			dataUrl: "data:image/png;base64,aW1hZ2UtYXR0YWNobWVudA==",
			byteSize: Buffer.byteLength("image-attachment"),
			title: "Manual source"
		});
		const generatedImage = await attachments.saveGeneratedImageArtifact({
			sessionId: metadata.id,
			bytes: WEBP_BYTES,
			mimeType: "image/webp",
			provider: "openai",
			model: "gpt-image-1",
			prompt: "Generated source"
		});
		await rm(join(sessionStore.getSessionDir(metadata.id), "attachments", `${imageAttachment.id}.png`));
		await rm(join(sessionStore.getSessionDir(metadata.id), "attachments", "images", generatedImage.fileName));

		const result = await overview.createSessionOverview({
			sessionId: metadata.id,
			planLimit: 0,
			sourceLimit: 100,
			includeSourceImages: false
		});

		assert.equal(result.sources.total, 2);
		assert.equal(result.sources.items.length, 2);
		assert.equal(result.sources.items.every((source) => source.thumbnailDataUrl === undefined), true);
		assert.equal(result.sources.items.every((source) => source.byteSize > 0), true);
	});
});

test("session overview can list plan metadata without returning preview markdown", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const planStore = await import("../../../src/server/plan-store.js");
		const overview = await import("../../../src/server/session-overview.js");
		const metadata = await sessionStore.createSession("Overview plan metadata test");
		const planMetadata = planStore.createPlanMetadata({
			sessionId: metadata.id,
			requestId: "request-plan-metadata",
			status: "ready",
			title: "Metadata-only plan",
			originalMessage: "Create a plan",
			previewMarkdown: "# Preview that should not be returned"
		});
		await planStore.writeStoredPlan(planMetadata, "# Full plan markdown");

		const result = await overview.createSessionOverview({
			sessionId: metadata.id,
			planLimit: 100,
			sourceLimit: 0,
			includePlanPreviews: false
		});

		assert.equal(result.plans.total, 1);
		assert.equal(result.plans.items.length, 1);
		assert.equal(result.plans.items[0]?.title, "Metadata-only plan");
		assert.equal(result.plans.items[0]?.previewMarkdown, "");
	});
});

test("session overview returns git env info only for git workspaces", async (t): Promise<void> => {
	if (!hasGit()) {
		t.skip("git is not available in this environment");
		return;
	}

	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../../../src/session/session-store.js");
		const overview = await import("../../../src/server/session-overview.js");
		const workspaceRegistry = await import("../../../src/workspace/registry.js");
		const workspaceRoot: string = await mkdtemp(join(tmpdir(), "daedalus-overview-git-"));
		const secondaryRoot: string = await mkdtemp(join(tmpdir(), "daedalus-overview-secondary-"));

		spawnSync("git", ["init"], { cwd: workspaceRoot, encoding: "utf8" });
		spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: workspaceRoot, encoding: "utf8" });
		spawnSync("git", ["config", "user.name", "Daedalus Test"], { cwd: workspaceRoot, encoding: "utf8" });
		await writeFile(join(workspaceRoot, "tracked.txt"), "before\n", "utf8");
		spawnSync("git", ["add", "tracked.txt"], { cwd: workspaceRoot, encoding: "utf8" });
		spawnSync("git", ["commit", "-m", "initial"], { cwd: workspaceRoot, encoding: "utf8" });
		await writeFile(join(workspaceRoot, "tracked.txt"), "before\nafter\n", "utf8");
		spawnSync("git", ["init"], { cwd: secondaryRoot, encoding: "utf8" });
		spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: secondaryRoot, encoding: "utf8" });
		spawnSync("git", ["config", "user.name", "Daedalus Test"], { cwd: secondaryRoot, encoding: "utf8" });
		await writeFile(join(secondaryRoot, "secondary.txt"), "secondary\n", "utf8");
		spawnSync("git", ["add", "secondary.txt"], { cwd: secondaryRoot, encoding: "utf8" });
		spawnSync("git", ["commit", "-m", "initial"], { cwd: secondaryRoot, encoding: "utf8" });
		await writeFile(join(secondaryRoot, "secondary.txt"), "secondary\nchanged\n", "utf8");

		const workspace = workspaceRegistry.upsertRuntimeWorkspace({
			id: "workspace-git",
			name: "Git Workspace",
			kind: "godot",
			rootPath: workspaceRoot,
			icon: 0,
			color: 0,
			sourceFolders: [
				{ id: "primary", path: workspaceRoot, capabilities: { git: true, godot: false } },
				{ id: "secondary", path: secondaryRoot, capabilities: { git: true, godot: false } }
			],
			primarySourceFolderId: "primary"
		});

		const metadata = await sessionStore.createSession("Git overview", "workspace-git", undefined, workspace);

		const result = await overview.createSessionOverview({
			sessionId: metadata.id
		});

		assert.equal(result.envInfo?.hasGitRepository, true);
		assert.equal(result.envInfo?.additions, 1);
		assert.equal(result.envInfo?.deletions, 0);
		assert.equal(result.envInfo?.changedFiles, 1);
		assert.ok(result.envInfo?.branch !== undefined);
		assert.equal(result.envInfos.length, 2);
		assert.deepEqual(result.envInfos.map((info) => info.sourceFolderId), ["primary", "secondary"]);
		assert.deepEqual(result.envInfos.map((info) => info.title), [basename(workspaceRoot), basename(secondaryRoot)]);
		assert.equal(result.envInfos.every((info) => info.changedFiles === 1), true);
	});
});
