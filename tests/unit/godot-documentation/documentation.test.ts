import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	buildGodotDocumentationIndex,
	parseRstDocument
} from "../../../src/godot-documentation/indexer.js";
import {
	extractGodotDocumentationArchive,
	inspectGodotDocumentationArchive
} from "../../../src/godot-documentation/manager.js";
import { selectGodotDocumentation } from "../../../src/godot-documentation/search.js";
import {
	getGodotDocumentationIndexPath,
	parseStableDocumentationBranch
} from "../../../src/godot-documentation/store.js";
import type { GodotDocumentationRecord } from "../../../src/godot-documentation/types.js";

const COMMIT_SHA: string = "0123456789abcdef0123456789abcdef01234567";

function createCentralDirectoryOnlyZip(entryName: string, unixMode: number = 0o100644): Buffer {
	const name: Buffer = Buffer.from(entryName, "utf8");
	const central: Buffer = Buffer.alloc(46 + name.length);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(0x031e, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(1, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE((unixMode * 65_536) >>> 0, 38);
	name.copy(central, 46);
	const end: Buffer = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(0, 16);
	return Buffer.concat([central, end]);
}

function calculateCrc32(content: Buffer): number {
	let crc: number = 0xffffffff;
	for (const byte of content) {
		crc ^= byte;
		for (let bit: number = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entryName: string, content: string): Buffer {
	const name: Buffer = Buffer.from(entryName, "utf8");
	const body: Buffer = Buffer.from(content, "utf8");
	const crc32: number = calculateCrc32(body);
	const local: Buffer = Buffer.alloc(30 + name.length + body.length);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(crc32, 14);
	local.writeUInt32LE(body.length, 18);
	local.writeUInt32LE(body.length, 22);
	local.writeUInt16LE(name.length, 26);
	name.copy(local, 30);
	body.copy(local, 30 + name.length);

	const central: Buffer = Buffer.alloc(46 + name.length);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(0x031e, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(crc32, 16);
	central.writeUInt32LE(body.length, 20);
	central.writeUInt32LE(body.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE((0o100644 * 65_536) >>> 0, 38);
	name.copy(central, 46);

	const end: Buffer = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(local.length, 16);
	return Buffer.concat([local, central, end]);
}

function createRecord(branch: string): GodotDocumentationRecord {
	return {
		id: `docs-${branch}`,
		branch,
		commitSha: COMMIT_SHA,
		installedAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:00.000Z",
		documentCount: 1,
		chunkCount: 1,
		classCount: 1,
		sizeBytes: 1
	};
}

test("RST parser indexes class members with their declared Godot symbol", (): void => {
	const chunks = parseRstDocument("classes/class_node_2d.rst", `
.. _class_Node2D:

Node2D
======

Base class text.

.. _class_Node2D_method_look_at:

look_at
-------

Rotates the node so it points toward a position.
`);

	assert.equal(chunks[0]?.symbol, "Node2D");
	const method = chunks.find((chunk): boolean => chunk.symbol === "Node2D.look_at");
	assert.notEqual(method, undefined);
	assert.match(method?.body ?? "", /Rotates the node/u);
});

test("RST parser keeps manual headings and code blocks searchable", (): void => {
	const chunks = parseRstDocument("tutorials/scripting/example.rst", `
.. _scripting-example:

Scripting example
=================

Use the API:

.. code-block:: gdscript

    var node := Node2D.new()

Next steps
----------

Continue with the created node.
`);

	assert.equal(chunks.length, 2);
	assert.equal(chunks[0]?.category, "manual");
	assert.equal(chunks[0]?.title, "Scripting example");
	assert.equal(chunks[0]?.anchor, "scripting-example");
	assert.match(chunks[0]?.body ?? "", /Node2D\.new/u);
	assert.equal(chunks[1]?.title, "Next steps");
});

test("documentation index builds a unicode61 FTS5 database from RST fixtures", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-doc-index-"));
	const sourceRoot: string = join(root, "source", "godot-docs-fixture");
	const indexPath: string = join(root, "generation", "index.sqlite");
	try {
		await mkdir(join(sourceRoot, "classes"), { recursive: true });
		await mkdir(join(sourceRoot, "tutorials"), { recursive: true });
		await writeFile(join(sourceRoot, "conf.py"), "# fixture\n");
		await writeFile(join(sourceRoot, "classes", "class_node.rst"), `
.. _class_Node:

Node
====

Base object for scene tree nodes.
`);
		await writeFile(join(sourceRoot, "tutorials", "scene_tree.rst"), `
Scene tree
==========

Nodes are organized into a scene tree.
`);

		const summary = await buildGodotDocumentationIndex({
			extractedRoot: join(root, "source"),
			indexPath,
			branch: "4.7",
			commitSha: COMMIT_SHA
		});
		assert.equal(summary.documentCount, 2);
		assert.equal(summary.classCount, 1);
		assert.ok(summary.chunkCount >= 2);
		const directRootSummary = await buildGodotDocumentationIndex({
			extractedRoot: sourceRoot,
			indexPath: join(root, "direct-generation", "index.sqlite"),
			branch: "4.7",
			commitSha: COMMIT_SHA
		});
		assert.equal(directRootSummary.documentCount, 2);

		const db = new DatabaseSync(indexPath, { readOnly: true });
		try {
			const row = db.prepare(`
				SELECT c.title
				FROM chunks_fts
				JOIN chunks AS c ON c.id = chunks_fts.rowid
				WHERE chunks_fts MATCH ?
			`).get("\"organized\"") as { title?: unknown } | undefined;
			assert.equal(row?.title, "Scene tree");
			const metadata = db.prepare("SELECT value FROM metadata WHERE key = ?").get("manualLicense") as
				| { value?: unknown }
				| undefined;
			assert.equal(metadata?.value, "CC BY 3.0");
		} finally {
			db.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("documentation ZIP inspection rejects traversal and symbolic links", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-doc-zip-"));
	try {
		const safePath: string = join(root, "safe.zip");
		const traversalPath: string = join(root, "traversal.zip");
		const symlinkPath: string = join(root, "symlink.zip");
		await writeFile(safePath, createCentralDirectoryOnlyZip("godot-docs/classes/class_node.rst"));
		await writeFile(traversalPath, createCentralDirectoryOnlyZip("../escape.rst"));
		await writeFile(symlinkPath, createCentralDirectoryOnlyZip("godot-docs/link", 0o120777));

		await assert.doesNotReject(inspectGodotDocumentationArchive(safePath));
		await assert.rejects(inspectGodotDocumentationArchive(traversalPath), /Unsafe path/u);
		await assert.rejects(inspectGodotDocumentationArchive(symlinkPath), /symbolic link/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("documentation ZIP extraction supports Windows staging paths with spaces", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus doc extract "));
	const zipPath: string = join(root, "archive with spaces.zip");
	const destination: string = join(root, "destination with spaces");
	try {
		await writeFile(zipPath, createStoredZip("godot-docs-fixture/classes/class_node.rst", "Node\n====\n"));
		await extractGodotDocumentationArchive(zipPath, destination, new AbortController().signal);
		assert.equal(
			await readFile(join(destination, "godot-docs-fixture", "classes", "class_node.rst"), "utf8"),
			"Node\n====\n"
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("documentation selection follows project version fallback order", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-doc-selection-"));
	process.env.USERPROFILE = root;
	const records: GodotDocumentationRecord[] = ["3.6", "4.2", "4.4", "master"].map(createRecord);
	try {
		for (const record of records) {
			const indexPath: string = getGodotDocumentationIndexPath(record);
			await mkdir(dirname(indexPath), { recursive: true });
			await writeFile(indexPath, "");
		}
		assert.equal(selectGodotDocumentation(records, undefined, "4.4.stable")?.record.branch, "4.4");
		assert.equal(selectGodotDocumentation(records, undefined, "4.3")?.record.branch, "4.2");
		assert.equal(selectGodotDocumentation(records, undefined, "4.1")?.record.branch, "4.2");
		assert.equal(selectGodotDocumentation(records, undefined, "5.0")?.record.branch, "4.4");
		assert.equal(selectGodotDocumentation(records, "3.6", "4.4")?.record.branch, "3.6");
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("stable documentation branch parser accepts only major.minor branches", (): void => {
	assert.deepEqual(parseStableDocumentationBranch("4.7"), { major: 4, minor: 7 });
	assert.equal(parseStableDocumentationBranch("master"), null);
	assert.equal(parseStableDocumentationBranch("4.7-stable"), null);
});
