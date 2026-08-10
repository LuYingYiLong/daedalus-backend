import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { AgentContextState } from "../context/context-types.js";

export const CONTEXT_CONTROL_RESULT_MARKER = "[[daedalus_context_control]]";
export const CONTEXT_STATUS_TOOL_NAME = "daedalus_context_status";
export const CONTEXT_COMPRESS_TOOL_NAME = "daedalus_context_compress";
export const CONTEXT_SEARCH_TOOL_NAME = "daedalus_context_search";
export const CONTEXT_RETRIEVE_TOOL_NAME = "daedalus_context_retrieve";

export const CONTEXT_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
	CONTEXT_STATUS_TOOL_NAME,
	CONTEXT_COMPRESS_TOOL_NAME,
	CONTEXT_SEARCH_TOOL_NAME,
	CONTEXT_RETRIEVE_TOOL_NAME
]);

export type ContextControlContext = {
	execute(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
	getState(): AgentContextState;
	recordToolResult?(params: {
		toolCallId: string;
		toolName: string;
		content: string;
		args: Record<string, unknown>;
	}): Promise<void>;
};

const statusInputSchema = z.object({}).strict();
const compressInputSchema = z.object({
	blockIds: z.array(z.string().min(1).max(300)).min(1).max(200)
}).strict();
const searchInputSchema = z.object({
	query: z.string().trim().min(1).max(500),
	limit: z.number().int().min(1).max(50).optional()
}).strict();
const retrieveInputSchema = z.object({
	blockIds: z.array(z.string().min(1).max(300)).min(1).max(20),
	maxChars: z.number().int().min(200).max(32000).optional()
}).strict();

export function parseContextControlArgs(toolName: string, value: unknown): Record<string, unknown> {
	if (toolName === CONTEXT_STATUS_TOOL_NAME) return statusInputSchema.parse(value);
	if (toolName === CONTEXT_COMPRESS_TOOL_NAME) return compressInputSchema.parse(value);
	if (toolName === CONTEXT_SEARCH_TOOL_NAME) return searchInputSchema.parse(value);
	if (toolName === CONTEXT_RETRIEVE_TOOL_NAME) return retrieveInputSchema.parse(value);
	throw new Error(`Unknown context control tool: ${toolName}`);
}

function definition(name: string, description: string, parameters: Record<string, unknown>): ChatCompletionTool {
	return {
		type: "function",
		function: { name, description, parameters }
	};
}

export const CONTEXT_CONTROL_TOOL_DEFINITIONS: readonly ChatCompletionTool[] = [
	definition(
		CONTEXT_STATUS_TOOL_NAME,
		"Inspect the current Daedalus context budget, compression generation, protected blocks, and explicit block IDs eligible for compression. This is session-scoped and read-only.",
		{ type: "object", additionalProperties: false, properties: {} }
	),
	definition(
		CONTEXT_COMPRESS_TOOL_NAME,
		"Compress an explicit set of eligible context block IDs into a reversible structured summary. This never changes workspace files and requires no approval.",
		{
			type: "object",
			additionalProperties: false,
			required: ["blockIds"],
			properties: {
				blockIds: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", minLength: 1, maxLength: 300 } }
			}
		}
	),
	definition(
		CONTEXT_SEARCH_TOOL_NAME,
		"Search raw and compressed context blocks in the current session by topic, exact file reference, or structured failure code. This cannot search another session.",
		{
			type: "object",
			additionalProperties: false,
			required: ["query"],
			properties: {
				query: { type: "string", minLength: 1, maxLength: 500 },
				limit: { type: "integer", minimum: 1, maximum: 50 }
			}
		}
	),
	definition(
		CONTEXT_RETRIEVE_TOOL_NAME,
		"Retrieve bounded original content for explicit block IDs returned by context status or search. Retrieval is read-only and current-session only.",
		{
			type: "object",
			additionalProperties: false,
			required: ["blockIds"],
			properties: {
				blockIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 } },
				maxChars: { type: "integer", minimum: 200, maximum: 32000 }
			}
		}
	)
];

export function serializeContextControlResult(result: Record<string, unknown>): string {
	return `${CONTEXT_CONTROL_RESULT_MARKER}\n${JSON.stringify(result)}`;
}

export function isContextControlResult(content: string): boolean {
	return content.startsWith(CONTEXT_CONTROL_RESULT_MARKER);
}

export async function compressContextForProviderRetry(contextControl: ContextControlContext | undefined): Promise<boolean> {
	if (contextControl === undefined) return false;

	const status: Record<string, unknown> = await contextControl.execute(CONTEXT_STATUS_TOOL_NAME, {});
	const eligibleBlocks: unknown = status.eligibleBlocks;
	if (!Array.isArray(eligibleBlocks)) return false;
	const blockIds: string[] = eligibleBlocks.flatMap((item: unknown): string[] => {
		if (typeof item !== "object" || item === null) return [];
		const blockId: unknown = (item as Record<string, unknown>).blockId;
		return typeof blockId === "string" && blockId.length > 0 ? [blockId] : [];
	});
	if (blockIds.length === 0) return false;

	const result: Record<string, unknown> = await contextControl.execute(CONTEXT_COMPRESS_TOOL_NAME, { blockIds });
	return result.ok === true;
}
