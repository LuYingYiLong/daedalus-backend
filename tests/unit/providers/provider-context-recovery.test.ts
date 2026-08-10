import assert from "node:assert/strict";
import test from "node:test";
import type { ContextControlContext } from "../../../src/tools/context-control.js";
import { prepareProviderContextLengthRetry } from "../../../src/providers/provider-context-recovery.js";

function createContextControl(calls: string[]): ContextControlContext {
	return {
		getState: () => ({ schemaVersion: 1, generation: 0, activeSummaryBlockIds: [], compactedToolResultBlockIds: [] }),
		async execute(toolName): Promise<Record<string, unknown>> {
			calls.push(toolName);
			if (toolName === "daedalus_context_status") return { eligibleBlocks: [{ blockId: "message:block-a" }] };
			return { ok: true };
		}
	};
}

test("structured context length errors compress and retry the current provider step once", async (): Promise<void> => {
	const calls: string[] = [];
	let compactCount: number = 0;
	const retry: boolean = await prepareProviderContextLengthRetry({
		error: { error: { code: "context_length_exceeded" } },
		retryUsed: false,
		contextControl: createContextControl(calls),
		compactProviderToolResults: (): void => { compactCount += 1; }
	});

	assert.equal(retry, true);
	assert.deepEqual(calls, ["daedalus_context_status", "daedalus_context_compress"]);
	assert.equal(compactCount, 1);
});

test("message-only hints and already-used retries do not trigger context recovery", async (): Promise<void> => {
	let compactCount: number = 0;
	assert.equal(await prepareProviderContextLengthRetry({
		error: new Error("context_length_exceeded"),
		retryUsed: false,
		compactProviderToolResults: (): void => { compactCount += 1; }
	}), false);
	assert.equal(await prepareProviderContextLengthRetry({
		error: { code: "context_length_exceeded" },
		retryUsed: true,
		compactProviderToolResults: (): void => { compactCount += 1; }
	}), false);
	assert.equal(compactCount, 0);
});
