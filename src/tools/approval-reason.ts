export const APPROVAL_REASON_ARG: string = "approvalReason";

const MAX_APPROVAL_REASON_CHARS: number = 500;

export const APPROVAL_REASON_SCHEMA_PROPERTY: Record<string, unknown> = {
	type: "string",
	description: "Explain to the user why this write or high-risk tool call is needed, including its purpose and impact. Do not make the user infer this from the arguments."
};

export function getApprovalReasonFromArgs(args: Record<string, unknown>, fallback: string): string {
	const value: unknown = args[APPROVAL_REASON_ARG];
	if (typeof value !== "string") {
		return fallback;
	}

	const trimmed: string = value.trim();
	return trimmed.length > 0 ? trimmed.slice(0, MAX_APPROVAL_REASON_CHARS) : fallback;
}

export function stripApprovalReasonArg(args: Record<string, unknown>): Record<string, unknown> {
	if (!(APPROVAL_REASON_ARG in args)) {
		return args;
	}

	const { [APPROVAL_REASON_ARG]: _approvalReason, ...strippedArgs } = args;
	return strippedArgs;
}
