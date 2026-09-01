export const GODOT_RUNTIME_START_TOOL_NAME: string = "mcp_godot_runtime_start";

export type GodotRuntimeStartIdentity = {
	requestId: string;
	toolCallId: string;
};

export type GodotRuntimeControlContext = {
	start(
		args: Record<string, unknown>,
		identity: GodotRuntimeStartIdentity,
		abortSignal?: AbortSignal | undefined,
	): Promise<Record<string, unknown>>;
};
