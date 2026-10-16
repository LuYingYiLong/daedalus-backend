import { realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import {
	consumeTerminalCommandAuthorization,
	getAuthorizedExternalAccessTargets,
	type TerminalCommandAuthorization,
} from "./authorization.js";
import type { CrossSandboxExecutionBoundary, ExternalAccessTarget } from "../../tools/cross-sandbox-access.js";
import type { CommandInvocation } from "./process-runner.js";
import {
	createSandboxEnvironment,
	createSandboxInvocation,
	isUnsandboxedConsentText,
	type SandboxCommand,
	type SandboxRuntimeOptions
} from "./sandbox-runner.js";

export type SandboxExecutionInput = {
	__daedalusApprovalMode?: "manual" | "auto-safe" | "full-trust" | undefined;
	__daedalusConsentText?: string | undefined;
	__daedalusCommandAuthorization?: TerminalCommandAuthorization | undefined;
};

export type ProcessInvocationResolution =
	| { ok: true; invocation: CommandInvocation }
	| { ok: false; result: Record<string, unknown> };

function createTrustedEnvironment(inputEnv: Record<string, string> | undefined): Record<string, string> {
	return {
		...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
		...(inputEnv ?? {})
	};
}

export function createReviewedRuntimeEnvironment(
	inputEnv: Record<string, string> | undefined,
	targets: readonly ExternalAccessTarget[],
	options: { platform?: NodeJS.Platform | undefined; hostEnv?: NodeJS.ProcessEnv | undefined } = {}
): Record<string, string> | undefined {
	const platform: NodeJS.Platform = options.platform ?? process.platform;
	const pathKey: string = platform === "win32" ? "Path" : "PATH";
	const hostEnv: NodeJS.ProcessEnv = options.hostEnv ?? process.env;
	const approvedDirectories: string[] = targets
		.filter((target: ExternalAccessTarget): boolean => target.mode === "execute")
		.map((target: ExternalAccessTarget): string => statSync(target.path).isDirectory() ? target.path : path.dirname(target.path));
	if (approvedDirectories.length === 0) return inputEnv;
	const originalPath: string = inputEnv?.PATH ?? inputEnv?.Path ?? hostEnv.PATH ?? hostEnv.Path ?? "";
	const uniqueDirectories: string[] = [...new Map(approvedDirectories.map((directory: string): [string, string] => [
		platform === "win32" ? directory.toLowerCase() : directory,
		directory
	])).values()];
	const env: Record<string, string> = { ...(inputEnv ?? {}) };
	delete env.PATH;
	delete env.Path;
	env[pathKey] = [...uniqueDirectories, originalPath].filter(Boolean).join(platform === "win32" ? ";" : ":");
	return env;
}

export function resolveSandboxedProcessInvocation(params: {
	input: SandboxExecutionInput & Record<string, unknown>;
	command: SandboxCommand;
	commandLine: string;
	cwd: string;
	workspaceRoot: string;
	workspaceId?: string | undefined;
	env?: Record<string, string> | undefined;
	readOnlyPaths?: readonly string[] | undefined;
	externalReadOnlyPaths?: readonly string[] | undefined;
	runtime?: SandboxRuntimeOptions | undefined;
}): ProcessInvocationResolution {
	const trusted: boolean = params.input.__daedalusApprovalMode === "full-trust";
	const commonInvocation = {
		commandLine: params.commandLine,
		workspaceId: params.workspaceId,
		workspaceRoot: params.workspaceRoot,
		trusted,
		consentText: params.input.__daedalusConsentText
	};
	if (trusted) {
		return {
			ok: true,
			invocation: params.command.kind === "shell"
				? {
					...commonInvocation,
					command: params.command.commandLine,
					args: [],
					shell: true,
					env: createTrustedEnvironment(params.env),
					sandboxMode: "full-trust"
				}
				: {
					...commonInvocation,
					command: params.command.command,
					args: [...params.command.args],
					env: createTrustedEnvironment(params.env),
					sandboxMode: "full-trust"
				}
		};
	}

	const authorizedTargets: readonly ExternalAccessTarget[] = getAuthorizedExternalAccessTargets(
		params.input.__daedalusCommandAuthorization
	);
	const externalTargetKey = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
	const externalTargetsByPath: Map<string, ExternalAccessTarget> = new Map(
		authorizedTargets.map((target: ExternalAccessTarget): [string, ExternalAccessTarget] => [externalTargetKey(target.path), target])
	);
	for (const candidate of params.externalReadOnlyPaths ?? []) {
		try {
			const resolvedPath: string = realpathSync(candidate);
			const key: string = externalTargetKey(resolvedPath);
			if (!externalTargetsByPath.has(key)) {
				externalTargetsByPath.set(key, { path: resolvedPath, mode: "read" });
			}
		} catch {
			return {
				ok: false,
				result: {
					ok: false,
					code: "cross_sandbox_access_invalid",
					error: `External read-only path is unavailable: ${candidate}`,
				},
			};
		}
	}
	const externalTargets: ExternalAccessTarget[] = [...externalTargetsByPath.values()].sort(
		(left: ExternalAccessTarget, right: ExternalAccessTarget): number => externalTargetKey(left.path).localeCompare(externalTargetKey(right.path))
	);
	let runtimeEnv: Record<string, string> | undefined;
	try {
		runtimeEnv = createReviewedRuntimeEnvironment(params.env, externalTargets, {
			platform: params.runtime?.platform,
			hostEnv: params.runtime?.env
		});
	} catch {
		return {
			ok: false,
			result: {
				ok: false,
				code: "cross_sandbox_access_invalid",
				error: "An authorized external runtime path became unavailable before launch."
			}
		};
	}
	const sandboxInvocation = createSandboxInvocation({
		command: params.command,
		cwd: params.cwd,
		workspaceRoot: params.workspaceRoot,
		env: runtimeEnv,
		readOnlyPaths: [
			...(params.readOnlyPaths ?? []),
			...externalTargets.map((target: ExternalAccessTarget): string => target.path),
		],
		network: params.input.__daedalusCommandAuthorization?.crossSandbox?.networkAccess === true,
		runtime: params.runtime
	});
	if (sandboxInvocation.available) {
		if (params.input.__daedalusCommandAuthorization?.crossSandbox !== undefined) {
			const boundary: CrossSandboxExecutionBoundary = "sandbox_external_read";
			const authorization = consumeTerminalCommandAuthorization(
				params.input.__daedalusCommandAuthorization,
				params.input,
				params.workspaceId,
				{
					boundary,
					commandLine: params.commandLine,
					cwd: params.cwd,
					externalTargets,
					networkAccess: sandboxInvocation.network,
				}
			);
			if (!authorization.allowed) {
				return {
					ok: false,
					result: {
						ok: false,
						code: "cross_sandbox_authorization_required",
						error: authorization.reason,
						sandboxMode: sandboxInvocation.sandboxMode,
					},
				};
			}
		}
		return {
			ok: true,
			invocation: {
				...commonInvocation,
				command: sandboxInvocation.command,
				args: sandboxInvocation.args,
				env: sandboxInvocation.env,
				sandboxMode: sandboxInvocation.sandboxMode
			}
		};
	}
	const directAuthorization = params.input.__daedalusCommandAuthorization;
	if (directAuthorization?.source === "user" && !isUnsandboxedConsentText(params.input.__daedalusConsentText)) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `${sandboxInvocation.error} Explicit consent is required to run without the OS sandbox.`,
				code: "sandbox_unavailable",
				sandboxMode: sandboxInvocation.sandboxMode,
				workspaceId: params.workspaceId,
				workspaceRoot: params.workspaceRoot,
				cwd: params.cwd
			}
		};
	}

	const authorization = consumeTerminalCommandAuthorization(
		directAuthorization,
		params.input,
		params.workspaceId,
		{
			boundary: "approved_unsandboxed",
			commandLine: params.commandLine,
			cwd: params.cwd,
			externalTargets,
			networkAccess: directAuthorization?.crossSandbox?.networkAccess === true,
		}
	);
	if (!authorization.allowed) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `${sandboxInvocation.error} ${authorization.reason}`,
				code: "sandbox_unavailable",
				sandboxMode: sandboxInvocation.sandboxMode,
				workspaceId: params.workspaceId,
				workspaceRoot: params.workspaceRoot,
				cwd: params.cwd
			}
		};
	}

	return {
		ok: true,
		invocation: params.command.kind === "shell"
			? {
				...commonInvocation,
				command: params.command.commandLine,
				args: [],
				shell: true,
				env: createSandboxEnvironment(runtimeEnv),
				sandboxMode: "approved-unsandboxed",
				authorizationSource: authorization.source
			}
			: {
				...commonInvocation,
				command: params.command.command,
				args: [...params.command.args],
				env: createSandboxEnvironment(runtimeEnv),
				sandboxMode: "approved-unsandboxed",
				authorizationSource: authorization.source
			}
	};
}
