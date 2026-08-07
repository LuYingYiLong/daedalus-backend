import WebSocket from "ws";
import { createToolFailure, StructuredToolError } from "../../../tools/tool-failure.js";
import { randomUUID } from "node:crypto";
import type { ServerEvent } from "../../../protocol/types.js";
import { getCurrentMcpEditorInstanceId, getCurrentMcpWorkspaceId } from "../../request-context.js";

export const GODOT_EDITOR_SERVER_ID: string = "godot_editor";

const EDITOR_TOOL_TIMEOUT_MS: number = 30_000;
const EDITOR_CONTEXT_STALE_MS: number = 15_000;

type JsonObject = Record<string, unknown>;

type ToolTextResult = {
	content: Array<{
		type: "text";
		text: string;
	}>;
};

type PendingEditorToolCall = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
	editorInstanceId: string;
};

type EditorConnection = {
	socket: WebSocket;
	workspaceId: string;
	editorInstanceId: string;
	clientName?: string | undefined;
	context: JsonObject;
	updatedAtMs: number;
};

export type GodotEditorInstanceSummary = {
	workspaceId: string;
	editorInstanceId: string;
	online: boolean;
	updatedAt: string | null;
	ageMs: number | null;
	activeScenePath: string | null;
	clientName?: string | undefined;
};

function jsonTextResult(value: unknown): ToolTextResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}
		]
	};
}

function createEditorUnavailableResult(): ToolTextResult {
	return jsonTextResult({
		ok: false,
		error: {
			code: "editor_unavailable",
			message: "Godot editor client is not connected or has not reported live context yet."
		}
	});
}

function isSocketOpen(socket: WebSocket | undefined): socket is WebSocket {
	return socket !== undefined && socket.readyState === WebSocket.OPEN;
}

export class GodotEditorBridge {
	private connectionsByInstanceId: Map<string, EditorConnection> = new Map();
	private pendingToolCalls: Map<string, PendingEditorToolCall> = new Map();
	private lastEditorEventSequence: number = 0;

	attachSocket(_socket: WebSocket): void {
		// 连接不再自动成为 Godot editor。只有 editor.context.update 会注册 editor instance。
	}

	detachSocket(socket: WebSocket): void {
		const detachedEditorIds: Set<string> = new Set();
		for (const [editorInstanceId, connection] of this.connectionsByInstanceId.entries()) {
			if (connection.socket === socket) {
				this.connectionsByInstanceId.delete(editorInstanceId);
				detachedEditorIds.add(editorInstanceId);
			}
		}

		if (detachedEditorIds.size === 0) {
			return;
		}

		for (const [callId, pending] of this.pendingToolCalls.entries()) {
			if (!detachedEditorIds.has(pending.editorInstanceId)) {
				continue;
			}
			clearTimeout(pending.timeout);
			pending.reject(new Error(`editor_unavailable: editor disconnected before tool result (${callId})`));
			this.pendingToolCalls.delete(callId);
		}
	}

	updateContext(context: JsonObject): void {
		this.updateInstanceContext(undefined, undefined, undefined, context);
	}

	updateInstanceContext(
		socket: WebSocket | undefined,
		workspaceId: string | undefined,
		editorInstanceId: string | undefined,
		context: JsonObject,
		clientName?: string | undefined
	): GodotEditorInstanceSummary {
		const resolvedWorkspaceId: string = workspaceId ?? getCurrentMcpWorkspaceId() ?? "workspace:legacy";
		const resolvedEditorInstanceId: string = editorInstanceId ?? getCurrentMcpEditorInstanceId() ?? `legacy:${resolvedWorkspaceId}`;
		const existing: EditorConnection | undefined = this.connectionsByInstanceId.get(resolvedEditorInstanceId);
		if (socket === undefined && existing === undefined) {
			throw new Error("editor_unavailable: editor context update has no socket");
		}

		const connection: EditorConnection = {
			socket: socket ?? existing!.socket,
			workspaceId: resolvedWorkspaceId,
			editorInstanceId: resolvedEditorInstanceId,
			clientName: clientName ?? existing?.clientName,
			context: {
				...context,
				workspaceId: resolvedWorkspaceId,
				editorInstanceId: resolvedEditorInstanceId,
				online: true
			},
			updatedAtMs: Date.now()
		};
		this.connectionsByInstanceId.set(resolvedEditorInstanceId, connection);
		return this.createInstanceSummary(connection);
	}

	handleToolResult(callId: string, ok: boolean, result: unknown, error: unknown): boolean {
		const pending: PendingEditorToolCall | undefined = this.pendingToolCalls.get(callId);
		if (pending === undefined) {
			return false;
		}

		this.pendingToolCalls.delete(callId);
		clearTimeout(pending.timeout);

		if (ok) {
			pending.resolve(result ?? { ok: true });
			return true;
		}

		pending.reject(new StructuredToolError(createToolFailure(
			error ?? "Godot editor tool failed"
		)));
		return true;
	}

	isOnline(workspaceId?: string | undefined, editorInstanceId?: string | undefined): boolean {
		const connection: EditorConnection | null = this.selectConnection(workspaceId, editorInstanceId, false);
		return connection !== null && this.isConnectionOnline(connection);
	}

	getActiveScenePath(): string | undefined {
		const connection: EditorConnection | null = this.selectConnection(undefined, undefined, false);
		const scenePath: unknown = connection?.context.activeScenePath;
		return typeof scenePath === "string" && scenePath.trim().length > 0 ? scenePath : undefined;
	}

	supportsTool(toolName: string, workspaceId?: string | undefined, editorInstanceId?: string | undefined): boolean {
		const connection: EditorConnection | null = this.selectConnection(workspaceId, editorInstanceId, false);
		if (connection === null || !this.isConnectionOnline(connection)) {
			return false;
		}

		if (toolName !== "capture_scene_view") {
			return true;
		}

		const capabilities: unknown = connection.context.capabilities;
		return capabilities !== null
			&& typeof capabilities === "object"
			&& !Array.isArray(capabilities)
			&& (capabilities as Record<string, unknown>).sceneViewCapture === true;
	}

	async refreshFilesystem(changedPaths: string[], workspaceId?: string | undefined): Promise<unknown[] | null> {
		const connections: EditorConnection[] = this.selectRefreshConnections(workspaceId);
		if (connections.length === 0) {
			return null;
		}

		const args: JsonObject = {
			changedPaths,
			scanSources: true
		};
		const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(
			connections.map((connection: EditorConnection): Promise<unknown> => this.requestEditorToolForConnection(connection, "refresh_filesystem", args))
		);
		const rejected: PromiseRejectedResult | undefined = results.find((result: PromiseSettledResult<unknown>): result is PromiseRejectedResult => result.status === "rejected");
		if (rejected !== undefined) {
			throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
		}

		return results.map((result: PromiseSettledResult<unknown>): unknown => result.status === "fulfilled" ? result.value : null);
	}

	listInstances(workspaceId?: string | undefined): GodotEditorInstanceSummary[] {
		return Array.from(this.connectionsByInstanceId.values())
			.filter((connection: EditorConnection): boolean => workspaceId === undefined
				|| connection.workspaceId === workspaceId
				|| connection.workspaceId?.startsWith(`${workspaceId}::`) === true)
			.map((connection: EditorConnection): GodotEditorInstanceSummary => this.createInstanceSummary(connection));
	}

	listTools() {
		const tools = [
				{
					name: "get_context",
					description: "返回 Godot 编辑器在线状态、当前场景、选择节点、脚本选区、文件系统选择和上下文新鲜度。",
					inputSchema: {
						type: "object",
						properties: {},
						required: []
					}
				},
				{
					name: "get_selected_nodes",
					description: "读取当前在线 Godot 编辑器中的多个选中节点摘要。",
					inputSchema: {
						type: "object",
						properties: {},
						required: []
					}
				},
				{
					name: "inspect_node",
					description: "检查在线 Godot 编辑器当前未保存状态里的指定节点结构。",
					inputSchema: {
						type: "object",
						properties: {
							scenePath: {
								type: "string",
								description: "可选场景路径；为空时使用当前打开场景。"
							},
							nodePath: {
								type: "string",
								description: "相对当前场景根节点的 NodePath，例如 '.'、'CanvasLayer/Button'。"
							}
						},
						required: ["nodePath"]
					}
				},
				{
					name: "capture_scene_view",
					description: "截取当前 Godot 2D 或 3D 编辑器场景视口。截图只读，供后端视觉模型解释。",
					inputSchema: {
						type: "object",
						properties: {
							view: {
								type: "string",
								enum: ["auto", "2d", "3d"],
								description: "默认 auto；无法唯一确定视口时需指定 2d 或 3d。"
							}
						},
						required: []
					}
				},
				{
					name: "apply_scene_patch",
					description: "在在线 Godot 编辑器中应用场景 patch，使用 EditorUndoRedoManager 形成一个可撤销动作。",
					inputSchema: {
						type: "object",
						properties: {
							title: {
								type: "string",
								description: "UndoRedo 动作标题。"
							},
							scenePath: {
								type: "string",
								description: "可选场景路径；为空时使用当前打开场景。"
							},
							saveAfter: {
								type: "boolean",
								description: "提交动作后是否保存当前场景，默认 true。"
							},
							operations: {
								type: "array",
								minItems: 1,
								maxItems: 50,
								items: {
									type: "object",
									properties: {
										type: {
											type: "string",
											enum: ["set_property", "add_node", "rename_node", "attach_script", "connect_signal"]
										}
									},
									additionalProperties: true
								}
							}
						},
						required: ["operations"]
					}
				}
		];
		return {
			tools: this.supportsTool("capture_scene_view")
				? tools
				: tools.filter((tool): boolean => tool.name !== "capture_scene_view")
		};
	}

	listResources() {
		return {
			resources: [
				{
					uri: "godot-editor://context",
					name: "Godot Editor Live Context",
					mimeType: "application/json"
				}
			]
		};
	}

	readResource(uri: string) {
		if (uri !== "godot-editor://context") {
			throw new Error(`Unknown godot_editor resource: ${uri}`);
		}

		return {
			contents: [
				{
					uri,
					mimeType: "application/json",
					text: JSON.stringify(this.createContextSnapshot(), null, 2)
				}
			]
		};
	}

	async callTool(
		name: string,
		args: JsonObject,
		workspaceId?: string | undefined,
		editorInstanceId?: string | undefined
	): Promise<ToolTextResult> {
		if (name === "get_context") {
			const connection: EditorConnection | null = this.selectConnection(workspaceId, editorInstanceId, false);
			return jsonTextResult(this.createContextSnapshot(connection, workspaceId));
		}

		if (name === "get_selected_nodes") {
			const connection: EditorConnection | null = this.selectConnection(workspaceId, editorInstanceId, false);
			if (connection === null || !this.isConnectionOnline(connection)) {
				return createEditorUnavailableResult();
			}

			return jsonTextResult({
				ok: true,
				selectedNodes: connection.context.selectedNodes ?? [],
				context: this.createContextSnapshot(connection, workspaceId)
			});
		}

		if (name !== "inspect_node" && name !== "apply_scene_patch" && name !== "capture_scene_view") {
			throw new Error(`Unknown godot_editor tool: ${name}`);
		}

		const result: unknown = await this.requestEditorTool(name, args, workspaceId, editorInstanceId);
		return jsonTextResult({
			ok: true,
			result
		});
	}

	private createContextSnapshot(
		connection: EditorConnection | null = this.selectConnection(undefined, undefined, false),
		workspaceId?: string | undefined
	): JsonObject {
		const ageMs: number | null = connection !== null && connection.updatedAtMs > 0 ? Date.now() - connection.updatedAtMs : null;
		const online: boolean = connection !== null && this.isConnectionOnline(connection);
		return {
			online,
			stale: ageMs === null || ageMs > EDITOR_CONTEXT_STALE_MS,
			updatedAt: connection !== null && connection.updatedAtMs > 0 ? new Date(connection.updatedAtMs).toISOString() : null,
			ageMs,
			context: online && connection !== null ? connection.context : {},
			instances: this.listInstances(workspaceId ?? getCurrentMcpWorkspaceId()),
			error: online ? null : "editor_unavailable"
		};
	}

	private createInstanceSummary(connection: EditorConnection): GodotEditorInstanceSummary {
		const ageMs: number | null = connection.updatedAtMs > 0 ? Date.now() - connection.updatedAtMs : null;
		const activeScenePath: unknown = connection.context.activeScenePath;
		return {
			workspaceId: connection.workspaceId,
			editorInstanceId: connection.editorInstanceId,
			online: this.isConnectionOnline(connection),
			updatedAt: connection.updatedAtMs > 0 ? new Date(connection.updatedAtMs).toISOString() : null,
			ageMs,
			activeScenePath: typeof activeScenePath === "string" && activeScenePath.trim().length > 0 ? activeScenePath : null,
			clientName: connection.clientName
		};
	}

	private isConnectionOnline(connection: EditorConnection): boolean {
		return isSocketOpen(connection.socket) && connection.updatedAtMs > 0;
	}

	private selectConnection(
		workspaceId: string | undefined,
		editorInstanceId: string | undefined,
		throwOnAmbiguous: boolean
	): EditorConnection | null {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId();
		const resolvedEditorInstanceId: string | undefined = editorInstanceId ?? getCurrentMcpEditorInstanceId();
		if (resolvedEditorInstanceId !== undefined) {
			return this.connectionsByInstanceId.get(resolvedEditorInstanceId) ?? null;
		}

		const candidates: EditorConnection[] = Array.from(this.connectionsByInstanceId.values())
			.filter((connection: EditorConnection): boolean => resolvedWorkspaceId === undefined || connection.workspaceId === resolvedWorkspaceId)
			.filter((connection: EditorConnection): boolean => this.isConnectionOnline(connection));
		if (candidates.length === 0) {
			return null;
		}
		if (candidates.length > 1 && throwOnAmbiguous) {
			throw new Error("editor_target_required: multiple Godot editors are online for this workspace; bind session.editor.bind first.");
		}

		return candidates.sort((a: EditorConnection, b: EditorConnection): number => b.updatedAtMs - a.updatedAtMs)[0] ?? null;
	}

	private requestEditorTool(
		toolName: string,
		args: JsonObject,
		workspaceId?: string | undefined,
		editorInstanceId?: string | undefined
	): Promise<unknown> {
		let connection: EditorConnection | null;
		try {
			connection = this.selectConnection(workspaceId, editorInstanceId, true);
		} catch (error: unknown) {
			return Promise.reject(error instanceof Error ? error : new Error("editor_target_required"));
		}

		if (connection === null || !this.isConnectionOnline(connection)) {
			return Promise.reject(new Error("editor_unavailable: Godot editor client is not connected"));
		}

		return this.requestEditorToolForConnection(connection, toolName, args);
	}

	private selectRefreshConnections(workspaceId?: string | undefined): EditorConnection[] {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId();
		return Array.from(this.connectionsByInstanceId.values())
			.filter((connection: EditorConnection): boolean => this.isConnectionOnline(connection))
			.filter((connection: EditorConnection): boolean => resolvedWorkspaceId === undefined || connection.workspaceId === resolvedWorkspaceId);
	}

	private requestEditorToolForConnection(connection: EditorConnection, toolName: string, args: JsonObject): Promise<unknown> {
		const callId: string = `editor-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		return new Promise<unknown>((resolve, reject): void => {
			const timeout: NodeJS.Timeout = setTimeout((): void => {
				this.pendingToolCalls.delete(callId);
				const connectionStillOnline: boolean = this.connectionsByInstanceId.get(connection.editorInstanceId) === connection
					&& this.isConnectionOnline(connection);
				reject(new Error(connectionStillOnline
					? `editor_tool_timeout: ${toolName}; Godot editor remains connected but did not return a result within ${EDITOR_TOOL_TIMEOUT_MS}ms`
					: `editor_unavailable: editor disconnected while waiting for ${toolName}`));
			}, EDITOR_TOOL_TIMEOUT_MS);

			this.pendingToolCalls.set(callId, {
				resolve,
				reject,
				timeout,
				editorInstanceId: connection.editorInstanceId
			});

			try {
				const wallClockFloor: number = Date.now() * 1000;
				this.lastEditorEventSequence = Math.max(wallClockFloor, this.lastEditorEventSequence + 1);
				const envelope: ServerEvent = {
					protocolVersion: 3,
					type: "event",
					eventId: `event-${randomUUID()}`,
					event: "editor.tool.requested",
					sessionId: "",
					requestId: callId,
					runId: callId,
					sequence: this.lastEditorEventSequence,
					createdAt: new Date().toISOString(),
					data: {
						callId,
						toolName,
						args,
						workspaceId: connection.workspaceId,
						editorInstanceId: connection.editorInstanceId
					}
				};
				connection.socket.send(JSON.stringify(envelope));
			} catch (error: unknown) {
				this.pendingToolCalls.delete(callId);
				clearTimeout(timeout);
				reject(error instanceof Error ? error : new Error("editor_tool_send_failed"));
			}
		});
	}
}
