import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { withMediaRequestLimit } from "../../../src/providers/media-request-limiter.js";

test("all batches share global and per-provider media request limits; queued cancellation releases listeners", async () => {
	let total = 0, peak = 0;
	const active = new Map<string, number>();
	const peaks = new Map<string, number>();
	await Promise.all(Array.from({ length: 16 }, (_, index) => {
		const provider = index % 2 ? "a" : "b";
		return withMediaRequestLimit(provider, new AbortController().signal, async () => {
			active.set(provider, (active.get(provider) ?? 0) + 1);
			peaks.set(provider, Math.max(peaks.get(provider) ?? 0, active.get(provider)!));
			peak = Math.max(peak, ++total);
			await delay(5);
			total--; active.set(provider, active.get(provider)! - 1);
		});
	}));
	assert.equal(peak, 4);
	assert.deepEqual([...peaks.values()], [2, 2]);
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	const occupied = Array.from({ length: 2 }, () => withMediaRequestLimit("a", new AbortController().signal, () => held));
	await delay(1);
	const controller = new AbortController();
	const queued = withMediaRequestLimit("a", controller.signal, async () => { throw new Error("cancelled request must never execute"); });
	controller.abort(new Error("cancelled in queue"));
	await assert.rejects(queued, /cancelled in queue/);
	release(); await Promise.all(occupied);
	assert.equal(await withMediaRequestLimit("a", new AbortController().signal, async () => "available"), "available");
});
