import { consumeTerminalCommandAuthorization, type TerminalCommandAuthorization } from "./authorization.js";
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

export function resolveSandboxedProcessInvocation(params: {
	input: SandboxExecutionInput & Record<string, unknown>;
	command: SandboxCommand;
	commandLine: string;
	cwd: string;
	workspaceRoot: string;
	workspaceId?: string | undefined;
	env?: Record<string, string> | undefined;
	readOnlyPaths?: readonly string[] | undefined;
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

	const sandboxInvocation = createSandboxInvocation({
		command: params.command,
		cwd: params.cwd,
		workspaceRoot: params.workspaceRoot,
		env: params.env,
		readOnlyPaths: params.readOnlyPaths,
		runtime: params.runtime
	});
	if (sandboxInvocation.available) {
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
	if (!isUnsandboxedConsentText(params.input.__daedalusConsentText)) {
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

	const directAuthorization = consumeTerminalCommandAuthorization(
		params.input.__daedalusCommandAuthorization,
		params.input,
		params.workspaceId
	);
	if (!directAuthorization.allowed) {
		return {
			ok: false,
			result: {
				ok: false,
				error: `${sandboxInvocation.error} ${directAuthorization.reason}`,
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
				env: createSandboxEnvironment(params.env),
				sandboxMode: "approved-unsandboxed",
				authorizationSource: directAuthorization.source
			}
			: {
				...commonInvocation,
				command: params.command.command,
				args: [...params.command.args],
				env: createSandboxEnvironment(params.env),
				sandboxMode: "approved-unsandboxed",
				authorizationSource: directAuthorization.source
			}
	};
}
