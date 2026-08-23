import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getDaedalusPath } from "../../app-paths.js";
import { getSandboxAvailability } from "../../mcp/terminal/sandbox-runner.js";

export type PluginSandboxTestRun = {
	runId: string;
	workspaceRoot: string;
	workspaceDisplay: string;
	sandbox: {
		available: boolean;
		mode: "windows-helper" | "bubblewrap" | "sandbox-exec" | "unavailable";
		network: "disabled";
	};
};

function modeForPlatform(): PluginSandboxTestRun["sandbox"]["mode"] {
	if (process.platform === "win32") return "windows-helper";
	if (process.platform === "linux") return "bubblewrap";
	if (process.platform === "darwin") return "sandbox-exec";
	return "unavailable";
}

export async function createPluginSandboxTestRun(runId: string): Promise<PluginSandboxTestRun> {
	const availability = getSandboxAvailability();
	const mode = availability.available ? modeForPlatform() : "unavailable";
	const parent = getDaedalusPath("plugins.developmentTests");
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(join(parent, "run-"));
	return {
		runId,
		workspaceRoot: root,
		workspaceDisplay: `[test-workspace]/${runId}`,
		sandbox: { available: availability.available, mode, network: "disabled" }
	};
}

export async function cleanupPluginSandboxTestRun(run: PluginSandboxTestRun): Promise<void> {
	await rm(run.workspaceRoot, { recursive: true, force: true });
}

/** Backend restarts never resume a test Worker, so every old run directory is orphaned. */
export async function cleanupOrphanPluginSandboxTestRuns(): Promise<void> {
	const parent = getDaedalusPath("plugins.developmentTests");
	const entries = await readdir(parent, { withFileTypes: true }).catch((error: unknown): [] => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	await Promise.all(entries.filter((entry): boolean => entry.isDirectory() && entry.name.startsWith("run-")).map((entry): Promise<void> => rm(join(parent, entry.name), { recursive: true, force: true })));
}
