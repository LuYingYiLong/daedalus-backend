import { getSessionDatabase, parseSqlJson, runSessionTransaction, sqlJson } from "./session-database.js";

export type FlowRunEventType = "started" | "cache_hit" | "submission_started" | "provider_job_acquired" | "polling" | "retry" | "artifact_saved" | "completed" | "failed" | "recovery_started" | "recovery_uncertain";
export type FlowRunEvent = { runId: string; nodeId: string; sequence: number; type: FlowRunEventType; at: string; details: Record<string, string | number | boolean | null> };

function safeDetails(details: Record<string, unknown>): Record<string, number | boolean | null> {
	return Object.fromEntries(Object.entries(details).filter(([key, value]) => ["attempt", "outputIndex", "byteSize", "savedResult"].includes(key) && (typeof value === "number" || typeof value === "boolean" || value === null))) as Record<string, number | boolean | null>;
}

export async function recordFlowRunEvent(runId: string, nodeId: string, type: FlowRunEventType, details: Record<string, string | number | boolean | null> = {}): Promise<void> {
	const db = await getSessionDatabase();
	runSessionTransaction(db, (): void => {
		const next = db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM flow_node_run_events WHERE run_id=? AND node_id=?").get(runId,nodeId) as { sequence: number };
		db.prepare("INSERT INTO flow_node_run_events(run_id,node_id,sequence,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)").run(runId,nodeId,next.sequence,type,sqlJson(safeDetails(details)),new Date().toISOString());
	});
}

export async function getFlowRunReport(flowId: string, runId: string): Promise<{ flowId: string; runId: string; status: string; startedAt: string | null; finishedAt: string | null; nodes: Array<{ nodeId: string; typeId: string; status: string; startedAt: string | null; finishedAt: string | null; errorCode: string | null; events: FlowRunEvent[] }> }> {
	const db = await getSessionDatabase();
	const run = db.prepare("SELECT status,started_at,finished_at FROM flow_runs WHERE flow_id=? AND run_id=?").get(flowId,runId) as { status: string; started_at: string | null; finished_at: string | null } | undefined;
	if (!run) throw Object.assign(new Error("Flow run not found."), { code: "flow_run_not_found" });
	const nodes = db.prepare("SELECT node_id,type_id,status,started_at,finished_at,error FROM flow_node_runs WHERE run_id=? ORDER BY node_id").all(runId) as Array<{ node_id: string; type_id: string; status: string; started_at: string | null; finished_at: string | null; error: string | null }>;
	const events = db.prepare("SELECT node_id,sequence,event_type,payload_json,created_at FROM flow_node_run_events WHERE run_id=? ORDER BY node_id,sequence").all(runId) as Array<{ node_id: string; sequence: number; event_type: FlowRunEventType; payload_json: string; created_at: string }>;
	return { flowId, runId, status: run.status, startedAt: run.started_at, finishedAt: run.finished_at, nodes: nodes.map(node => ({ nodeId: node.node_id, typeId: node.type_id, status: node.status, startedAt: node.started_at, finishedAt: node.finished_at, errorCode: node.error === null ? null : /^([a-z][a-z0-9_]+):/u.exec(node.error)?.[1] ?? "flow_node_failed", events: events.filter(event => event.node_id === node.node_id).map(event => {
		const stored = parseSqlJson<Record<string, unknown>>(event.payload_json);
		const details = safeDetails(stored);
		return { runId, nodeId: event.node_id, sequence: event.sequence, type: event.event_type, at: event.created_at, details };
	}) })) };
}
