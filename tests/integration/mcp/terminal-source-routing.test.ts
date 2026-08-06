import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpHost } from "../../../src/mcp/mcp-host.js";
import type { McpSession } from "../../../src/mcp/mcp-session.js";
import { findWorkspace, upsertRuntimeWorkspace } from "../../../src/workspace/registry.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

async function withUserProfile<T>(callback: () => Promise<T>): Promise<T> {
	const previous: string | undefined = process.env.USERPROFILE;
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-terminal-routing-profile-"));
	process.env.USERPROFILE = profile;
	try {
		return await callback();
	} finally {
		if (previous === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previous;
		await rm(profile, { recursive: true, force: true });
	}
}

function createWorkspace(frontend: string, backend: string): WorkspaceConfig {
	return {
		id: "terminal-routing-test",
		name: "terminal-routing-test",
		kind: "godot",
		rootPath: frontend,
		icon: 0,
		color: 0,
		sourceFolders: [
			{ id: "frontend", path: frontend, capabilities: { git: false, godot: false } },
			{ id: "backend", path: backend, capabilities: { git: false, godot: false } }
		],
		primarySourceFolderId: "frontend"
	};
}

test("multi-source terminal errors are structured and unique cwd is routed safely", async (): Promise<void> => {
	await withUserProfile(async (): Promise<void> => {
		const root: string = await mkdtemp(join(tmpdir(), "daedalus-terminal-routing-"));
		const frontend: string = join(root, "frontend");
		const backend: string = join(root, "backend");
		await mkdir(join(frontend, "scripts"), { recursive: true });
		await mkdir(backend, { recursive: true });
		const workspace: WorkspaceConfig = upsertRuntimeWorkspace(createWorkspace(frontend, backend));
		assert.equal(findWorkspace(workspace.id)?.sourceFolders.length, 2);
		const host: McpHost = new McpHost();
		host.ensureGlobalInternalServers = async (): Promise<void> => undefined;

		try {
			const missingSource = await host.callTool("terminal", "run_command", { commandLine: "git status" }, workspace.id);
			const missingRecord = missingSource as unknown as { isError?: boolean; content?: Array<{ text?: unknown }> };
			const missingPayload = JSON.parse(String(missingRecord.content?.[0]?.text)) as Record<string, unknown>;
			assert.equal(missingRecord.isError, true);
			assert.equal(missingPayload.code, "source_required");
			assert.deepEqual(
				(missingPayload.candidates as Array<Record<string, unknown>>).map((candidate) => candidate.sourceFolderId),
				["frontend", "backend"]
			);

			let forwardedArgs: Record<string, unknown> | undefined;
			host.getSession = (() => ({
				callTool: async (_name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
					forwardedArgs = args;
					return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
				}
			}) as unknown as McpSession) as typeof host.getSession;

			await host.callTool("terminal", "run_command", {
				commandLine: "git status",
				cwd: "scripts"
			}, workspace.id);
			assert.equal(forwardedArgs?.__daedalusSourceFolderId, "frontend");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
