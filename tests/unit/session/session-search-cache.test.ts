import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("session search cache exposes committed projection prefixes", async (): Promise<void> => {
	const directory: string = await mkdtemp(join(tmpdir(), "daedalus-search-cache-"));
	const cachePath: string = join(directory, "session-search.sqlite");
	const cache = await import("../../../src/session-search/search-cache.js");
	await cache.resetSearchCacheDatabaseForTests(cachePath);
	try {
		const generation = await cache.beginSearchGeneration({
			sessionId: "session-20260802-search",
			sourceRevision: 2,
			rebuildEpoch: 0,
			forceNew: true
		});
		await cache.markGenerationBuilding(generation.generationId, 2, 2);
		await cache.appendProjectionBatch(generation.generationId, [
			{
				blockOffset: 0,
				blockKey: "request-1\nuser",
				requestId: "request-1",
				role: "user",
				document: {
					blockOffset: 0,
					requestId: "request-1",
					role: "user",
					markdownSegments: ["hello"]
				}
			},
			{
				blockOffset: 1,
				blockKey: "request-1\nassistant",
				requestId: "request-1",
				role: "assistant",
				document: null
			}
		]);
		const building = await cache.readActiveGeneration("session-20260802-search");
		assert.equal(building?.indexedThroughOffset, 2);
		assert.deepEqual(await cache.readSearchDocumentsPage(generation.generationId, 0, 2), [{
			blockOffset: 0,
			requestId: "request-1",
			role: "user",
			markdownSegments: ["hello"]
		}]);
		await cache.completeGeneration(generation.generationId, 2, 2);
		assert.equal((await cache.readActiveGeneration("session-20260802-search"))?.status, "ready");
	} finally {
		await cache.resetSearchCacheDatabaseForTests();
		await rm(directory, { recursive: true, force: true });
	}
});
