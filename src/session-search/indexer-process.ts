import { createInterface } from "node:readline";
import {
	buildSessionSearchProjectionSnapshot,
	readSessionSearchSourceState,
	type SessionSearchProjectionBlock,
	type SessionSearchProjectionSnapshot
} from "../session/session-store.js";
import {
	appendProjectionBatch,
	beginSearchGeneration,
	completeGeneration,
	markGenerationBuilding,
	readActiveGeneration,
	readGenerationBlockKeys,
	truncateGenerationFrom
} from "./search-cache.js";

type IndexerCommand =
	| { id: string; type: "build"; sessionId: string; generationId: string; reason: string }
	| { id: string; type: "cancel"; sessionId: string }
	| { id: string; type: "shutdown" };

type IndexerResponse = {
	id: string;
	type: "started" | "progress" | "completed" | "cancelled" | "error";
	sessionId?: string | undefined;
	generationId?: string | undefined;
	indexedThroughOffset?: number | undefined;
	blockCount?: number | undefined;
	sourceRevision?: number | undefined;
	message?: string | undefined;
};

const MAX_BATCH_BLOCKS: number = 64;
const MAX_BATCH_MARKDOWN_BYTES: number = 2 * 1024 * 1024;

function writeResponse(response: IndexerResponse): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

function batchProjectionBlocks(blocks: readonly SessionSearchProjectionBlock[], startOffset: number): SessionSearchProjectionBlock[][] {
	const batches: SessionSearchProjectionBlock[][] = [];
	let current: SessionSearchProjectionBlock[] = [];
	let bytes: number = 0;
	for (const block of blocks.slice(startOffset)) {
		const blockBytes: number = block.document === null
			? 0
			: Buffer.byteLength(block.document.markdownSegments.join("\n"), "utf8");
		if (current.length > 0 && (current.length >= MAX_BATCH_BLOCKS || bytes + blockBytes > MAX_BATCH_MARKDOWN_BYTES)) {
			batches.push(current);
			current = [];
			bytes = 0;
		}
		current.push(block);
		bytes += blockBytes;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
	const max: number = Math.min(left.length, right.length);
	let index: number = 0;
	while (index < max && left[index] === right[index]) index += 1;
	return index;
}

export async function runSessionSearchIndexerProcess(): Promise<void> {
	const cancelledSessions: Set<string> = new Set();
	let queue: Promise<void> = Promise.resolve();
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

	const runBuild = async (command: Extract<IndexerCommand, { type: "build" }>): Promise<void> => {
		cancelledSessions.delete(command.sessionId);
		writeResponse({
			id: command.id,
			type: "started",
			sessionId: command.sessionId,
			generationId: command.generationId
		});
		try {
			const snapshot: SessionSearchProjectionSnapshot = await buildSessionSearchProjectionSnapshot(command.sessionId);
			let generation = await readActiveGeneration(command.sessionId);
			if (generation === null || generation.rebuildEpoch !== snapshot.source.rebuildEpoch) {
				generation = await beginSearchGeneration({
					sessionId: command.sessionId,
					sourceRevision: snapshot.source.revision,
					rebuildEpoch: snapshot.source.rebuildEpoch,
					forceNew: true
				});
			}
			const existingKeys: string[] = await readGenerationBlockKeys(generation.generationId);
			const nextKeys: string[] = snapshot.blocks.map((block): string => block.blockKey);
			const commonPrefix: number = commonPrefixLength(existingKeys, nextKeys);
			if (commonPrefix < existingKeys.length && generation.generationId === command.generationId) {
				generation = await beginSearchGeneration({
					sessionId: command.sessionId,
					sourceRevision: snapshot.source.revision,
					rebuildEpoch: snapshot.source.rebuildEpoch,
					forceNew: true
				});
			}
			const refreshFrom: number = generation.indexedThroughOffset === 0
				? 0
				: Math.max(0, Math.min(commonPrefix, generation.indexedThroughOffset) - 2);
			await markGenerationBuilding(generation.generationId, snapshot.source.revision, snapshot.blocks.length);
			await truncateGenerationFrom(generation.generationId, refreshFrom);
			for (const batch of batchProjectionBlocks(snapshot.blocks, refreshFrom)) {
				if (cancelledSessions.has(command.sessionId)) {
					writeResponse({ id: command.id, type: "cancelled", sessionId: command.sessionId, generationId: generation.generationId });
					return;
				}
				const startedAt: number = performance.now();
				await appendProjectionBatch(generation.generationId, batch);
				writeResponse({
					id: command.id,
					type: "progress",
					sessionId: command.sessionId,
					generationId: generation.generationId,
					indexedThroughOffset: batch[batch.length - 1]!.blockOffset + 1,
					blockCount: snapshot.blocks.length,
					message: performance.now() - startedAt > 100 ? "slow_batch" : undefined
				});
				await new Promise<void>((resolve): void => { setImmediate(resolve); });
			}
			await completeGeneration(generation.generationId, snapshot.source.revision, snapshot.blocks.length);
			const currentSource = await readSessionSearchSourceState(command.sessionId);
			writeResponse({
				id: command.id,
				type: "completed",
				sessionId: command.sessionId,
				generationId: generation.generationId,
				indexedThroughOffset: snapshot.blocks.length,
				blockCount: snapshot.blocks.length,
				sourceRevision: snapshot.source.revision,
				message: currentSource.revision === snapshot.source.revision ? undefined : "source_advanced"
			});
		} catch (error: unknown) {
			writeResponse({
				id: command.id,
				type: "error",
				sessionId: command.sessionId,
				generationId: command.generationId,
				message: error instanceof Error ? error.message : String(error)
			});
		}
	};

	for await (const line of input) {
		let command: IndexerCommand;
		try {
			command = JSON.parse(line) as IndexerCommand;
		} catch {
			continue;
		}
		if (command.type === "shutdown") {
			await queue;
			break;
		}
		if (command.type === "cancel") {
			cancelledSessions.add(command.sessionId);
			continue;
		}
		queue = queue.then((): Promise<void> => runBuild(command));
	}
	input.close();
	process.stdin.pause();
}
