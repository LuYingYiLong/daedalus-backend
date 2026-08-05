import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceFileService } from "../../../src/workspace/files.js";

test("workspace file service creates, reads, searches and edits text files inside root", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-workspace-files-"));
	try {
		const service = createWorkspaceFileService({ rootPath: root });

		await service.createTextFile("src/notes.txt", "one\ntwo\nthree\n");

		assert.equal(await service.readTextFile("src/notes.txt"), "one\ntwo\nthree\n");
		assert.equal((await service.searchText({ query: "two" }))[0]?.line, 2);

		await service.replaceLineInFile("src/notes.txt", 2, "two", "updated");

		assert.equal(await readFile(join(root, "src", "notes.txt"), "utf8"), "one\nupdated\nthree\n");

		await service.replaceTextInFile("src/notes.txt", "three", "done");
		assert.equal(await service.readTextFile("src/notes.txt"), "one\nupdated\ndone\n");
		assert.equal(await service.readTextFile("src/notes.txt", { startLine: 2, endLine: 3 }), "updated\ndone\n");
		assert.equal(await service.readTextFile("src/notes.txt", { startLine: 3 }), "done\n");
		assert.equal(await service.readTextFile("src/notes.txt", { startLine: 99, endLine: 100 }), "");
		await assert.rejects(
			() => service.readTextFile("src/notes.txt", { startLine: 3, endLine: 2 }),
			/endLine must be greater than or equal to startLine/u
		);

		await service.deleteFile("src/notes.txt");
		assert.equal((await service.listFiles()).length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("workspace file service rejects path escape, protected writes and line drift", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-workspace-files-guard-"));
	try {
		const service = createWorkspaceFileService({ rootPath: root });
		await mkdir(join(root, ".git"), { recursive: true });
		await service.createTextFile("src/guard.txt", "stable\n");

		await assert.rejects(
			() => service.readTextFile("../outside.txt"),
			/Path traversal denied/u
		);
		await assert.rejects(
			() => service.createTextFile(".git/config", "unsafe"),
			/Writing to \.git\/ is not allowed/u
		);
		await assert.rejects(
			() => service.replaceLineInFile("src/guard.txt", 1, "drifted", "unsafe"),
			/expectedText does not match/u
		);
		assert.equal(await readFile(join(root, "src", "guard.txt"), "utf8"), "stable\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("workspace file listing treats an uncreated child directory as empty", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-workspace-files-missing-dir-"));
	try {
		const service = createWorkspaceFileService({ rootPath: root });

		assert.deepEqual(await service.listFilesDetailed({ subdir: "assets/generated" }), {
			files: [],
			directoryExists: false
		});
		await service.createTextFile("assets/existing.txt", "ready\n");
		assert.deepEqual(await service.listFilesDetailed({ subdir: "assets" }), {
			files: ["assets/existing.txt"],
			directoryExists: true
		});
		await assert.rejects(
			() => service.listFilesDetailed({ subdir: "assets/existing.txt" }),
			/Not a directory/u
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
