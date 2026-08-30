import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  computerObservationSchema,
  type ComputerObservation,
} from "../protocol/computer-observation.js";
import { assertSupportedImageSignature } from "../protocol/image-file-signature.js";
import {
  getSessionDatabase,
  runSessionTransaction,
  sqlJson,
  parseSqlJson,
} from "./session-database.js";
import type { ProviderToolImageReference } from "../providers/tool-image-reference.js";
type Row = {
  detail_json: string | null;
  png: Uint8Array | null;
  request_id: string;
  summary_json: string;
  detail_level: string;
  revision: number;
};
export async function saveComputerObservation(
  sessionId: string,
  requestId: string,
  toolCallId: string,
  value: unknown,
): Promise<ComputerObservation> {
  const observation = computerObservationSchema.parse(value);
  if (observation.dataUrl !== undefined)
    throw new Error("computer_unrequested_image");
  const db = await getSessionDatabase();
  runSessionTransaction(db, () => {
    const summary = {
      observationId: observation.observationId,
      capturedAt: observation.capturedAt,
      durationMs: observation.durationMs,
      nodeCount: observation.nodes.length,
      textCount: observation.texts.length,
      width: observation.width,
      height: observation.height,
      truncated: observation.truncated,
    };
    db.prepare(
      "INSERT INTO computer_observations(session_id,observation_id,request_id,tool_call_id,detail_json,summary_json) VALUES(?,?,?,?,?,?)",
    ).run(
      sessionId,
      observation.observationId,
      requestId,
      toolCallId,
      sqlJson(observation),
      sqlJson(summary),
    );
  });
  return observation;
}
export async function saveComputerScreenshot(
  sessionId: string,
  requestId: string,
  value: unknown,
): Promise<ProviderToolImageReference> {
  const { dataUrl, ...observation } = computerObservationSchema.parse(value);
  if (!dataUrl) throw new Error("computer_image_missing");
  const bytes = Buffer.from(
    dataUrl.slice("data:image/png;base64,".length),
    "base64",
  );
  if (
    !bytes.length ||
    bytes.length > 5 * 1024 * 1024 ||
    assertSupportedImageSignature(bytes) !== "image/png"
  )
    throw new Error("computer_image_invalid");
  if (
    bytes.length < 33 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== observation.width ||
    bytes.readUInt32BE(20) !== observation.height
  )
    throw new Error("computer_image_invalid");
  const db = await getSessionDatabase();
  runSessionTransaction(db, () => {
    const row = db
      .prepare(
        "SELECT detail_json,detail_level,request_id FROM computer_observations WHERE session_id=? AND observation_id=?",
      )
      .get(sessionId, observation.observationId) as Row | undefined;
    if (!row || row.request_id !== requestId)
      throw new Error("computer_observation_stale");
    if (row.detail_level === "compacted")
      throw new Error("computer_details_compacted");
    if (row.detail_json !== sqlJson(observation))
      throw new Error("computer_observation_mismatch");
    db.prepare(
      "UPDATE computer_observations SET png=?,revision=revision+1 WHERE session_id=? AND observation_id=?",
    ).run(bytes, sessionId, observation.observationId);
  });
  return {
    source: {
      kind: "computer_observation",
      sessionId,
      observationId: observation.observationId,
    },
    title: "Authorized window observation",
    mimeType: "image/png",
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: observation.width,
    height: observation.height,
  };
}
export async function readComputerScreenshot(
  sessionId: string,
  observationId: string,
): Promise<Buffer> {
  const row = (await getSessionDatabase())
    .prepare(
      "SELECT png,detail_level FROM computer_observations WHERE session_id=? AND observation_id=?",
    )
    .get(sessionId, observationId) as Row | undefined;
  if (row?.detail_level === "compacted")
    throw new Error("computer_details_compacted");
  if (!row?.png) throw new Error("computer_image_unavailable");
  return Buffer.from(row.png);
}
export async function getComputerObservation(
  sessionId: string,
  observationId: string,
  developerMode: boolean,
): Promise<Record<string, unknown>> {
  const row = (await getSessionDatabase())
    .prepare(
      "SELECT * FROM computer_observations WHERE session_id=? AND observation_id=?",
    )
    .get(sessionId, observationId) as Row | undefined;
  if (!row) throw new Error("computer_observation_not_found");
  const detailLevel =
    row.detail_level === "compacted"
      ? "compacted"
      : developerMode
        ? "full"
        : "summary";
  return {
    summary: parseSqlJson(row.summary_json),
    detailLevel,
    revision: row.revision,
    ...(detailLevel === "full"
      ? {
          observation: parseSqlJson(row.detail_json),
          ...(row.png
            ? {
                dataUrl: `data:image/png;base64,${Buffer.from(row.png).toString("base64")}`,
              }
            : {}),
        }
      : {}),
  };
}
export function compactComputerObservations(
  db: DatabaseSync,
  sessionId: string,
  requestIds: readonly string[],
): number {
  let removedBytes = 0;
  for (const requestId of requestIds) {
    const rows = db
      .prepare(
        "SELECT detail_json,png FROM computer_observations WHERE session_id=? AND request_id=? AND detail_level='full'",
      )
      .all(sessionId, requestId) as Row[];
    for (const row of rows)
      removedBytes +=
        Buffer.byteLength(row.detail_json ?? "") + (row.png?.byteLength ?? 0);
    db.prepare(
      "UPDATE computer_observations SET detail_json=NULL,png=NULL,detail_level='compacted',revision=revision+1 WHERE session_id=? AND request_id=? AND detail_level='full'",
    ).run(sessionId, requestId);
  }
  return removedBytes;
}
