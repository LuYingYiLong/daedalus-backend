import { getBackendBuildMetadata } from "./runtime/build-metadata.js";
import { readRuntimeConnectionAuthProtocol } from "./runtime/connection-registry.js";
import { runBackendSelfTest } from "./runtime/self-test.js";
import {
	acquireSharedRuntime,
	getSharedRuntimeStatus,
	releaseSharedRuntimeLease,
	type SharedRuntimeClient
} from "./runtime/shared-runtime.js";

type McpCommand = "terminal" | "workspace" | "godot" | "skills" | "external";

function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(flag);
}

function readFlagValue(args: readonly string[], flag: string): string | null {
	const index: number = args.indexOf(flag);
	const value: string | undefined = index >= 0 ? args[index + 1] : undefined;
	return value === undefined || value.startsWith("--") ? null : value;
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printUsage(): void {
	process.stdout.write([
		"Daedalus Backend",
		"",
		"Usage:",
		"  daedalus-backend serve",
		"  daedalus-backend self-test [--json] [--require-secret-store]",
		"  daedalus-backend version [--json]",
		"  daedalus-backend connection-token --connection-id <id> [--json]",
		"  daedalus-backend runtime acquire --client studio|godot [--project <path>] --json",
		"  daedalus-backend runtime status --json",
		"  daedalus-backend runtime release --lease <id> --json",
		"  daedalus-backend mcp terminal|workspace|godot|skills|external",
		""
	].join("\n"));
}

function isMcpCommand(value: string | undefined): value is McpCommand {
	return value === "terminal"
		|| value === "workspace"
		|| value === "godot"
		|| value === "skills"
		|| value === "external";
}

async function runMcp(command: McpCommand): Promise<void> {
	switch (command) {
		case "terminal":
			await (await import("./mcp/terminal/server.js")).main();
			return;
		case "workspace":
			await (await import("./mcp/workspace/server.js")).main();
			return;
		case "godot":
			await (await import("./mcp/godot/server.js")).main();
			return;
		case "skills":
			await (await import("./mcp/skills/server.js")).main();
			return;
		case "external":
			await (await import("./mcp/external/server.js")).main();
			return;
	}
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
	const [command = "serve", subcommand] = args;
	if (command === "serve") {
		await (await import("./main.js")).runBackendUntilShutdown();
		return;
	}
	if (command === "version" || command === "--version" || command === "-v") {
		const build = getBackendBuildMetadata();
		if (hasFlag(args, "--json")) {
			writeJson(build);
		} else {
			process.stdout.write(`${build.version}\n`);
		}
		return;
	}
	if (command === "self-test") {
		const result = await runBackendSelfTest({
			requireSecretStore: hasFlag(args, "--require-secret-store")
		});
		if (hasFlag(args, "--json")) {
			writeJson(result);
		} else {
			for (const check of result.checks) {
				process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.details === undefined ? "" : `: ${check.details}`}\n`);
			}
		}
		if (!result.ok) {
			process.exitCode = 1;
		}
		return;
	}
	if (command === "connection-token") {
		const connectionId: string | null = readFlagValue(args, "--connection-id");
		if (connectionId === null) {
			throw new Error("connection-token requires --connection-id.");
		}
		const authProtocol: string = await readRuntimeConnectionAuthProtocol(connectionId);
		if (hasFlag(args, "--json")) {
			writeJson({ ok: true, authProtocol });
		} else {
			process.stdout.write(`${authProtocol}\n`);
		}
		return;
	}
	if (command === "runtime") {
		if (subcommand === "status") {
			writeJson(await getSharedRuntimeStatus());
			return;
		}
		if (subcommand === "acquire") {
			const clientValue: string | null = readFlagValue(args, "--client");
			if (clientValue !== "studio" && clientValue !== "godot") {
				throw new Error("runtime acquire requires --client studio|godot.");
			}
			const client: SharedRuntimeClient = clientValue;
			const projectPath: string | null = readFlagValue(args, "--project");
			writeJson(await acquireSharedRuntime({
				client,
				...(projectPath === null ? {} : { projectPath })
			}));
			return;
		}
		if (subcommand === "release") {
			const leaseId: string | null = readFlagValue(args, "--lease");
			if (leaseId === null) {
				throw new Error("runtime release requires --lease <id>.");
			}
			writeJson(releaseSharedRuntimeLease(leaseId));
			return;
		}
		throw new Error(`Unknown runtime command: ${subcommand ?? ""}`);
	}
	if (command === "mcp" && isMcpCommand(subcommand)) {
		await runMcp(subcommand);
		return;
	}
	if (command === "internal" && subcommand === "session-search-indexer") {
		await (await import("./session-search/indexer-process.js")).runSessionSearchIndexerProcess();
		return;
	}
	if (command === "help" || command === "--help" || command === "-h") {
		printUsage();
		return;
	}
	throw new Error(`Unknown Daedalus backend command: ${args.join(" ")}`);
}

main().catch((error: unknown): void => {
	const message: string = error instanceof Error ? error.message : String(error);
	if (process.argv.includes("--json")) {
		writeJson({ ok: false, error: message });
	} else {
		console.error(message);
	}
	process.exitCode = 1;
});
