import { getSessionDatabase, parseSqlJson, sqlJson } from "./session-database.js";

export type FlowMediaAttemptStatus = "submitting" | "running" | "result_ready" | "completed" | "failed" | "uncertain";
export type FlowMediaAttempt = {
	runId: string;
	nodeId: string;
	attempt: number;
	requestFingerprint: string;
	status: FlowMediaAttemptStatus;
	providerJobId: string | null;
	output: Record<string, unknown> | null;
};

export async function latestFlowMediaAttempt(runId: string, nodeId: string): Promise<FlowMediaAttempt | null> {
	const db = await getSessionDatabase();
	const row = db.prepare("SELECT run_id,node_id,attempt,request_fingerprint,status,provider_job_id,output_json FROM flow_media_attempts WHERE run_id=? AND node_id=? ORDER BY attempt DESC LIMIT 1").get(runId, nodeId) as {
		run_id: string; node_id: string; attempt: number; request_fingerprint: string; status: FlowMediaAttemptStatus; provider_job_id: string | null; output_json: string | null;
	} | undefined;
	return row === undefined ? null : { runId: row.run_id, nodeId: row.node_id, attempt: row.attempt, requestFingerprint: row.request_fingerprint, status: row.status, providerJobId: row.provider_job_id, output: row.output_json === null ? null : parseSqlJson<Record<string, unknown>>(row.output_json) };
}

export async function beginFlowMediaAttempt(runId: string, nodeId: string, requestFingerprint: string): Promise<FlowMediaAttempt> {
	const db = await getSessionDatabase();
	const previous = await latestFlowMediaAttempt(runId, nodeId);
	const attempt = (previous?.attempt ?? 0) + 1;
	const now = new Date().toISOString();
	db.prepare("INSERT INTO flow_media_attempts(run_id,node_id,attempt,request_fingerprint,status,provider_job_id,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?)").run(runId,nodeId,attempt,requestFingerprint,"submitting",now,now);
	return { runId, nodeId, attempt, requestFingerprint, status: "submitting", providerJobId: null, output: null };
}

export async function setFlowMediaAttemptResult(attempt: FlowMediaAttempt, output: Record<string, unknown>): Promise<void> {
	const db = await getSessionDatabase();
	db.prepare("UPDATE flow_media_attempts SET status='result_ready',output_json=?,updated_at=? WHERE run_id=? AND node_id=? AND attempt=?").run(sqlJson(output),new Date().toISOString(),attempt.runId,attempt.nodeId,attempt.attempt);
	attempt.status = "result_ready";
	attempt.output = output;
}

export async function updateFlowMediaAttempt(attempt: FlowMediaAttempt, status: FlowMediaAttemptStatus, providerJobId: string | null = attempt.providerJobId): Promise<void> {
	const db = await getSessionDatabase();
	db.prepare("UPDATE flow_media_attempts SET status=?,provider_job_id=?,updated_at=? WHERE run_id=? AND node_id=? AND attempt=?").run(status,providerJobId,new Date().toISOString(),attempt.runId,attempt.nodeId,attempt.attempt);
	attempt.status = status;
	attempt.providerJobId = providerJobId;
}
