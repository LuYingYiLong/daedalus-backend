import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { getDaedalusPath } from "../../src/app-paths.js";
import { createFlowDocument } from "../../src/session/flow-document-store.js";
import { getSessionDatabase, resetSessionDatabaseForTests } from "../../src/session/session-database.js";
import { exportFlowToSqlite } from "../../src/session/flow-export.js";
import { importFlowFromSqlite } from "../../src/session/flow-import.js";
import { appendVerifiedFile, extractFlowArchiveSlice, FLOW_ARCHIVE_HEADER_BYTES, readFlowArchiveHeader, writeFlowArchiveHeader } from "../../src/session/flow-archive-format.js";

const runLargeArchive = process.env.RUN_FLOW_ARCHIVE_1GIB === "1";

test("1 GiB archive streaming stays within a 256 MiB RSS increase", { skip: !runLargeArchive }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "daedalus-flow-archive-memory-"));
	const source = join(directory, "source.bin");
	const archivePath = join(directory, "archive.daedalus-flow");
	const itemBytes = 256 * 1024 ** 2;
	let peakRss = process.memoryUsage().rss;
	const baselineRss = peakRss;
	const sampler = setInterval((): void => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
	try {
		const sourceFile = await open(source, "wx");
		try { await sourceFile.truncate(itemBytes); } finally { await sourceFile.close(); }
		const archive = await open(archivePath, "wx");
		try {
			await writeFlowArchiveHeader(archive, 1);
			await archive.write(Buffer.from([1]));
			for (let index = 0; index < 4; index++) await appendVerifiedFile(archive, source, itemBytes);
		} finally { await archive.close(); }
		const input = await open(archivePath, "r");
		try {
			const total = (await input.stat()).size;
			assert.equal(await readFlowArchiveHeader(input, total), 1);
			assert.equal(total, FLOW_ARCHIVE_HEADER_BYTES + 1 + itemBytes * 4);
			for (let index = 0; index < 4; index++) {
				const destination = join(directory, `restored-${index}.bin`);
				await extractFlowArchiveSlice(input, FLOW_ARCHIVE_HEADER_BYTES + 1 + index * itemBytes, itemBytes, destination);
				assert.equal((await stat(destination)).size, itemBytes);
				await rm(destination);
			}
		} finally { await input.close(); }
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		const extra = peakRss - baselineRss;
		console.info(`Flow 1 GiB streaming RSS increase: ${(extra / 1024 ** 2).toFixed(1)} MiB`);
		assert.ok(extra <= 256 * 1024 ** 2, `RSS increased by ${(extra / 1024 ** 2).toFixed(1)} MiB`);
	} finally {
		clearInterval(sampler);
		const target = resolve(directory);
		if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error("Refusing to remove a path outside the temporary directory.");
		await rm(target, { recursive: true, force: true });
	}
});

test("1 GiB Flow package export and import stays within a 256 MiB RSS increase", { skip: !runLargeArchive }, async () => {
	const sourceProfile = await mkdtemp(join(tmpdir(), "daedalus-flow-package-source-"));
	const targetProfile = await mkdtemp(join(tmpdir(), "daedalus-flow-package-target-"));
	const previousProfile = process.env.USERPROFILE;
	const itemBytes = 256 * 1024 ** 2;
	let sampler: NodeJS.Timeout | undefined;
	try {
		process.env.USERPROFILE = sourceProfile;
		await resetSessionDatabaseForTests(join(sourceProfile, "sessions.sqlite"));
		const flow = await createFlowDocument({ title: "Large package", starterGraph: {} });
		const db = await getSessionDatabase();
		const artifactRoot = getDaedalusPath("flow.artifacts.root");
		await mkdir(artifactRoot, { recursive: true });
		const zeroFile = join(sourceProfile, "zero-source.bin");
		const fixture = await open(zeroFile, "wx");
		try { await fixture.truncate(itemBytes); } finally { await fixture.close(); }
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(zeroFile, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
		const sha256 = hash.digest("hex");
		for (let index = 0; index < 4; index++) {
			const artifactId = `flow-artifact-${randomUUID()}`;
			const storagePath = `${artifactId}.octetstream`;
			const file = await open(join(artifactRoot, storagePath), "wx");
			try { await file.truncate(itemBytes); } finally { await file.close(); }
			db.prepare("INSERT INTO flow_artifacts(artifact_id,flow_id,run_id,node_id,mime_type,byte_size,sha256,width,height,duration_ms,fps,preview_artifact_id,storage_path,metadata_json,created_at) VALUES(?,?,NULL,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,'{}',?)")
				.run(artifactId, flow.flow.flowId, flow.nodes[0]!.nodeId, "application/octet-stream", itemBytes, sha256, storagePath, new Date().toISOString());
		}
		let peakRss = process.memoryUsage().rss;
		const baselineRss = peakRss;
		sampler = setInterval((): void => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
		const packagePath = join(sourceProfile, "large.daedalus-flow");
		assert.equal((await exportFlowToSqlite(flow.flow.flowId, packagePath)).embeddedFileCount, 4);
		await resetSessionDatabaseForTests();
		process.env.USERPROFILE = targetProfile;
		await resetSessionDatabaseForTests(join(targetProfile, "sessions.sqlite"));
		assert.equal((await importFlowFromSqlite(packagePath)).restoredArtifactCount, 4);
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		const extra = peakRss - baselineRss;
		console.info(`Flow 1 GiB package RSS increase: ${(extra / 1024 ** 2).toFixed(1)} MiB`);
		assert.ok(extra <= 256 * 1024 ** 2, `RSS increased by ${(extra / 1024 ** 2).toFixed(1)} MiB`);
	} finally {
		if (sampler) clearInterval(sampler);
		await resetSessionDatabaseForTests();
		if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
		for (const directory of [sourceProfile, targetProfile]) {
			const target = resolve(directory);
			if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error("Refusing to remove a path outside the temporary directory.");
			await rm(target, { recursive: true, force: true });
		}
	}
});
