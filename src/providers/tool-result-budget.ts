import { MAX_TOTAL_TOOL_RESULT_CHARS } from "../tools/llm-tool-budget.js";

const FINAL_ANSWER_HEADROOM_CHARS: number = 2000;
const MIN_TRUNCATED_TOOL_CHARS: number = 240;
const MAX_SINGLE_TOOL_RESULT_CHARS: number = 24_000;
const TOOL_CONTEXT_COMPACTION_MARKER: string = "[[daedalus_tool_context_compacted]]";
// Keep enough recent output for the next model turn, while ensuring that a
// large parallel tool batch cannot consume the entire provider context.
const TOOL_CONTEXT_RECENT_RAW_RESULT_COUNT: number = 2;
const COMPACTED_TOOL_RESULT_CHARS: number = 96;

export type BudgetedToolResult = {
	content: string;
	chars: number;
	truncated: boolean;
	limitReached: boolean;
	reason: string | null;
};

export type ToolContextCompactionResult<T> = {
	entries: T[];
	totalChars: number;
	compactedCount: number;
};

/**
 * 保留工具调用关联，同时把旧工具输出收敛为有界证据，避免运行中上下文被日志挤满
 */
export function compactToolResultEntries<T>(
	entries: readonly T[],
	getContent: (entry: T) => string,
	replaceContent: (entry: T, content: string) => T
): ToolContextCompactionResult<T> {
	const resultIndexes: number[] = [];
	for (let index: number = 0; index < entries.length; index += 1) {
		resultIndexes.push(index);
	}
	const compactableIndexes: Set<number> = new Set(
		resultIndexes.slice(0, Math.max(0, resultIndexes.length - TOOL_CONTEXT_RECENT_RAW_RESULT_COUNT))
	);
	let compactedCount: number = 0;
	const nextEntries: T[] = entries.map((entry: T, index: number): T => {
		if (!compactableIndexes.has(index)) return entry;
		const content: string = getContent(entry);
		const compacted: string = compactToolResultContent(content);
		if (compacted === content) return entry;
		compactedCount += 1;
		return replaceContent(entry, compacted);
	});

	return {
		entries: nextEntries,
		totalChars: nextEntries.reduce((total: number, entry: T): number => total + getContent(entry).length, 0),
		compactedCount
	};
}

function compactToolResultContent(content: string): string {
	if (content.length <= COMPACTED_TOOL_RESULT_CHARS || content.startsWith(TOOL_CONTEXT_COMPACTION_MARKER)) {
		return content;
	}

	const prefix: string = `${TOOL_CONTEXT_COMPACTION_MARKER}\nOlder output compacted.\n`;
	const separator: string = "\n…\n";
	const available: number = Math.max(0, COMPACTED_TOOL_RESULT_CHARS - prefix.length - separator.length);
	const headLength: number = Math.ceil(available * 0.72);
	const tailLength: number = Math.max(0, available - headLength);
	const body: string = tailLength === 0
		? content.slice(0, headLength)
		: `${content.slice(0, headLength)}${separator}${content.slice(-tailLength)}`;
	return `${prefix}${body}`;
}

export function createToolResultLimitReason(totalChars: number, maxChars: number = MAX_TOTAL_TOOL_RESULT_CHARS): string {
	return `工具结果总量达到 ${totalChars} 字符，上限为 ${maxChars} 字符`;
}

export function createToolResultLimitFallback(reason: string): string {
	return [
		"当前请求的读取范围已达到安全上限，已停止继续调用工具。",
		"",
		`收束原因：${reason}。`,
		"",
		"已有结果可能不完整；请缩小检查范围，优先指定版本、目录或文件，避免继续读取整个项目。"
	].join("\n");
}

export function fitToolResultContent(
	content: string,
	currentTotalChars: number,
	maxTotalChars: number = MAX_TOTAL_TOOL_RESULT_CHARS
): BudgetedToolResult {
	const targetLimit: number = Math.max(MIN_TRUNCATED_TOOL_CHARS, maxTotalChars - FINAL_ANSWER_HEADROOM_CHARS);
	const remainingBeforeFinalize: number = targetLimit - currentTotalChars;
	if (remainingBeforeFinalize <= MIN_TRUNCATED_TOOL_CHARS) {
		const placeholder: string = "[工具结果未展开：累计工具结果预算已接近上限，请基于已有结果总结。]";
		const chars: number = placeholder.length;
		const totalChars: number = currentTotalChars + chars;
		return {
			content: placeholder,
			chars,
			truncated: true,
			limitReached: true,
			reason: createToolResultLimitReason(totalChars, maxTotalChars)
		};
	}

	// One unbounded list or log must not consume the whole conversation budget.
	// Reserve at least three comparable reads after the first result for correction,
	// verification, and the final structured answer.
	const perResultLimit: number = Math.max(
		MIN_TRUNCATED_TOOL_CHARS,
		Math.min(MAX_SINGLE_TOOL_RESULT_CHARS, Math.floor(maxTotalChars / 4))
	);
	const contentLimit: number = Math.min(remainingBeforeFinalize, perResultLimit);

	if (content.length <= contentLimit) {
		const totalChars: number = currentTotalChars + content.length;
		return {
			content,
			chars: content.length,
			truncated: false,
			limitReached: totalChars >= targetLimit,
			reason: totalChars >= targetLimit ? createToolResultLimitReason(totalChars, maxTotalChars) : null
		};
	}

	const suffix: string = `\n\n[工具结果已按累计预算截断，原始长度 ${content.length} 字符。请缩小后续读取范围。]`;
	const availableContentChars: number = Math.max(MIN_TRUNCATED_TOOL_CHARS, contentLimit - suffix.length);
	const clippedContent: string = `${content.slice(0, availableContentChars)}${suffix}`;
	const totalChars: number = currentTotalChars + clippedContent.length;
	const limitReached: boolean = totalChars >= targetLimit;
	return {
		content: clippedContent,
		chars: clippedContent.length,
		truncated: true,
		limitReached,
		reason: limitReached ? createToolResultLimitReason(totalChars, maxTotalChars) : null
	};
}
