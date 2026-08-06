import { MAX_TOTAL_TOOL_RESULT_CHARS } from "../tools/llm-tool-budget.js";

const FINAL_ANSWER_HEADROOM_CHARS: number = 2000;
const MIN_TRUNCATED_TOOL_CHARS: number = 240;
const MAX_SINGLE_TOOL_RESULT_CHARS: number = 24_000;

export type BudgetedToolResult = {
	content: string;
	chars: number;
	truncated: boolean;
	limitReached: boolean;
	reason: string | null;
};

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
