import { getSessionDatabase, sqlJson, parseSqlJson } from "./session-database.js";

export type FlowBatchItemRun = {
	flowId: string; runId: string; nodeId: string; itemId: string; ordinal: number; requestFingerprint: string; fingerprint: string;
	params: Record<string, unknown>; status: "queued" | "submitting" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
	providerJobId: string | null; output: unknown[]; error: string | null; attempts: number;
};
export async function putFlowBatchItem(item: FlowBatchItemRun): Promise<void> {
	const db = await getSessionDatabase();
	db.prepare("INSERT INTO flow_batch_items(run_id,node_id,item_id,flow_id,ordinal,request_fingerprint,status,payload_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,node_id,item_id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at").run(item.runId,item.nodeId,item.itemId,item.flowId,item.ordinal,item.requestFingerprint,item.status,sqlJson(item),new Date().toISOString());
}
export async function findFlowBatchItem(flowId: string, nodeId: string, itemId: string, fingerprint: string): Promise<FlowBatchItemRun | null> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT payload_json FROM flow_batch_items WHERE flow_id=? AND node_id=? AND item_id=? AND request_fingerprint=? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(flowId,nodeId,itemId,fingerprint) as { payload_json: string } | undefined;
	return row === undefined ? null : parseSqlJson<FlowBatchItemRun>(row.payload_json);
}
export async function listFlowBatchItems(runId: string, nodeId?: string): Promise<FlowBatchItemRun[]> {
	const db = await getSessionDatabase();
	return ((nodeId === undefined ? db.prepare("SELECT payload_json FROM flow_batch_items WHERE run_id=? ORDER BY ordinal").all(runId) : db.prepare("SELECT payload_json FROM flow_batch_items WHERE run_id=? AND node_id=? ORDER BY ordinal").all(runId,nodeId)) as { payload_json: string }[]).map(row => parseSqlJson<FlowBatchItemRun>(row.payload_json));
}
