export const MAX_STDOUT_CHARS: number = 12000;
export const MAX_STDERR_CHARS: number = 12000;
export const DEFAULT_TAIL_LINES: number = 120;
export const MAX_TAIL_LINES: number = 1000;

export function truncateOutput(text: string, maxChars: number): { text: string; truncated: boolean; omittedChars: number } {
	if (text.length <= maxChars) {
		return { text, truncated: false, omittedChars: 0 };
	}

	const omittedChars: number = text.length - maxChars;
	return {
		text: text.slice(-maxChars),
		truncated: true,
		omittedChars
	};
}

export function normalizeTailLines(lines: number | undefined): number {
	if (lines === undefined || !Number.isFinite(lines)) {
		return DEFAULT_TAIL_LINES;
	}

	return Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(lines)));
}

export function tailText(text: string, lines: number | undefined): string {
	const maxLines: number = normalizeTailLines(lines);
	const splitLines: string[] = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const tail: string[] = splitLines.length > maxLines ? splitLines.slice(splitLines.length - maxLines) : splitLines;
	return tail.join("\n");
}
