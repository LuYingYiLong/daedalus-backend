import { AsyncLocalStorage } from "node:async_hooks";

export type McpRequestContext = {
	workspaceId?: string | undefined;
	editorInstanceId?: string | undefined;
	sessionId?: string | undefined;
	requestId?: string | undefined;
	runId?: string | undefined;
	toolCallId?: string | undefined;
};

const mcpRequestContextStorage: AsyncLocalStorage<McpRequestContext> = new AsyncLocalStorage<McpRequestContext>();

export function getMcpRequestContext(): McpRequestContext | undefined {
	return mcpRequestContextStorage.getStore();
}

export function getCurrentMcpWorkspaceId(): string | undefined {
	return getMcpRequestContext()?.workspaceId;
}

export function getCurrentMcpEditorInstanceId(): string | undefined {
	return getMcpRequestContext()?.editorInstanceId;
}

export async function withMcpRequestContext<T>(context: McpRequestContext, run: () => Promise<T>): Promise<T> {
	return await mcpRequestContextStorage.run({
		...mcpRequestContextStorage.getStore(),
		...context
	}, run);
}
