import type { TerminalCommandResult } from "./types.js";

const HELPER_LAUNCH_ERROR: RegExp = /daedalus sandbox helper:\s*(?:sandbox command was not found|cannot start the sandboxed process|cannot resolve the Windows command processor|sandbox path does not have the expected type)/iu;
const COMMAND_NOT_FOUND: RegExp = /(?:is not recognized as an internal or external command|(?:^|\n)(?:\/bin\/sh|sh|bash):[^\n]*(?:command )?not found)/iu;

export function annotateTerminalEnvironmentFailure(result: TerminalCommandResult): TerminalCommandResult {
	if (result.ok || result.status === "cancelled" || result.status === "timed_out") return result;
	const output: string = result.stderr;
	if (!HELPER_LAUNCH_ERROR.test(output) && !COMMAND_NOT_FOUND.test(output) && result.status !== "spawn_error") return result;
	return {
		...result,
		validationStatus: "not_applicable",
		environmentIssue: true,
		applicabilityCode: "terminal_runtime_unavailable",
		notApplicableReason: "The command could not start in the selected terminal environment. Check the runtime path with get_terminal_capabilities, then declare externalAccess for any required external executable and pass required environment variables explicitly. Retrying the same command without changing its environment will not help."
	};
}
