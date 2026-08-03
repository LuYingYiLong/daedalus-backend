import { clipTerminalDisplayTail } from "./display-output.js";

export type TerminalOutputStream = "stdout" | "stderr";

export type TerminalMcpProgressMessageV1 = {
	version: 1;
	kind: "terminal_output";
	stream: TerminalOutputStream;
	sequence: number;
	text: string;
	omittedChars: number;
};

export type McpProgressNotification = {
	progress: number;
	total?: number | undefined;
	message?: string | undefined;
};

export type TerminalOutputDelta = {
	stream: TerminalOutputStream;
	sequence: number;
	text: string;
	omittedChars: number;
};

const TERMINAL_PROGRESS_VERSION: number = 1;
const TERMINAL_PROGRESS_KIND: string = "terminal_output";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseTerminalMcpProgress(progress: McpProgressNotification): TerminalOutputDelta | null {
	if (typeof progress.message !== "string" || progress.message.length === 0) {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(progress.message);
		if (!isRecord(parsed)
			|| parsed.version !== TERMINAL_PROGRESS_VERSION
			|| parsed.kind !== TERMINAL_PROGRESS_KIND
			|| (parsed.stream !== "stdout" && parsed.stream !== "stderr")
			|| typeof parsed.sequence !== "number"
			|| !Number.isSafeInteger(parsed.sequence)
			|| parsed.sequence < 1
			|| typeof parsed.text !== "string"
			|| typeof parsed.omittedChars !== "number"
			|| !Number.isSafeInteger(parsed.omittedChars)
			|| parsed.omittedChars < 0) {
			return null;
		}

		const clipped = clipTerminalDisplayTail(parsed.text, parsed.omittedChars);
		return {
			stream: parsed.stream,
			sequence: parsed.sequence,
			text: clipped.text,
			omittedChars: clipped.omittedChars
		};
	} catch {
		return null;
	}
}

export function serializeTerminalMcpProgress(progress: TerminalMcpProgressMessageV1): string {
	return JSON.stringify(progress);
}
