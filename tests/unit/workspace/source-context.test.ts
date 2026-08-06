import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	resolveWorkspaceReadSource,
	resolveWorkspaceSources,
	WorkspaceSourceResolutionError
} from "../../../src/workspace/source-context.js";
import { WorkspaceSourceIndex } from "../../../src/workspace/source-index.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

function createWorkspace(first: string, second: string): WorkspaceConfig {
	return {
		id: "multi-source-test",
		name: "multi-source-test",
		kind: "godot",
		rootPath: first,
		icon: 0,
		color: 0,
		sourceFolders: [
			{ id: "frontend", path: first, capabilities: { git: false, godot: false } },
			{ id: "backend", path: second, capabilities: { git: false, godot: false } }
		],
		primarySourceFolderId: "frontend"
	};
}

test("multi-source resolver defaults list/search to all but requires explicit mutation source", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-source-context-"));
	const first: string = join(root, "frontend");
	const second: string = join(root, "backend");
	await mkdir(first, { recursive: true });
	await mkdir(second, { recursive: true });
	const workspace: WorkspaceConfig = createWorkspace(first, second);
	try {
		assert.equal(resolveWorkspaceSources(workspace, { operation: "list" }).kind, "all");
		assert.equal(resolveWorkspaceSources(workspace, { operation: "search" }).kind, "all");
		assert.equal(resolveWorkspaceSources(workspace, { sourceFolderId: "backend", operation: "write" }).kind, "source");
		assert.throws(
			() => resolveWorkspaceSources(workspace, { operation: "write" }),
			(error: unknown) => error instanceof WorkspaceSourceResolutionError && error.code === "source_required"
		);
		assert.throws(
			() => resolveWorkspaceSources(workspace, { scope: "all", operation: "read" }),
			(error: unknown) => error instanceof WorkspaceSourceResolutionError && error.code === "invalid_scope"
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("multi-source file reads auto-select unique paths and reject ambiguous paths", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-source-read-"));
	const first: string = join(root, "frontend");
	const second: string = join(root, "backend");
	await mkdir(join(first, "src"), { recursive: true });
	await mkdir(join(second, "src"), { recursive: true });
	await writeFile(join(first, "src", "only.ts"), "export const only = true;\n", "utf8");
	await writeFile(join(first, "src", "shared.ts"), "frontend\n", "utf8");
	await writeFile(join(second, "src", "shared.ts"), "backend\n", "utf8");
	const workspace: WorkspaceConfig = createWorkspace(first, second);
	try {
		const unique = resolveWorkspaceReadSource(workspace, "src/only.ts", {});
		assert.equal(unique.source.id, "frontend");
		assert.equal(unique.autoSelected, true);
		assert.throws(
			() => resolveWorkspaceReadSource(workspace, "src/shared.ts", {}),
			(error: unknown) => error instanceof WorkspaceSourceResolutionError && error.code === "ambiguous_source"
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("source index returns stable source-scoped file and search references", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-source-index-"));
	const first: string = join(root, "frontend");
	await mkdir(join(first, "src"), { recursive: true });
	await writeFile(join(first, "src", "router.ts"), "const route = true;\n", "utf8");
	const workspace: WorkspaceConfig = createWorkspace(first, join(root, "backend"));
	const index = new WorkspaceSourceIndex();
	try {
		const listed = await index.listSourceFiles(workspace, workspace.sourceFolders[0]!, { extensions: [".ts"] });
		assert.deepEqual(listed.files.map((file) => file.file), ["src/router.ts"]);
		assert.equal(listed.files[0]?.fileRef.sourceFolderId, "frontend");
		assert.equal(listed.files[0]?.fileRef.relativePath, "src/router.ts");
		const matches = await index.searchSource(workspace, workspace.sourceFolders[0]!, { query: "route", extensions: ["ts"] });
		assert.equal(matches[0]?.sourceFolderId, "frontend");
		assert.equal(matches[0]?.line, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
