import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { findWorkspace } from "../workspace/registry.js";
import { getFlowArtifact } from "../session/flow-artifact-store.js";
import { getSessionDatabase } from "../session/session-database.js";
import { resolveSafeDestination } from "./image-workspace-import.js";

const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
	"video/mp4": ".mp4",
	"video/webm": ".webm",
	"video/quicktime": ".mov",
};

export const flowVideoSaveSchema = z.object({
	flowId: z.string(), saveId: z.string().regex(/^[a-f0-9]{64}$/u),
	items: z.array(z.object({ itemKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(), artifactId: z.string(), relativePath: z.string().min(1).max(4000) }).strict()).min(1).max(100),
}).strict();

export async function saveFlowVideos(args: unknown, workspaceId: string | undefined, sessionId: string | undefined, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const request = flowVideoSaveSchema.parse(args);
	if (sessionId !== `flow:${request.flowId}` || !workspaceId) throw new Error("flow_video_save_scope_invalid");
	const db = await getSessionDatabase();
	const flow = db.prepare("SELECT workspace_id FROM flow_documents WHERE flow_id=?").get(request.flowId) as { workspace_id: string } | undefined;
	const workspace = findWorkspace(workspaceId);
	if (!workspace || flow?.workspace_id !== workspaceId) throw new Error("flow_video_save_workspace_invalid");
	const results: Record<string, unknown>[] = [];
	const failures: Record<string, unknown>[] = [];
	for (const [index, item] of request.items.entries()) {
		signal?.throwIfAborted();
		try {
			const key = item.itemKey ? createHash("sha256").update(`${request.saveId}:${item.itemKey}`).digest("hex") : request.saveId;
			const itemIndex = item.itemKey ? 0 : index;
			const artifact = await getFlowArtifact(item.artifactId);
			const extension = VIDEO_EXTENSIONS[artifact.ref.mimeType];
			if (artifact.ref.flowId !== request.flowId || extension === undefined) throw new Error("flow_video_save_artifact_invalid");
			if (path.extname(item.relativePath).toLowerCase() !== extension) throw new Error("flow_video_save_extension_invalid");
			const destination = await resolveSafeDestination(workspace.rootPath, item.relativePath);
			const previous = db.prepare("SELECT relative_path,sha256 FROM flow_video_saves WHERE save_id=? AND item_index=?").get(key, itemIndex) as { relative_path: string; sha256: string } | undefined;
			let relativePath = previous?.relative_path ?? destination.relativePath;
			let saved = false;
			if (previous) {
				const target = await resolveSafeDestination(workspace.rootPath, previous.relative_path);
				try {
					const info = await lstat(target.absolutePath);
					if (info.isSymbolicLink() || !info.isFile()) throw new Error("flow_video_save_link_invalid");
					const bytes = await readFile(target.absolutePath);
					saved = createHash("sha256").update(bytes).digest("hex") === artifact.ref.sha256;
				} catch { /* 删除或修改后的文件需要重新保存，wx 不跟随现存链接 */ }
			}
			if (!saved) for (let suffix = 0; suffix < 10000; suffix++) {
				const ext = path.extname(destination.relativePath);
				relativePath = suffix === 0 ? destination.relativePath : `${destination.relativePath.slice(0, -ext.length)}-${suffix}${ext}`;
				const target = await resolveSafeDestination(workspace.rootPath, relativePath);
				await mkdir(path.dirname(target.absolutePath), { recursive: true });
				await resolveSafeDestination(workspace.rootPath, relativePath);
				db.prepare("INSERT INTO flow_video_saves(save_id,item_index,flow_id,relative_path,sha256) VALUES(?,?,?,?,?) ON CONFLICT(save_id,item_index) DO UPDATE SET relative_path=excluded.relative_path,sha256=excluded.sha256").run(key, itemIndex, request.flowId, relativePath, artifact.ref.sha256);
				try { await writeFile(target.absolutePath, artifact.bytes, { flag: "wx" }); saved = true; break; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			}
			if (!saved) throw new Error("flow_video_save_name_limit");
			results.push({ artifactId: item.artifactId, relativePath, sha256: artifact.ref.sha256 });
		} catch (error) {
			if (signal?.aborted) throw error;
			failures.push({ index, artifactId: item.artifactId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { saved: results, failed: failures };
}
