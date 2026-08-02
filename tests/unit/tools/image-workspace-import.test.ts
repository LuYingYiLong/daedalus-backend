import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const PNG_BYTES: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const WEBP_BYTES: Buffer = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

test("generated images can be proposed, created, and replaced inside their active workspace", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-image-import-app-"));
	const workspaceRoot: string = await mkdtemp(join(tmpdir(), "daedalus-image-import-workspace-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const workspaceRegistry = await import("../../../src/workspace/registry.js");
		const imageImport = await import("../../../src/tools/image-workspace-import.js");
		const session = await sessionStore.createSession("Image import test");
		const artifact = await attachments.saveGeneratedImageArtifact({
			sessionId: session.id,
			bytes: PNG_BYTES,
			mimeType: "image/png",
			provider: "openai",
			model: "gpt-image-1",
			prompt: "icon"
		});
		const workspaceId: string = `test-image-workspace-${Date.now()}`;
		workspaceRegistry.upsertRuntimeWorkspace({
			id: workspaceId,
			name: "Image workspace",
			kind: "godot",
			rootPath: workspaceRoot,
			icon: 0,
			color: 0,
			sourceFolders: [{ id: "primary", path: workspaceRoot, capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "primary"
		});

		const proposal = await imageImport.executeImageWorkspaceImport({
			mode: "propose",
			imageId: artifact.imageId,
			relativePath: "assets/icon.png",
			sessionId: session.id,
			workspaceId
		});
		assert.equal(proposal.imported, false);
		assert.equal(proposal.resourcePath, "res://assets/icon.png");

		const created = await imageImport.executeImageWorkspaceImport({
			mode: "create",
			imageId: artifact.imageId,
			relativePath: "assets/icon.png",
			sessionId: session.id,
			workspaceId
		});
		assert.equal(created.imported, true);
		assert.deepEqual(await readFile(join(workspaceRoot, "assets", "icon.png")), PNG_BYTES);
		await assert.rejects(
			() => imageImport.executeImageWorkspaceImport({
				mode: "create",
				imageId: artifact.imageId,
				relativePath: "assets/icon.png",
				sessionId: session.id,
				workspaceId
			}),
			/Destination already exists/u
		);

		await writeFile(join(workspaceRoot, "assets", "icon.png"), "old-image");
		await imageImport.executeImageWorkspaceImport({
			mode: "replace",
			imageId: artifact.imageId,
			relativePath: "assets/icon.png",
			sessionId: session.id,
			workspaceId
		});
		assert.deepEqual(await readFile(join(workspaceRoot, "assets", "icon.png")), PNG_BYTES);
		workspaceRegistry.deleteWorkspace(workspaceId);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

test("image workspace import enforces session, extension, traversal, and symlink boundaries", async (context): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-image-guard-app-"));
	const workspaceRoot: string = await mkdtemp(join(tmpdir(), "daedalus-image-guard-workspace-"));
	const outsideRoot: string = await mkdtemp(join(tmpdir(), "daedalus-image-guard-outside-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const sessionStore = await import("../../../src/session/session-store.js");
		const attachments = await import("../../../src/session/session-attachments.js");
		const workspaceRegistry = await import("../../../src/workspace/registry.js");
		const imageImport = await import("../../../src/tools/image-workspace-import.js");
		const owner = await sessionStore.createSession("Image owner");
		const other = await sessionStore.createSession("Other session");
		const artifact = await attachments.saveGeneratedImageArtifact({
			sessionId: owner.id,
			bytes: WEBP_BYTES,
			mimeType: "image/webp",
			provider: "openai",
			model: "gpt-image-1",
			prompt: "texture"
		});
		const workspaceId: string = `test-image-guard-${Date.now()}`;
		workspaceRegistry.upsertRuntimeWorkspace({
			id: workspaceId,
			name: "Guard workspace",
			kind: "godot",
			rootPath: workspaceRoot,
			icon: 0,
			color: 0,
			sourceFolders: [{ id: "primary", path: workspaceRoot, capabilities: { git: false, godot: false } }],
			primarySourceFolderId: "primary"
		});
		const base = {
			mode: "propose" as const,
			imageId: artifact.imageId,
			sessionId: owner.id,
			workspaceId
		};

		await assert.rejects(
			() => imageImport.executeImageWorkspaceImport({ ...base, sessionId: other.id, relativePath: "assets/texture.webp" }),
			/Attachment not found/u
		);
		await assert.rejects(
			() => imageImport.executeImageWorkspaceImport({ ...base, relativePath: "assets/texture.png" }),
			/does not match its actual image\/webp content/u
		);
		const artifactPath: string = attachments.getGeneratedImageArtifactLocalPath(artifact);
		const mismatchedJpeg: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
		await writeFile(artifactPath, mismatchedJpeg);
		await assert.rejects(
			() => imageImport.executeImageWorkspaceImport({ ...base, relativePath: "assets/texture.webp" }),
			/does not match its actual image\/jpeg content/u
		);
		await writeFile(artifactPath, WEBP_BYTES);
		await assert.rejects(
			() => imageImport.executeImageWorkspaceImport({ ...base, relativePath: "../texture.webp" }),
			/outside the active workspace/u
		);
		await assert.rejects(
			() => imageImport.executeImageWorkspaceImport({ ...base, relativePath: ".godot/texture.webp" }),
			/Image destination is protected/u
		);

		try {
			await symlink(outsideRoot, join(workspaceRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
			await assert.rejects(
				() => imageImport.executeImageWorkspaceImport({ ...base, relativePath: "linked/texture.webp" }),
				/symlink outside/u
			);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") {
				context.diagnostic("Symlink creation is unavailable on this Windows runner.");
			} else {
				throw error;
			}
		}
		workspaceRegistry.deleteWorkspace(workspaceId);
	} finally {
		const { resetSessionDatabaseForTests } = await import("../../../src/session/session-database.js");
		await resetSessionDatabaseForTests();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
		await rm(workspaceRoot, { recursive: true, force: true });
		await rm(outsideRoot, { recursive: true, force: true });
	}
});
