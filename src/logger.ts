import { mkdirSync, createWriteStream, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { basename, join } from "node:path";
import { inspect } from "node:util";
import { getLogsDir } from "./app-paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

type LogRecord = {
	ts: string;
	level: LogLevel;
	area: string;
	event: string;
	message?: string | undefined;
	data?: unknown;
	error?: unknown;
};

type LogFile = {
	path: string;
	sizeBytes: number;
	modifiedAtMs: number;
};

const LEVEL_PRIORITIES: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

const MAX_STRING_LENGTH: number = 2000;
const MAX_ARRAY_LENGTH: number = 50;
const MAX_OBJECT_KEYS: number = 80;
const DEFAULT_MAX_LOG_FILE_BYTES: number = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_LOG_BYTES: number = 250 * 1024 * 1024;
const MIN_LOG_LIMIT_BYTES: number = 1024;
const REDACTED: string = "[redacted]";

let stream: WriteStream | null | undefined;
let streamPath: string | null | undefined;
let streamDateStamp: string | null | undefined;
let streamSizeBytes: number = 0;
const closingStreams: Set<Promise<void>> = new Set<Promise<void>>();
let processHandlersInstalled: boolean = false;

function parseLevel(value: string | undefined): LogLevel {
	if (value === "debug" || value === "info" || value === "warn" || value === "error") {
		return value;
	}

	return "info";
}

function shouldWriteLevel(level: LogLevel): boolean {
	const configuredLevel: LogLevel = parseLevel(process.env.DAEDALUS_LOG_LEVEL);
	return LEVEL_PRIORITIES[level] >= LEVEL_PRIORITIES[configuredLevel];
}

function shouldLogToConsole(): boolean {
	if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.DAEDALUS_LOG_CONSOLE === undefined) {
		return false;
	}

	return process.env.DAEDALUS_LOG_CONSOLE !== "0";
}

function getLogDateStamp(date: Date = new Date()): string {
	return date.toISOString().slice(0, 10);
}

function readLogLimit(envName: "DAEDALUS_LOG_MAX_FILE_BYTES" | "DAEDALUS_LOG_MAX_TOTAL_BYTES", fallback: number): number {
	const configured: string | undefined = process.env[envName];
	if (configured === undefined || configured.trim().length === 0) {
		return fallback;
	}

	const parsed: number = Number.parseInt(configured, 10);
	return Number.isSafeInteger(parsed) && parsed >= MIN_LOG_LIMIT_BYTES ? parsed : fallback;
}

function getMaxLogFileBytes(): number {
	return readLogLimit("DAEDALUS_LOG_MAX_FILE_BYTES", DEFAULT_MAX_LOG_FILE_BYTES);
}

function getMaxTotalLogBytes(): number {
	return Math.max(getMaxLogFileBytes(), readLogLimit("DAEDALUS_LOG_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_LOG_BYTES));
}

function resolveLogDir(): string | null {
	const override: string | undefined = process.env.DAEDALUS_LOG_DIR;
	if (override !== undefined && override.trim().length > 0) {
		return override;
	}

	try {
		return getLogsDir();
	} catch {
		return null;
	}
}

function getLogFileName(dateStamp: string, index: number): string {
	return index === 0 ? `backend-${dateStamp}.log` : `backend-${dateStamp}-${index}.log`;
}

function readLogFileIndex(fileName: string, dateStamp: string): number | null {
	const match: RegExpMatchArray | null = fileName.match(new RegExp(`^backend-${dateStamp}(?:-(\\d+))?\\.log$`));
	if (match === null) {
		return null;
	}
	return match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

function listBackendLogs(logDir: string): LogFile[] {
	return readdirSync(logDir, { withFileTypes: true })
		.filter((entry): boolean => entry.isFile() && /^backend-.+\.log$/.test(entry.name))
		.map((entry): LogFile => {
			const path: string = join(logDir, entry.name);
			const stat = statSync(path);
			return { path, sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs };
		})
		.sort((left, right): number => left.modifiedAtMs - right.modifiedAtMs);
}

function resolveWritableLogFile(
	logDir: string,
	dateStamp: string,
	nextRecordBytes: number,
	excludedPath: string | null | undefined
): { path: string; sizeBytes: number } {
	const candidates: Array<{ index: number; path: string; sizeBytes: number }> = readdirSync(logDir, { withFileTypes: true })
		.filter((entry): boolean => entry.isFile())
		.map((entry): { index: number; path: string; sizeBytes: number } | null => {
			const index: number | null = readLogFileIndex(entry.name, dateStamp);
			if (index === null) {
				return null;
			}
			const path: string = join(logDir, entry.name);
			return { index, path, sizeBytes: statSync(path).size };
		})
		.filter((entry): entry is { index: number; path: string; sizeBytes: number } => entry !== null)
		.sort((left, right): number => right.index - left.index);

	const latest = candidates[0];
	if (latest !== undefined && latest.path !== excludedPath && latest.sizeBytes + nextRecordBytes <= getMaxLogFileBytes()) {
		return { path: latest.path, sizeBytes: latest.sizeBytes };
	}

	const excludedIndex: number | null = excludedPath === null || excludedPath === undefined
		? null
		: readLogFileIndex(basename(excludedPath), dateStamp);
	const nextIndex: number = Math.max(latest?.index ?? -1, excludedIndex ?? -1) + 1;
	return {
		path: join(logDir, getLogFileName(dateStamp, nextIndex)),
		sizeBytes: 0
	};
}

function endStream(target: WriteStream): Promise<void> {
	const closing: Promise<void> = new Promise<void>((resolve): void => {
		target.end(resolve);
	});
	closingStreams.add(closing);
	void closing.finally((): void => {
		closingStreams.delete(closing);
	});
	return closing;
}

function pruneLogs(logDir: string, activePath: string): void {
	const entries: LogFile[] = listBackendLogs(logDir);
	let totalBytes: number = entries.reduce((total: number, entry: LogFile): number => total + entry.sizeBytes, 0);
	for (const entry of entries) {
		if (totalBytes <= getMaxTotalLogBytes()) {
			break;
		}
		if (entry.path === activePath) {
			continue;
		}
		try {
			unlinkSync(entry.path);
			totalBytes -= entry.sizeBytes;
		} catch (error: unknown) {
			console.warn("[logger] failed to prune backend log:", error instanceof Error ? error.message : String(error));
		}
	}
}

function createLogStream(nextRecordBytes: number = 0): WriteStream | null {
	const logDir: string | null = resolveLogDir();
	if (logDir === null) {
		stream = null;
		streamPath = null;
		streamDateStamp = null;
		streamSizeBytes = 0;
		return null;
	}

	const dateStamp: string = getLogDateStamp();
	if (
		stream !== undefined
		&& stream !== null
		&& streamDateStamp === dateStamp
		&& streamSizeBytes + nextRecordBytes <= getMaxLogFileBytes()
	) {
		return stream;
	}

	const previousPath: string | null | undefined = streamPath;
	if (stream !== undefined && stream !== null) {
		void endStream(stream);
	}

	mkdirSync(logDir, { recursive: true });
	const target = resolveWritableLogFile(logDir, dateStamp, nextRecordBytes, previousPath);
	const createdStream: WriteStream = createWriteStream(target.path, { flags: "a", encoding: "utf8" });
	stream = createdStream;
	streamPath = target.path;
	streamDateStamp = dateStamp;
	streamSizeBytes = target.sizeBytes;
	createdStream.on("error", (error: Error): void => {
		if (stream === createdStream) {
			stream = null;
			streamPath = null;
			streamDateStamp = null;
			streamSizeBytes = 0;
		}
		console.error("[logger] failed to write backend log:", error.message);
	});
	pruneLogs(logDir, target.path);
	return createdStream;
}

function isSensitiveKey(key: string): boolean {
	return /api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|bearer|cookie|set-cookie/i.test(key);
}

function clipString(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) {
		return value;
	}

	return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

export function redactForLog(value: unknown, keyHint: string = "", depth: number = 0): unknown {
	if (keyHint.length > 0 && isSensitiveKey(keyHint)) {
		return REDACTED;
	}
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === "string") {
		if (/^Bearer\s+/i.test(value)) {
			return REDACTED;
		}
		return clipString(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: clipString(value.message),
			stack: value.stack === undefined ? undefined : clipString(value.stack)
		};
	}
	if (depth >= 6) {
		return "[depth-limit]";
	}
	if (Array.isArray(value)) {
		const items: unknown[] = value
			.slice(0, MAX_ARRAY_LENGTH)
			.map((item: unknown): unknown => redactForLog(item, keyHint, depth + 1));
		if (value.length > MAX_ARRAY_LENGTH) {
			items.push(`[truncated ${value.length - MAX_ARRAY_LENGTH} items]`);
		}
		return items;
	}
	if (typeof value === "object") {
		const source: Record<string, unknown> = value as Record<string, unknown>;
		const entries: Array<[string, unknown]> = Object.entries(source).slice(0, MAX_OBJECT_KEYS);
		const result: Record<string, unknown> = {};
		for (const [key, item] of entries) {
			result[key] = redactForLog(item, key, depth + 1);
		}
		if (Object.keys(source).length > MAX_OBJECT_KEYS) {
			result.__truncatedKeys = Object.keys(source).length - MAX_OBJECT_KEYS;
		}
		return result;
	}

	return inspect(value, { depth: 2 });
}

function writeRecord(record: LogRecord): void {
	const redactedRecord: LogRecord = {
		...record,
		data: record.data === undefined ? undefined : redactForLog(record.data),
		error: record.error === undefined ? undefined : redactForLog(record.error)
	};
	const line: string = `${JSON.stringify(redactedRecord)}\n`;
	const lineBytes: number = Buffer.byteLength(line, "utf8");
	const logStream: WriteStream | null = createLogStream(lineBytes);
	if (logStream !== null) {
		logStream.write(line);
		streamSizeBytes += lineBytes;
		const activePath: string | null | undefined = streamPath;
		if (activePath !== null && activePath !== undefined && streamSizeBytes >= getMaxLogFileBytes()) {
			const logDir: string | null = resolveLogDir();
			if (logDir !== null) {
				pruneLogs(logDir, activePath);
			}
		}
	}
	if (!shouldLogToConsole()) {
		return;
	}

	const consoleLine: string = `[${redactedRecord.ts}] ${redactedRecord.level.toUpperCase()} ${redactedRecord.area}.${redactedRecord.event}${redactedRecord.message === undefined ? "" : ` ${redactedRecord.message}`}`;
	if (record.level === "error") {
		console.error(consoleLine);
	} else if (record.level === "warn") {
		console.warn(consoleLine);
	} else {
		console.log(consoleLine);
	}
}

export function log(level: LogLevel, area: string, event: string, data?: LogContext, message?: string): void {
	if (!shouldWriteLevel(level)) {
		return;
	}

	writeRecord({
		ts: new Date().toISOString(),
		level,
		area,
		event,
		message,
		data
	});
}

export const logger = {
	debug(area: string, event: string, data?: LogContext, message?: string): void {
		log("debug", area, event, data, message);
	},
	info(area: string, event: string, data?: LogContext, message?: string): void {
		log("info", area, event, data, message);
	},
	warn(area: string, event: string, data?: LogContext, message?: string): void {
		log("warn", area, event, data, message);
	},
	error(area: string, event: string, error: unknown, data?: LogContext, message?: string): void {
		if (!shouldWriteLevel("error")) {
			return;
		}

		writeRecord({
			ts: new Date().toISOString(),
			level: "error",
			area,
			event,
			message,
			data,
			error
		});
	}
};

export function getCurrentBackendLogPath(): string | null {
	createLogStream();
	return streamPath ?? null;
}

export function installProcessLogHandlers(): void {
	if (processHandlersInstalled) {
		return;
	}

	processHandlersInstalled = true;
	process.on("uncaughtException", (error: Error): void => {
		logger.error("process", "uncaught_exception", error);
	});
	process.on("unhandledRejection", (reason: unknown): void => {
		logger.error("process", "unhandled_rejection", reason);
	});
}

export async function closeLogger(): Promise<void> {
	const currentStream: WriteStream | null | undefined = stream;
	const currentPath: string | null | undefined = streamPath;
	const logDir: string | null = resolveLogDir();
	stream = undefined;
	streamPath = undefined;
	streamDateStamp = undefined;
	streamSizeBytes = 0;
	if (currentStream !== null && currentStream !== undefined) {
		await endStream(currentStream);
	}
	await Promise.all([...closingStreams]);
	if (logDir !== null && currentPath !== null && currentPath !== undefined) {
		pruneLogs(logDir, currentPath);
	}
}
