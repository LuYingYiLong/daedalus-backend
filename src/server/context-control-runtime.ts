import type { ClientSession } from "./client-session.js";
import type { ContextControlContext } from "../tools/context-control.js";
import {
	CONTEXT_COMPRESS_TOOL_NAME,
	CONTEXT_RETRIEVE_TOOL_NAME,
	CONTEXT_SEARCH_TOOL_NAME,
	CONTEXT_STATUS_TOOL_NAME
} from "../tools/context-control.js";
import {
	createToolContextBlock,
	countRestorableContextBlocks,
	getContextBlocksByIds,
	listContextBlocks,
	loadActiveContextLedger,
	searchContextBlocks,
	upsertContextBlock
} from "../context/context-ledger.js";
import { createContextBudgetSnapshot } from "../context/context-budget-manager.js";
import { compressSessionHistory, materializeSessionContextBlocks } from "./session-compression.js";
import { estimateMessagesTokens, estimateTextTokens } from "./token-budget.js";
import type { ContextBlock } from "../context/context-types.js";
import { createEmptyStructuredContextSummary } from "../context/context-types.js";
import type { WorkspaceFileRef } from "../workspace/source-context.js";
import { parseStructuredToolFailure, type ToolFailure } from "../tools/tool-failure.js";

function getStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === "string") : [];
}

function createFileRefs(session: ClientSession, args: Record<string, unknown>): WorkspaceFileRef[] {
	const workspaceId: string | undefined = session.activeWorkspace?.id;
	const sourceFolderId: string | undefined = typeof args.sourceFolderId === "string" ? args.sourceFolderId : undefined;
	if (workspaceId === undefined || sourceFolderId === undefined) return [];
	const paths: string[] = ["relativePath", "resourcePath", "scenePath", "scriptPath", "path"]
		.flatMap((key: string): string[] => typeof args[key] === "string" ? [args[key] as string] : []);
	return [...new Set(paths)].map((relativePath: string): WorkspaceFileRef => ({
		workspaceId,
		sourceFolderId,
		relativePath: relativePath.replaceAll("\\", "/")
	}));
}

function getStructuredResult(content: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(content);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function getResultFileRefs(content: string): WorkspaceFileRef[] {
	const result: Record<string, unknown> | undefined = getStructuredResult(content);
	if (result === undefined) return [];
	const failure: ToolFailure | undefined = parseStructuredToolFailure(result);
	const candidates: unknown[] = [
		...(Array.isArray(result.artifactFileRefs) ? result.artifactFileRefs : []),
		...(failure?.artifactFileRefs ?? [])
	];
	return candidates.filter((value: unknown): value is WorkspaceFileRef => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const record: Record<string, unknown> = value as Record<string, unknown>;
		return typeof record.workspaceId === "string"
			&& typeof record.sourceFolderId === "string"
			&& typeof record.relativePath === "string";
	});
}

function uniqueFileRefs(fileRefs: readonly WorkspaceFileRef[]): WorkspaceFileRef[] {
	const seen: Set<string> = new Set();
	return fileRefs.filter((fileRef: WorkspaceFileRef): boolean => {
		const key: string = `${fileRef.workspaceId}\u0000${fileRef.sourceFolderId}\u0000${fileRef.relativePath}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function serializeBlock(block: ContextBlock, includeContent: boolean = false): Record<string, unknown> {
	return {
		blockId: block.blockId,
		kind: block.kind,
		level: block.level,
		status: block.status,
		tokenEstimate: block.tokenEstimate,
		sourceFolderId: block.sourceFolderId,
		fileRefs: block.fileRefs,
		protectedReason: block.protectedReason,
		coveredBlockIds: block.coveredBlockIds,
		...(includeContent ? { content: block.content } : {})
	};
}

export function createSessionContextControl(params: {
	session: ClientSession;
	apiKey: string;
	requestId: string;
	abortSignal?: AbortSignal | undefined;
}): ContextControlContext {
	const { session, apiKey, requestId, abortSignal } = params;
	return {
		getState() {
			return {
				schemaVersion: 1,
				generation: session.contextLedger?.generation ?? 0,
				activeSummaryBlockIds: session.contextLedger?.activeSummaries.map((block: ContextBlock): string => block.blockId) ?? [],
				compactedToolResultBlockIds: []
			};
		},
		async execute(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
			if (session.sessionId === undefined) throw new Error("No active session");
			if (toolName === CONTEXT_STATUS_TOOL_NAME) {
				const materialized = await materializeSessionContextBlocks(session);
				const ledger = await loadActiveContextLedger(session.sessionId);
				const activeBlocks: ContextBlock[] = await listContextBlocks(session.sessionId, false);
				const inputTokens: number = await estimateMessagesTokens(session.messages);
				const budget = createContextBudgetSnapshot({
					inputTokens,
					outputReserveTokens: session.modelProfile.defaultOutputReserveTokens,
					safetyMarginTokens: session.modelProfile.safetyMarginTokens,
					contextWindowTokens: session.modelProfile.contextWindowTokens
				});
				return {
					ok: true,
					summary: "Context status inspected",
					budget,
					generation: ledger.generation,
					protectedBlocks: activeBlocks
						.filter((block: ContextBlock): boolean => block.protectedReason !== undefined)
						.map((block: ContextBlock): Record<string, unknown> => serializeBlock(block)),
					restorableBlockCount: await countRestorableContextBlocks(session.sessionId),
					activeSummaries: ledger.activeSummaries.map((block: ContextBlock): Record<string, unknown> => serializeBlock(block)),
					eligibleBlocks: materialized.rawBlocks
						.filter((block: ContextBlock): boolean => block.protectedReason === undefined)
						.map((block: ContextBlock): Record<string, unknown> => serializeBlock(block))
				};
			}
			if (toolName === CONTEXT_COMPRESS_TOOL_NAME) {
				const blockIds: string[] = [...new Set(getStringArray(args.blockIds))];
				const result = await compressSessionHistory(session, apiKey, 8, requestId, {
					abortSignal,
					compressionSource: "model",
					blockIds
				});
				return { ok: result.compressed, summary: result.compressed ? "Context compressed" : result.reason, result };
			}
			if (toolName === CONTEXT_SEARCH_TOOL_NAME) {
				const query: string = String(args.query ?? "");
				const limit: number = typeof args.limit === "number" ? args.limit : 20;
				const blocks: ContextBlock[] = await searchContextBlocks(session.sessionId, query, limit);
				return {
					ok: true,
					summary: `Found ${blocks.length} context blocks`,
					results: blocks.map((block: ContextBlock): Record<string, unknown> => ({
						...serializeBlock(block),
						excerpt: block.content.slice(0, 320)
					}))
				};
			}
			if (toolName === CONTEXT_RETRIEVE_TOOL_NAME) {
				const maxChars: number = typeof args.maxChars === "number" ? args.maxChars : 12000;
				const blocks: ContextBlock[] = await getContextBlocksByIds(session.sessionId, getStringArray(args.blockIds));
				let remaining: number = maxChars;
				const results: Record<string, unknown>[] = [];
				for (const block of blocks) {
					if (remaining <= 0) break;
					const content: string = block.content.slice(0, remaining);
					remaining -= content.length;
					results.push({ ...serializeBlock(block), content, truncated: content.length < block.content.length });
				}
				return { ok: true, summary: `Retrieved ${results.length} context blocks`, results };
			}
			throw new Error(`Unknown context control tool: ${toolName}`);
		},
		async recordToolResult(input): Promise<void> {
			if (session.sessionId === undefined) return;
			const fileRefs: WorkspaceFileRef[] = uniqueFileRefs([
				...createFileRefs(session, input.args),
				...getResultFileRefs(input.content)
			]);
			const block: ContextBlock = createToolContextBlock({
				sessionId: session.sessionId,
				requestId,
				toolCallId: input.toolCallId,
				kind: input.toolName.startsWith("mcp_terminal_") ? "terminal" : "tool",
				content: input.content,
				tokenEstimate: await estimateTextTokens(input.content),
				sourceFolderId: fileRefs[0]?.sourceFolderId,
				fileRefs,
				protectedReason: "recoverable_tool_result"
			});
			const structuredResult: Record<string, unknown> | undefined = getStructuredResult(input.content);
			const failure: ToolFailure | undefined = parseStructuredToolFailure(structuredResult);
			if (failure !== undefined) {
				block.summary = createEmptyStructuredContextSummary();
				block.summary.unresolvedFailures.push({
					code: failure.code,
					message: failure.message,
					fileRefs: failure.artifactFileRefs ?? fileRefs
				});
			}
			await upsertContextBlock(block);
		}
	};
}

export async function getSessionContextLedgerDiagnostics(sessionId: string): Promise<Record<string, unknown>> {
	const blocks: ContextBlock[] = await listContextBlocks(sessionId, true);
	return {
		blockCount: blocks.length,
		activeBlockCount: blocks.filter((block: ContextBlock): boolean => block.status === "active").length,
		compressedBlockCount: blocks.filter((block: ContextBlock): boolean => block.status === "compressed").length
	};
}
