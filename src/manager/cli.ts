import { DEFAULT_BACKEND_PORT, type ManagerResult } from "./types.js";
import { toManagerFailure, ManagerError } from "./manager-error.js";
import { installBackend, rollbackBackend, startBackend, stopBackend, healthBackend, getLatestBackendVersion } from "./backend.js";
import { applyFrontendUpdate, applyFrontendUpdateWait, downloadAndStageFrontend, getLatestFrontendVersion, rollbackFrontend } from "./frontend.js";
import { readStatus } from "./status.js";
import { configureSystemCertificateTrust } from "../runtime/network-trust.js";

type ParsedArgs = {
	json: boolean;
	command: string[];
	options: Map<string, string | true>;
};

async function main(): Promise<void> {
	configureSystemCertificateTrust();
	const args: ParsedArgs = parseArgs(process.argv.slice(2));
	try {
		const result: ManagerResult = await handleCommand(args);
		writeResult(result, args.json);
		process.exitCode = result.ok ? 0 : 1;
	} catch (error: unknown) {
		const failure = toManagerFailure(error);
		writeResult(failure, args.json);
		process.exitCode = 1;
	}
}

async function handleCommand(args: ParsedArgs): Promise<ManagerResult> {
	const [first, second] = args.command;
	if (first === undefined || first === "help" || first === "--help") {
		return { ok: true, help: getHelpText() };
	}

	if (first === "status") {
		return { ok: true, status: await readStatus(getOptionalStringOption(args, "project"), { includeLatest: !hasFlag(args, "no-latest") }) };
	}

	if (first === "doctor") {
		return {
			ok: true,
			status: await readStatus(getOptionalStringOption(args, "project"), { includeLatest: !hasFlag(args, "no-latest") }),
			node: process.version,
			platform: process.platform
		};
	}

	if (first === "backend") {
		if (second === "install" || second === "update") {
			return { ok: true, backend: await installBackend(getStringOption(args, "version") ?? "latest") };
		}
		if (second === "start") {
			return { ok: true, backend: await startBackend(getNumberOption(args, "port") ?? DEFAULT_BACKEND_PORT) };
		}
		if (second === "stop") {
			return { ok: true, backend: await stopBackend() };
		}
		if (second === "health") {
			return { ok: true, health: await healthBackend(getStringOption(args, "url") ?? `ws://127.0.0.1:${DEFAULT_BACKEND_PORT}`) };
		}
		if (second === "rollback") {
			return { ok: true, backend: await rollbackBackend() };
		}
		if (second === "latest") {
			return { ok: true, version: await getLatestBackendVersion() };
		}
	}

	if (first === "frontend") {
		if (second === "check") {
			return { ok: true, status: (await readStatus(getOptionalStringOption(args, "project"), { includeLatest: !hasFlag(args, "no-latest") })).frontend };
		}
		if (second === "download" || second === "stage") {
			const version: string | null = getStringOption(args, "version") ?? await getLatestFrontendVersion();
			if (version === null) {
				throw new ManagerError({ code: "network_error", message: "Could not resolve latest frontend version." });
			}
			return { ok: true, frontend: await downloadAndStageFrontend(version) };
		}
		if (second === "apply") {
			return { ok: true, frontend: await applyFrontendUpdate(getRequiredStringOption(args, "project")) };
		}
		if (second === "apply-wait") {
			return {
				ok: true,
				frontend: await applyFrontendUpdateWait(getRequiredStringOption(args, "project"), {
					...(getNumberOption(args, "timeout-ms") === null ? {} : { timeoutMs: getNumberOption(args, "timeout-ms")! }),
					...(getNumberOption(args, "interval-ms") === null ? {} : { intervalMs: getNumberOption(args, "interval-ms")! }),
					...(getNumberOption(args, "wait-pid") === null ? {} : { waitPid: getNumberOption(args, "wait-pid")! })
				})
			};
		}
		if (second === "rollback") {
			return { ok: true, frontend: await rollbackFrontend(getRequiredStringOption(args, "project")) };
		}
	}

	throw new ManagerError({
		code: "invalid_arguments",
		message: `Unknown manager command: ${args.command.join(" ")}`,
		details: getHelpText()
	});
}

function parseArgs(argv: string[]): ParsedArgs {
	const command: string[] = [];
	const options: Map<string, string | true> = new Map();
	let json: boolean = false;
	for (let index: number = 0; index < argv.length; index += 1) {
		const arg: string = argv[index]!;
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg.startsWith("--")) {
			const name: string = arg.slice(2);
			const next: string | undefined = argv[index + 1];
			if (next !== undefined && !next.startsWith("--")) {
				options.set(name, next);
				index += 1;
			} else {
				options.set(name, true);
			}
			continue;
		}
		command.push(arg);
	}
	return { json, command, options };
}

function getStringOption(args: ParsedArgs, name: string): string | null {
	const value: string | true | undefined = args.options.get(name);
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function getOptionalStringOption(args: ParsedArgs, name: string): string | undefined {
	return getStringOption(args, name) ?? undefined;
}

function getRequiredStringOption(args: ParsedArgs, name: string): string {
	const value: string | null = getStringOption(args, name);
	if (value === null) {
		throw new ManagerError({ code: "invalid_arguments", message: `Missing required option --${name}` });
	}
	return value;
}

function getNumberOption(args: ParsedArgs, name: string): number | null {
	const value: string | null = getStringOption(args, name);
	if (value === null) {
		return null;
	}
	const parsed: number = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
		throw new ManagerError({ code: "invalid_arguments", message: `Invalid --${name}: ${value}` });
	}
	return parsed;
}

function hasFlag(args: ParsedArgs, name: string): boolean {
	return args.options.get(name) === true;
}

function writeResult(result: ManagerResult, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	if (result.ok) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.error(result.message);
		if (result.details !== undefined) {
			console.error(result.details);
		}
	}
}

function getHelpText(): string {
	return [
		"godot-daedalus-manager [--json] <command>",
		"",
		"Commands:",
		"  status [--project <path>] [--no-latest]",
		"  doctor [--project <path>] [--no-latest]",
		"  backend install|update [--version <version>]",
		"  backend start [--port <port>]",
		"  backend stop",
		"  backend health [--url <ws://...>]",
		"  backend rollback",
		"  frontend check [--project <path>] [--no-latest]",
		"  frontend download|stage [--version <version>]",
		"  frontend apply --project <path>",
		"  frontend apply-wait --project <path>",
		"  frontend rollback --project <path>"
	].join("\n");
}

await main();
