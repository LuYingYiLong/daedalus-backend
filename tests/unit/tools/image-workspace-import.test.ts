import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
			bytes: Buffer.from("first-image"),
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
		assert.equal((await readFile(join(workspaceRoot, "assets", "icon.png"), "utf8")), "first-image");
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
		assert.equal((await readFile(join(workspaceRoot, "assets", "icon.png"), "utf8")), "first-image");
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
			bytes: Buffer.from("image"),
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
			/Destination extension must match image\/webp/u
		);
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
