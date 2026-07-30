import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
	getGodotDocumentationIndexPath,
	getGodotDocumentationSnapshot,
	initializeGodotDocumentationStore,
	parseStableDocumentationBranch
} from "./store.js";
import type {
	GodotDocumentationRecord,
	GodotDocumentationScope,
	GodotDocumentationSearchResponse,
	GodotDocumentationSearchResult
} from "./types.js";

const DEFAULT_RESULT_LIMIT: number = 5;
const MAX_RESULT_LIMIT: number = 8;
const MAX_RESULT_BODY_CHARS: number = 4_800;
const MAX_TOTAL_BODY_CHARS: number = 24_000;

export type DocumentationSelection = {
	record: GodotDocumentationRecord;
	projectVersion: string | null;
	reason: string;
};

function compareVersions(left: GodotDocumentationRecord, right: GodotDocumentationRecord): number {
	const leftVersion = parseStableDocumentationBranch(left.branch);
	const rightVersion = parseStableDocumentationBranch(right.branch);
	if (leftVersion === null && rightVersion === null) {
		return left.branch.localeCompare(right.branch);
	}
	if (leftVersion === null) {
		return -1;
	}
	if (rightVersion === null) {
		return 1;
	}
	return leftVersion.major - rightVersion.major || leftVersion.minor - rightVersion.minor;
}

export function selectGodotDocumentation(
	records: readonly GodotDocumentationRecord[],
	explicitBranch?: string | undefined,
	projectVersion?: string | undefined
): DocumentationSelection | null {
	const available: GodotDocumentationRecord[] = records.filter((record): boolean => {
		return existsSync(getGodotDocumentationIndexPath(record));
	});
	if (available.length === 0) {
		return null;
	}
	const normalizedExplicit: string = explicitBranch?.trim() ?? "";
	if (normalizedExplicit.length > 0) {
		const explicit: GodotDocumentationRecord | undefined = available.find((record): boolean => record.branch === normalizedExplicit);
		if (explicit === undefined) {
			return null;
		}
		return {
			record: explicit,
			projectVersion: projectVersion?.trim() || null,
			reason: "explicit_branch"
		};
	}

	const normalizedProjectVersion: string | null = projectVersion?.match(/\d+\.\d+/u)?.[0] ?? null;
	if (normalizedProjectVersion !== null) {
		const exact: GodotDocumentationRecord | undefined = available.find((record): boolean => record.branch === normalizedProjectVersion);
		if (exact !== undefined) {
			return { record: exact, projectVersion: normalizedProjectVersion, reason: "project_version_exact" };
		}
		const target = parseStableDocumentationBranch(normalizedProjectVersion);
		if (target !== null) {
			const sameMajor: GodotDocumentationRecord[] = available
				.filter((record): boolean => parseStableDocumentationBranch(record.branch)?.major === target.major)
				.sort(compareVersions);
			const lowerOrEqual: GodotDocumentationRecord | undefined = [...sameMajor]
				.reverse()
				.find((record): boolean => parseStableDocumentationBranch(record.branch)!.minor <= target.minor);
			if (lowerOrEqual !== undefined) {
				return {
					record: lowerOrEqual,
					projectVersion: normalizedProjectVersion,
					reason: "same_major_lower"
				};
			}
			const higher: GodotDocumentationRecord | undefined = sameMajor.find((record): boolean => {
				return parseStableDocumentationBranch(record.branch)!.minor > target.minor;
			});
			if (higher !== undefined) {
				return {
					record: higher,
					projectVersion: normalizedProjectVersion,
					reason: "same_major_higher"
				};
			}
		}
	}

	const numeric: GodotDocumentationRecord[] = available
		.filter((record): boolean => parseStableDocumentationBranch(record.branch) !== null)
		.sort(compareVersions);
	const highestNumeric: GodotDocumentationRecord | undefined = numeric.at(-1);
	if (highestNumeric !== undefined) {
		return {
			record: highestNumeric,
			projectVersion: normalizedProjectVersion,
			reason: "highest_installed_stable"
		};
	}
	const master: GodotDocumentationRecord | undefined = available.find((record): boolean => record.branch === "master");
	return {
		record: master ?? available.sort((left, right): number => right.branch.localeCompare(left.branch))[0]!,
		projectVersion: normalizedProjectVersion,
		reason: master === undefined ? "installed_fallback" : "master_fallback"
	};
}

function buildFtsQuery(query: string, joiner: "AND" | "OR"): string | null {
	const tokens: string[] = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
	if (tokens.length === 0) {
		return null;
	}
	return [...new Set(tokens.map((token: string): string => token.toLowerCase()))]
		.slice(0, 12)
		.map((token: string): string => `"${token.replaceAll("\"", "\"\"")}"`)
		.join(` ${joiner} `);
}

function createSourceUrl(record: GodotDocumentationRecord, path: string, anchor: string | null): string {
	const docsVersion: string = record.branch === "master" ? "latest" : record.branch;
	const pagePath: string = path.replace(/\.rst$/u, ".html");
	const encodedPath: string = pagePath.split("/").map(encodeURIComponent).join("/");
	return `https://docs.godotengine.org/en/${encodeURIComponent(docsVersion)}/${encodedPath}${anchor === null ? "" : `#${encodeURIComponent(anchor)}`}`;
}

type QueryRow = {
	category: string;
	path: string;
	anchor: string | null;
	title: string;
	symbol: string | null;
	body: string;
	score: number;
};

function mapRow(record: GodotDocumentationRecord, row: QueryRow): GodotDocumentationSearchResult {
	return {
		category: row.category === "class_reference" ? "class_reference" : "manual",
		title: row.title,
		symbol: row.symbol,
		path: row.path,
		anchor: row.anchor,
		content: row.body.slice(0, MAX_RESULT_BODY_CHARS),
		score: row.score,
		sourceUrl: createSourceUrl(record, row.path, row.anchor)
	};
}

function searchDatabase(
	db: DatabaseSync,
	record: GodotDocumentationRecord,
	query: string,
	scope: GodotDocumentationScope,
	limit: number
): { results: GodotDocumentationSearchResult[]; truncatedBySize: boolean } {
	const scopeValue: string | null = scope === "all" ? null : scope;
	const prefix: string = `${query.trim()}%`;
	const exactRows = db.prepare(`
		SELECT category, path, anchor, title, symbol, body,
			CASE
				WHEN lower(symbol) = lower(?) THEN -1000
				WHEN lower(title) = lower(?) THEN -900
				ELSE -800
			END AS score
		FROM chunks
		WHERE (? IS NULL OR category = ?)
			AND (
				lower(symbol) = lower(?)
				OR lower(title) = lower(?)
				OR lower(symbol) LIKE lower(?)
				OR lower(title) LIKE lower(?)
			)
		ORDER BY score, length(body)
		LIMIT ?
	`).all(query, query, scopeValue, scopeValue, query, query, prefix, prefix, limit) as QueryRow[];

	const rows: QueryRow[] = [...exactRows];
	const runFts = (ftsQuery: string | null): void => {
		if (ftsQuery === null || rows.length >= limit) {
			return;
		}
		const ftsRows = db.prepare(`
			SELECT c.category, c.path, c.anchor, c.title, c.symbol, c.body,
				bm25(chunks_fts, 4.0, 8.0, 1.0) AS score
			FROM chunks_fts
			JOIN chunks AS c ON c.id = chunks_fts.rowid
			WHERE chunks_fts MATCH ?
				AND (? IS NULL OR c.category = ?)
			ORDER BY score
			LIMIT ?
		`).all(ftsQuery, scopeValue, scopeValue, limit * 2) as QueryRow[];
		rows.push(...ftsRows);
	};
	const andQuery: string | null = buildFtsQuery(query, "AND");
	runFts(andQuery);
	if (rows.length === exactRows.length) {
		runFts(buildFtsQuery(query, "OR"));
	}

	const seen: Set<string> = new Set();
	const results: GodotDocumentationSearchResult[] = [];
	let totalChars: number = 0;
	let truncatedBySize: boolean = false;
	for (const row of rows.sort((left, right): number => left.score - right.score)) {
		const key: string = `${row.path}\0${row.anchor ?? ""}\0${row.title}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const mapped: GodotDocumentationSearchResult = mapRow(record, row);
		if (totalChars + mapped.content.length > MAX_TOTAL_BODY_CHARS && results.length > 0) {
			truncatedBySize = true;
			break;
		}
		results.push(mapped);
		totalChars += mapped.content.length;
		if (results.length >= limit) {
			break;
		}
	}
	return { results, truncatedBySize };
}

export async function searchGodotDocumentation(params: {
	query: string;
	branch?: string | undefined;
	scope?: GodotDocumentationScope | undefined;
	limit?: number | undefined;
	projectVersion?: string | undefined;
}): Promise<GodotDocumentationSearchResponse> {
	// Godot MCP 是独立进程，每次重读指针配置才能无重启感知 generation 和总开关变化。
	await initializeGodotDocumentationStore(true);
	const settings = getGodotDocumentationSnapshot();
	if (!settings.enabled) {
		return {
			ok: false,
			code: "documentation_disabled",
			selected: null,
			results: [],
			truncated: false
		};
	}
	const selection: DocumentationSelection | null = selectGodotDocumentation(
		Object.values(settings.documents),
		params.branch,
		params.projectVersion
	);
	if (selection === null) {
		return {
			ok: false,
			code: params.branch?.trim() ? "documentation_branch_unavailable" : "documentation_unavailable",
			selected: null,
			results: [],
			truncated: false
		};
	}
	const query: string = params.query.trim();
	if (query.length === 0 || query.length > 500) {
		throw new Error("Documentation query must contain between 1 and 500 characters.");
	}
	const limit: number = Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(params.limit ?? DEFAULT_RESULT_LIMIT)));
	const scope: GodotDocumentationScope = params.scope ?? "all";
	const sqlite = await import("node:sqlite");
	const db: DatabaseSync = new sqlite.DatabaseSync(getGodotDocumentationIndexPath(selection.record), {
		readOnly: true
	});
	try {
		const databaseSearch = searchDatabase(db, selection.record, query, scope, limit + 1);
		const matches: GodotDocumentationSearchResult[] = databaseSearch.results;
		const results: GodotDocumentationSearchResult[] = matches.slice(0, limit);
		return {
			ok: true,
			code: results.length === 0 ? "no_results" : null,
			selected: {
				branch: selection.record.branch,
				commitSha: selection.record.commitSha,
				projectVersion: selection.projectVersion,
				reason: selection.reason
			},
			results,
			truncated: databaseSearch.truncatedBySize || matches.length > limit
		};
	} finally {
		db.close();
	}
}
