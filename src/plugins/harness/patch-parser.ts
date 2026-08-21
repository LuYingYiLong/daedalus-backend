import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HarnessBundleSummary, HarnessSkippedRow } from "../types.js";
import {
	MAX_HARNESS_PATCH_BYTES,
	MAX_HARNESS_PATCH_LINE_CHARS,
	MAX_HARNESS_PATCH_LINES,
	MAX_HARNESS_PATCH_ROWS
} from "./limits.js";

type Operation = "insert" | "replace" | "override";
type MutableRow = { index: number; indent: number; id: string | undefined; name: string | undefined; source: string[] };

const OPERATION_PATTERN = /^(\s*)-\s*(insert|replace|override)\s*:\s*(?:#.*)?$/u;
const ANY_OPERATION_PATTERN = /^(\s*)-\s*([A-Za-z][\w-]*)\s*:\s*(?:#.*)?$/u;
const ROW_START_PATTERN = /^(\s*)-\s*(id|name)\s*:\s*([^#]*?)(?:\s+#.*)?$/u;
const ROW_FIELD_PATTERN = /^(\s*)(id|name)\s*:\s*([^#]*?)(?:\s+#.*)?$/u;

function scalar(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.startsWith("!!") || trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.includes("${")) return undefined;
	if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed;
}

function isPathInside(root: string, candidate: string): boolean {
	const value: string = relative(resolve(root), resolve(candidate));
	return value.length === 0 || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function finishRow(row: MutableRow | undefined, skippedRows: HarnessSkippedRow[], seenIds: Set<string>, warnings: string[]): number {
	if (row === undefined) return 0;
	const reason: string | undefined = row.name === undefined
		? "The Cordis row does not declare a statically inspectable plugin name."
		: row.id === undefined
			? "The Cordis row does not declare a stable id."
			: undefined;
	if (reason !== undefined) {
		skippedRows.push({ index: row.index, ...(row.id === undefined ? {} : { id: row.id }), ...(row.name === undefined ? {} : { name: row.name }), reason });
		return 0;
	}
	if (seenIds.has(row.id!)) warnings.push(`Duplicate Cordis row id: ${row.id}.`);
	seenIds.add(row.id!);
	return 1;
}

export async function parseHarnessBundlePatch(packageRoot: string, patchPath: string): Promise<HarnessBundleSummary> {
	if (!patchPath.startsWith(".")) throw Object.assign(new Error("Harness patch path must be package-relative."), { code: "plugin_harness_patch_path_invalid" });
	const candidate: string = resolve(packageRoot, patchPath);
	if (!isPathInside(packageRoot, candidate)) throw Object.assign(new Error("Harness patch path escapes the plugin package."), { code: "plugin_harness_patch_path_escape" });
	const info = await lstat(candidate);
	if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("Harness patch must be a regular file."), { code: "plugin_harness_patch_invalid" });
	const packageReal: string = await realpath(packageRoot);
	const patchReal: string = await realpath(candidate);
	if (!isPathInside(packageReal, patchReal)) throw Object.assign(new Error("Harness patch resolves outside the plugin package."), { code: "plugin_harness_patch_path_escape" });
	if (info.size > MAX_HARNESS_PATCH_BYTES) throw Object.assign(new Error("Harness patch exceeds the size limit."), { code: "plugin_harness_patch_too_large" });
	const bytes: Buffer = await readFile(patchReal);
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw Object.assign(new Error("Harness patch must be UTF-8 text."), { code: "plugin_harness_patch_encoding" }); }
	const lines: string[] = text.split(/\r?\n/u);
	if (lines.length > MAX_HARNESS_PATCH_LINES || lines.some((line): boolean => line.length > MAX_HARNESS_PATCH_LINE_CHARS)) {
		throw Object.assign(new Error("Harness patch exceeds the structural limits."), { code: "plugin_harness_patch_too_complex" });
	}
	const operations: Operation[] = [];
	const warnings: string[] = [];
	const dangerousConstructs: string[] = [];
	const skippedRows: HarnessSkippedRow[] = [];
	let currentOperationIndent: number | undefined;
	let currentRow: MutableRow | undefined;
	let totalRows: number = 0;
	let bridgeableRows: number = 0;
	const seenIds = new Set<string>();
	for (let offset = 0; offset < lines.length; offset += 1) {
		const line: string = lines[offset]!;
		if (/!!js\b/u.test(line) && !dangerousConstructs.includes("Cordis !!js expression")) dangerousConstructs.push("Cordis !!js expression");
		if (/^\s*inject\s*:/u.test(line) && !dangerousConstructs.includes("Cordis service injection")) dangerousConstructs.push("Cordis service injection");
		if (/\b(?:include|dynamic|group)\s*:/u.test(line) && !dangerousConstructs.includes("Dynamic Cordis composition")) dangerousConstructs.push("Dynamic Cordis composition");
		const operation = line.match(OPERATION_PATTERN);
		if (operation !== null) {
			bridgeableRows += finishRow(currentRow, skippedRows, seenIds, warnings);
			currentRow = undefined;
			currentOperationIndent = operation[1]!.length;
			const value = operation[2] as Operation;
			if (!operations.includes(value)) operations.push(value);
			continue;
		}
		const anyOperation = line.match(ANY_OPERATION_PATTERN);
		if (anyOperation !== null && anyOperation[1]!.length === 0 && !["insert", "replace", "override"].includes(anyOperation[2]!)) {
			bridgeableRows += finishRow(currentRow, skippedRows, seenIds, warnings);
			currentRow = undefined;
			currentOperationIndent = undefined;
			warnings.push(`Line ${offset + 1}: unsupported patch operation ${anyOperation[2]}.`);
			continue;
		}
		if (currentOperationIndent === undefined) continue;
		const rowStart = line.match(ROW_START_PATTERN);
		if (rowStart !== null && rowStart[1]!.length > currentOperationIndent) {
			bridgeableRows += finishRow(currentRow, skippedRows, seenIds, warnings);
			if (++totalRows > MAX_HARNESS_PATCH_ROWS) throw Object.assign(new Error("Harness patch row limit exceeded."), { code: "plugin_harness_patch_too_complex" });
			const value: string | undefined = scalar(rowStart[3]!);
			currentRow = { index: offset + 1, indent: rowStart[1]!.length, source: [line], id: rowStart[2] === "id" ? value : undefined, name: rowStart[2] === "name" ? value : undefined };
			continue;
		}
		if (currentRow !== undefined) {
			currentRow.source.push(line);
			const field = line.match(ROW_FIELD_PATTERN);
			if (field !== null && field[1]!.length > currentRow.indent) {
				const value: string | undefined = scalar(field[3]!);
				if (field[2] === "id") currentRow.id = value;
				else currentRow.name = value;
			}
		}
	}
	bridgeableRows += finishRow(currentRow, skippedRows, seenIds, warnings);
	if (operations.length === 0) warnings.push("The patch does not contain a supported insert, replace, or override layer.");
	return {
		patchPath,
		totalRows,
		bridgeableRows,
		skippedRows,
		operations,
		warnings,
		dangerousConstructs,
		contentHash: createHash("sha256").update(bytes).digest("hex")
	};
}

export async function createSanitizedHarnessPatch(
	packageRoot: string,
	patchPath: string,
	summary: HarnessBundleSummary
): Promise<string> {
	const candidate: string = resolve(packageRoot, patchPath);
	if (!isPathInside(packageRoot, candidate)) throw Object.assign(new Error("Harness patch path escapes the plugin package."), { code: "plugin_harness_patch_path_escape" });
	const packageReal: string = await realpath(packageRoot);
	const patchReal: string = await realpath(candidate);
	if (!isPathInside(packageReal, patchReal)) throw Object.assign(new Error("Harness patch resolves outside the plugin package."), { code: "plugin_harness_patch_path_escape" });
	const text: string = await readFile(patchReal, "utf8");
	const lines: string[] = text.split(/\r?\n/u);
	const skippedRowLines = new Set(summary.skippedRows.map((row): number => row.index));
	const output: string[] = [];
	let supportedOperation: boolean = false;
	let operationIndent: number = -1;
	let rowIndent: number | undefined;
	let skipCurrentRow: boolean = false;
	for (let offset = 0; offset < lines.length; offset += 1) {
		const line: string = lines[offset]!;
		const anyOperation = line.match(ANY_OPERATION_PATTERN);
		if (anyOperation !== null && anyOperation[1]!.length === 0) {
			supportedOperation = ["insert", "replace", "override"].includes(anyOperation[2]!);
			operationIndent = anyOperation[1]!.length;
			rowIndent = undefined;
			skipCurrentRow = false;
			if (supportedOperation) output.push(line);
			continue;
		}
		if (!supportedOperation) continue;
		const rowStart = line.match(ROW_START_PATTERN);
		if (rowStart !== null && rowStart[1]!.length > operationIndent) {
			rowIndent = rowStart[1]!.length;
			skipCurrentRow = skippedRowLines.has(offset + 1);
			if (!skipCurrentRow) output.push(line);
			continue;
		}
		if (rowIndent !== undefined && line.trim().length > 0) {
			const indent: number = line.length - line.trimStart().length;
			if (indent <= operationIndent) {
				supportedOperation = false;
				rowIndent = undefined;
				skipCurrentRow = false;
				continue;
			}
		}
		if (!skipCurrentRow) output.push(line);
	}
	return `${output.join("\n").trimEnd()}\n`;
}
