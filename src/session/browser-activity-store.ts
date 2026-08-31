import { createHash, randomUUID } from "node:crypto";
import type { ProviderToolImageReference } from "../providers/tool-image-reference.js";
import { assertSupportedImageSignature } from "../protocol/image-file-signature.js";
import type { DatabaseSync } from "node:sqlite";
import type { BrowserAudit } from "../server/browser-conversation-authority.js";
import { redactTraceValue } from "../trace/trace-redactor.js";
import { getSessionDatabase, sqlJson } from "./session-database.js";
import { recordBrowserAuditTrace } from "../trace/trace-recorder.js";

export async function recordBrowserActivity(
	event: BrowserAudit,
): Promise<void> {
	const db = await getSessionDatabase();
	const id = randomUUID(),
		createdAt = new Date().toISOString();
	db.prepare(
		"INSERT INTO browser_activity(id,session_id,request_id,run_id,kind,proposal_id,step_id,summary_json,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		event.scope.sessionId,
		event.scope.requestId,
		event.scope.runId,
		event.kind,
		event.proposalId ?? null,
		event.stepId ?? null,
		sqlJson({ ...event.summary, connectionId: event.scope.connectionId }),
		event.detail === undefined
			? null
			: sqlJson(redactTraceValue(event.detail).value),
		createdAt,
	);
	await recordBrowserAuditTrace({
		id,
		...event.scope,
		kind: event.kind,
		createdAt,
		summary: event.summary,
	});
}
export function compactBrowserActivity(
	db: DatabaseSync,
	sessionId: string,
	requestIds: readonly string[],
): number {
	let removed = 0;
	for (const id of requestIds) {
		const row = db
			.prepare(
				"SELECT COALESCE(SUM(COALESCE(length(CAST(detail_json AS BLOB)),0)+COALESCE(length(png),0)),0) AS bytes FROM browser_activity WHERE session_id=? AND request_id=?",
			)
			.get(sessionId, id) as { bytes: number };
		removed += row.bytes;
		db.prepare(
			"UPDATE browser_activity SET detail_json=NULL,png=NULL,detail_level='compacted' WHERE session_id=? AND request_id=?",
		).run(sessionId, id);
	}
	return removed;
}
export async function saveBrowserScreenshot(
	scope: BrowserAudit["scope"],
	dataUrl: unknown,
	signal?: AbortSignal,
): Promise<ProviderToolImageReference> {
	if (
		typeof dataUrl !== "string" ||
		!dataUrl.startsWith("data:image/png;base64,")
	)
		throw new Error("browser_image_invalid");
	const bytes = Buffer.from(dataUrl.slice(22), "base64");
	if (
		bytes.length < 33 ||
		bytes.length > 2 * 1024 * 1024 ||
		assertSupportedImageSignature(bytes) !== "image/png"
	)
		throw new Error("browser_image_invalid");
	const id = randomUUID(),
		db = await getSessionDatabase();
	signal?.throwIfAborted();
	db.prepare(
		"INSERT INTO browser_activity(id,session_id,request_id,run_id,kind,summary_json,png,created_at) VALUES(?,?,?,?,?,?,?,?)",
	).run(
		id,
		scope.sessionId,
		scope.requestId,
		scope.runId,
		"screenshot",
		sqlJson({
			byteSize: bytes.length,
			width: bytes.readUInt32BE(16),
			height: bytes.readUInt32BE(20),
		}),
		bytes,
		new Date().toISOString(),
	);
	return {
		source: {
			kind: "browser_activity",
			sessionId: scope.sessionId,
			activityId: id,
		},
		title: "Authorized browser viewport",
		mimeType: "image/png",
		byteSize: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		width: bytes.readUInt32BE(16),
		height: bytes.readUInt32BE(20),
	};
}
export async function readBrowserScreenshot(
	sessionId: string,
	id: string,
): Promise<Buffer> {
	const db = await getSessionDatabase(),
		row = db
			.prepare(
				"SELECT png,detail_level FROM browser_activity WHERE session_id=? AND id=?",
			)
			.get(sessionId, id) as
			| { png: Uint8Array | null; detail_level: string }
			| undefined;
	if (!row || row.detail_level !== "full" || !row.png)
		throw new Error("browser_details_compacted_or_missing");
	return Buffer.from(row.png);
}
export async function getBrowserActivity(
	sessionId: string,
	developerMode: boolean,
	id?: string,
	before?: string,
): Promise<Record<string, unknown>> {
	const db = await getSessionDatabase();
	if (id) {
		const row = db
			.prepare("SELECT * FROM browser_activity WHERE session_id=? AND id=?")
			.get(sessionId, id) as
			| {
					id: string;
					summary_json: string;
					detail_json: string | null;
					detail_level: string;
					png: Uint8Array | null;
			  }
			| undefined;
		if (!row) throw new Error("browser_activity_not_found");
		return {
			id,
			summary: JSON.parse(row.summary_json),
			detailLevel:
				row.detail_level === "compacted"
					? "compacted"
					: developerMode
						? "full"
						: "summary",
			...(developerMode && row.detail_level === "full"
				? {
						detail: row.detail_json ? JSON.parse(row.detail_json) : null,
						...(row.png
							? {
									dataUrl: `data:image/png;base64,${Buffer.from(row.png).toString("base64")}`,
								}
							: {}),
					}
				: {}),
		};
	}
	const rows = db
		.prepare(
			"SELECT id,request_id,run_id,kind,proposal_id,step_id,summary_json,detail_level,created_at FROM browser_activity WHERE session_id=? AND (? IS NULL OR rowid < (SELECT rowid FROM browser_activity WHERE id=? AND session_id=?)) ORDER BY rowid DESC LIMIT 50",
		)
		.all(sessionId, before ?? null, before ?? null, sessionId);
	return {
		records: rows.map((row) => ({
			id: row.id,
			requestId: row.request_id,
			runId: row.run_id,
			kind: row.kind,
			proposalId: row.proposal_id,
			stepId: row.step_id,
			summary: JSON.parse(String(row.summary_json)),
			detailLevel: developerMode ? row.detail_level : "summary",
			createdAt: row.created_at,
		})),
		nextCursor: rows.length === 50 ? rows.at(-1)!.id : null,
	};
}
