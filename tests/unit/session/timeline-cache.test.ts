import assert from "node:assert/strict";
import test from "node:test";
import { TimelineCache, estimateTimelineValueBytes } from "../../../src/session/timeline-cache.js";

test("timeline cache updates LRU order on hit and evicts the oldest entry", (): void => {
	const cache: TimelineCache<string> = new TimelineCache<string>(100, 2, 100);
	cache.set("first", "a", 40);
	cache.set("second", "b", 40);
	assert.equal(cache.get("first"), "a");
	cache.set("third", "c", 40);
	assert.equal(cache.get("first"), "a");
	assert.equal(cache.get("second"), undefined);
	assert.equal(cache.get("third"), "c");
	assert.equal(cache.stats().evictions, 1);
});

test("timeline cache evicts by total bytes and skips oversized entries", (): void => {
	const cache: TimelineCache<string> = new TimelineCache<string>(100, 8, 60);
	cache.set("first", "a", 60);
	cache.set("second", "b", 50);
	assert.equal(cache.get("first"), undefined);
	assert.equal(cache.get("second"), "b");
	assert.equal(cache.set("too-large", "c", 61), false);
	assert.equal(cache.get("too-large"), undefined);
	assert.equal(cache.stats().skipped, 1);
});

test("timeline cache invalidation removes bytes from the budget", (): void => {
	const cache: TimelineCache<string> = new TimelineCache<string>(100, 8, 100);
	cache.set("session", "value", 42);
	assert.equal(cache.stats().bytes, 42);
	assert.equal(cache.delete("session"), true);
	assert.deepEqual(cache.stats(), { entryCount: 0, bytes: 0, hits: 0, evictions: 0, skipped: 0 });
});

test("timeline value estimator handles nested and shared values without serializing a copy", (): void => {
	const shared: { content: string } = { content: "hello" };
	const value: { first: typeof shared; second: typeof shared; items: string[] } = {
		first: shared,
		second: shared,
		items: ["world"]
	};
	assert.ok(estimateTimelineValueBytes(value) > 0);
});
