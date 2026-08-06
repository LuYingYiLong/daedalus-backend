import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ContentLengthMessageParser, encodeContentLengthMessage } from "../../content-length-protocol.js";
import type { WorkspaceConfig } from "../../../workspace/types.js";

export const GODOT_DIAGNOSTICS_SERVER_ID: string = "godot_diagnostics";

const DEFAULT_LSP_HOST: string = "127.0.0.1";
const DEFAULT_LSP_PORT: number = 6005;
const DEFAULT_DAP_HOST: string = "127.0.0.1";
const DEFAULT_DAP_PORT: number = 6006;
const TCP_CONNECT_TIMEOUT_MS: number = 1200;
const REQUEST_TIMEOUT_MS: number = 3000;
const DIAGNOSTICS_WAIT_MS: number = 1200;
const DAP_EVENT_WAIT_MS: number = 300;
const MAX_DIAGNOSTICS: number = 100;
const MAX_SYMBOLS: number = 120;
const MAX_STACK_FRAMES: number = 30;
const MAX_VARIABLES: number = 80;
const MAX_TEXT_LENGTH: number = 1000;

type JsonObject = Record<string, unknown>;

type ToolTextResult = {
	content: Array<{
		type: "text";
		text: string;
	}>;
};

type Endpoint = {
	host: string;
	port: number;
	source: "editor_settings" | "default";
};

type DiagnosticsConfig = {
	lsp: Endpoint;
	dap: Endpoint;
	editorSettingsFile: string | null;
};

type CachedEndpointStatus = {
	host: string;
	port: number;
	source: string;
	available: boolean | null;
	lastCheckedAt: string | null;
	lastError: string | null;
};

type PendingJsonRpcRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

type PendingDapRequest = {
	resolve: (value: DapResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

type DapResponse = {
	type: "response";
	request_seq: number;
	command: string;
	success: boolean;
	message?: string;
	body?: unknown;
};

type ResolvedResourcePath = {
	resourcePath: string;
	absolutePath: string;
	uri: string;
};

type ConfigEntry = {
	fullKey: string;
	valueExpression: string;
};

type DiagnosticsUnavailableCode = "diagnostics_unavailable" | "workspace_unavailable";

/** Keeps live-editor transport gaps out of the generic tool-error path. */
class DiagnosticsUnavailableError extends Error {
	readonly applicabilityCode: DiagnosticsUnavailableCode;

	constructor(applicabilityCode: DiagnosticsUnavailableCode, message: string) {
		super(message);
		this.name = "DiagnosticsUnavailableError";
		this.applicabilityCode = applicabilityCode;
	}
}

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

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipText(value: unknown, maxLength: number = MAX_TEXT_LENGTH): string {
	const text: string = typeof value === "string" ? value : JSON.stringify(value);
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function getWindowsAppDataPath(): string | null {
	const appDataPath: string | undefined = process.env.APPDATA;
	if (appDataPath === undefined || appDataPath.trim().length === 0) {
		return null;
	}

	return appDataPath;
}

function getGodotConfigDir(): string | null {
	const appDataPath: string | null = getWindowsAppDataPath();
	return appDataPath === null ? null : path.join(appDataPath, "Godot");
}

function parseConfigEntries(content: string): ConfigEntry[] {
	const lines: string[] = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const entries: ConfigEntry[] = [];
	let currentSection: string = "";

	for (const line of lines) {
		const trimmedLine: string = line.trim();
		const sectionMatch: RegExpMatchArray | null = trimmedLine.match(/^\[([^\]]+)\]$/);
		if (sectionMatch !== null) {
			currentSection = sectionMatch[1]!.trim();
			continue;
		}

		if (trimmedLine.length === 0 || trimmedLine.startsWith(";")) {
			continue;
		}

		const equalsIndex: number = line.indexOf("=");
		if (equalsIndex < 0) {
			continue;
		}

		const name: string = line.slice(0, equalsIndex).trim();
		if (name.length === 0) {
			continue;
		}

		const fullKey: string = currentSection.length > 0 ? `${currentSection}/${name}` : name;
		entries.push({
			fullKey,
			valueExpression: line.slice(equalsIndex + 1).trim()
		});
	}

	return entries;
}

function createConfigMap(entries: ConfigEntry[]): Map<string, string> {
	return new Map(entries.map((entry: ConfigEntry): [string, string] => [entry.fullKey, entry.valueExpression]));
}

function parseStringExpression(valueExpression: string | undefined): string | undefined {
	if (valueExpression === undefined) {
		return undefined;
	}

	const trimmedValue: string = valueExpression.trim();
	if (trimmedValue.startsWith("\"") && trimmedValue.endsWith("\"")) {
		try {
			return JSON.parse(trimmedValue) as string;
		} catch {
			return trimmedValue.slice(1, -1);
		}
	}

	return trimmedValue;
}

function parseIntegerExpression(valueExpression: string | undefined, fallback: number): number {
	const trimmedValue: string | undefined = valueExpression?.trim();
	if (trimmedValue === undefined || !/^\d+$/.test(trimmedValue)) {
		return fallback;
	}

	const parsedValue: number = Number.parseInt(trimmedValue, 10);
	return parsedValue >= 1 && parsedValue <= 65535 ? parsedValue : fallback;
}

async function findEditorSettingsFile(projectRoot: string): Promise<string | null> {
	const configDir: string | null = getGodotConfigDir();
	if (configDir === null) {
		return null;
	}

	let preferredVersion: string | null = null;
	try {
		const projectConfig: string = await fs.readFile(path.join(projectRoot, "project.godot"), "utf8");
		const projectConfigMap: Map<string, string> = createConfigMap(parseConfigEntries(projectConfig));
		const featuresExpression: string | undefined = projectConfigMap.get("application/config/features") ?? projectConfigMap.get("config/features");
		const match: RegExpMatchArray | null = featuresExpression?.match(/"(\d+\.\d+)"/) ?? null;
		preferredVersion = match?.[1] ?? null;
	} catch {
		preferredVersion = null;
	}

	let fileNames: string[];
	try {
		fileNames = await fs.readdir(configDir);
	} catch {
		return null;
	}

	const settingsFiles: Array<{ fileName: string; version: string; major: number; minor: number }> = [];
	for (const fileName of fileNames) {
		const match: RegExpMatchArray | null = fileName.match(/^editor_settings-(\d+)(?:\.(\d+))?\.tres$/);
		if (match === null) {
			continue;
		}

		const major: number = Number.parseInt(match[1]!, 10);
		const minor: number = match[2] === undefined ? -1 : Number.parseInt(match[2], 10);
		settingsFiles.push({
			fileName,
			version: minor < 0 ? `${major}` : `${major}.${minor}`,
			major,
			minor
		});
	}

	settingsFiles.sort((left, right): number => {
		if (right.major !== left.major) {
			return right.major - left.major;
		}

		return right.minor - left.minor;
	});

	const selected = settingsFiles.find((file): boolean => file.version === preferredVersion) ?? settingsFiles[0];
	return selected === undefined ? null : path.join(configDir, selected.fileName);
}

async function resolveDiagnosticsConfig(workspace: WorkspaceConfig): Promise<DiagnosticsConfig> {
	const editorSettingsFile: string | null = await findEditorSettingsFile(workspace.rootPath);
	let editorSettings: Map<string, string> = new Map();

	if (editorSettingsFile !== null) {
		try {
			const content: string = await fs.readFile(editorSettingsFile, "utf8");
			editorSettings = createConfigMap(parseConfigEntries(content));
		} catch {
			editorSettings = new Map();
		}
	}

	const lspHost: string = parseStringExpression(editorSettings.get("network/language_server/remote_host")) ?? DEFAULT_LSP_HOST;
	const lspPort: number = parseIntegerExpression(editorSettings.get("network/language_server/remote_port"), DEFAULT_LSP_PORT);
	const dapPort: number = parseIntegerExpression(editorSettings.get("network/debug_adapter/remote_port"), DEFAULT_DAP_PORT);

	return {
		lsp: {
			host: lspHost,
			port: lspPort,
			source: editorSettings.has("network/language_server/remote_port") || editorSettings.has("network/language_server/remote_host") ? "editor_settings" : "default"
		},
		dap: {
			host: DEFAULT_DAP_HOST,
			port: dapPort,
			source: editorSettings.has("network/debug_adapter/remote_port") ? "editor_settings" : "default"
		},
		editorSettingsFile
	};
}

function ensureWorkspaceResourcePath(workspace: WorkspaceConfig, inputPath: string): ResolvedResourcePath {
	const trimmedPath: string = inputPath.trim();
	if (trimmedPath.length === 0) {
		throw new Error("resourcePath is required");
	}

	const projectRoot: string = path.resolve(workspace.rootPath);
	let absolutePath: string;

	if (trimmedPath.startsWith("res://")) {
		const relativePath: string = trimmedPath.slice("res://".length).replace(/^[/\\]+/, "");
		absolutePath = path.resolve(projectRoot, relativePath);
	} else if (path.isAbsolute(trimmedPath)) {
		absolutePath = path.resolve(trimmedPath);
	} else {
		absolutePath = path.resolve(projectRoot, trimmedPath);
	}

	const relativePath: string = path.relative(projectRoot, absolutePath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error(`resourcePath is outside the Godot project: ${inputPath}`);
	}

	const normalizedRelativePath: string = relativePath.split(path.sep).join("/");
	return {
		resourcePath: `res://${normalizedRelativePath}`,
		absolutePath,
		uri: pathToFileURL(absolutePath).href
	};
}

function uriToResourcePath(workspace: WorkspaceConfig, uri: unknown): string | null {
	if (typeof uri !== "string" || !uri.startsWith("file:")) {
		return typeof uri === "string" ? uri : null;
	}

	try {
		const absolutePath: string = fileURLToPath(uri);
		const projectRoot: string = path.resolve(workspace.rootPath);
		const relativePath: string = path.relative(projectRoot, absolutePath);
		if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
			return uri;
		}

		return `res://${relativePath.split(path.sep).join("/")}`;
	} catch {
		return uri;
	}
}

async function connectTcp(endpoint: Endpoint): Promise<net.Socket> {
	return await new Promise<net.Socket>((resolve, reject): void => {
		const socket: net.Socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
		let finished: boolean = false;
		const timeout: NodeJS.Timeout = setTimeout((): void => {
			if (finished) {
				return;
			}

			finished = true;
			socket.destroy();
			reject(new Error(`connection_timeout: ${endpoint.host}:${endpoint.port}`));
		}, TCP_CONNECT_TIMEOUT_MS);

		socket.once("connect", (): void => {
			if (finished) {
				return;
			}

			finished = true;
			clearTimeout(timeout);
			socket.setNoDelay(true);
			resolve(socket);
		});

		socket.once("error", (error: Error): void => {
			if (finished) {
				return;
			}

			finished = true;
			clearTimeout(timeout);
			reject(error);
		});
	});
}

class JsonRpcPeer {
	private readonly socket: net.Socket;
	private readonly parser: ContentLengthMessageParser = new ContentLengthMessageParser();
	private readonly pendingRequests: Map<number, PendingJsonRpcRequest> = new Map();
	private readonly notifications: JsonObject[] = [];
	private nextId: number = 1;

	constructor(socket: net.Socket) {
		this.socket = socket;
		this.socket.on("data", (chunk: Buffer): void => {
			for (const message of this.parser.push(chunk)) {
				this.handleMessage(message);
			}
		});
		this.socket.on("error", (error: Error): void => this.rejectAll(error));
		this.socket.on("close", (): void => this.rejectAll(new Error("connection_closed")));
	}

	async request(method: string, params: JsonObject = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
		const id: number = this.nextId;
		this.nextId += 1;
		const payload: JsonObject = {
			jsonrpc: "2.0",
			id,
			method,
			params
		};

		return await new Promise<unknown>((resolve, reject): void => {
			const timeout: NodeJS.Timeout = setTimeout((): void => {
				this.pendingRequests.delete(id);
				reject(new Error(`request_timeout: ${method}`));
			}, timeoutMs);
			this.pendingRequests.set(id, { resolve, reject, timeout });
			this.socket.write(encodeContentLengthMessage(payload));
		});
	}

	notify(method: string, params: JsonObject = {}): void {
		this.socket.write(encodeContentLengthMessage({
			jsonrpc: "2.0",
			method,
			params
		}));
	}

	async waitForNotification(predicate: (message: JsonObject) => boolean, timeoutMs: number): Promise<JsonObject | null> {
		const existing: JsonObject | undefined = this.notifications.find(predicate);
		if (existing !== undefined) {
			return existing;
		}

		return await new Promise<JsonObject | null>((resolve): void => {
			const startedAt: number = Date.now();
			const interval: NodeJS.Timeout = setInterval((): void => {
				const matched: JsonObject | undefined = this.notifications.find(predicate);
				if (matched !== undefined) {
					clearInterval(interval);
					resolve(matched);
					return;
				}

				if (Date.now() - startedAt >= timeoutMs) {
					clearInterval(interval);
					resolve(null);
				}
			}, 25);
		});
	}

	close(): void {
		this.socket.end();
		this.socket.destroy();
	}

	private handleMessage(message: unknown): void {
		if (!isRecord(message)) {
			return;
		}

		const idValue: unknown = message.id;
		if (typeof idValue === "number") {
			const pending: PendingJsonRpcRequest | undefined = this.pendingRequests.get(idValue);
			if (pending === undefined) {
				return;
			}

			this.pendingRequests.delete(idValue);
			clearTimeout(pending.timeout);
			if (isRecord(message.error)) {
				pending.reject(new Error(clipText(message.error["message"] ?? message.error["code"] ?? "LSP request failed")));
				return;
			}

			pending.resolve(message.result);
			return;
		}

		if (typeof message.method === "string") {
			this.notifications.push(message);
		}
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pendingRequests.entries()) {
			this.pendingRequests.delete(id);
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
	}
}

class DapPeer {
	private readonly socket: net.Socket;
	private readonly parser: ContentLengthMessageParser = new ContentLengthMessageParser();
	private readonly pendingRequests: Map<number, PendingDapRequest> = new Map();
	private readonly events: JsonObject[] = [];
	private nextSeq: number = 1;

	constructor(socket: net.Socket) {
		this.socket = socket;
		this.socket.on("data", (chunk: Buffer): void => {
			for (const message of this.parser.push(chunk)) {
				this.handleMessage(message);
			}
		});
		this.socket.on("error", (error: Error): void => this.rejectAll(error));
		this.socket.on("close", (): void => this.rejectAll(new Error("connection_closed")));
	}

	async request(command: string, args: JsonObject = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<DapResponse> {
		const seq: number = this.nextSeq;
		this.nextSeq += 1;
		const payload: JsonObject = {
			seq,
			type: "request",
			command,
			arguments: args
		};

		return await new Promise<DapResponse>((resolve, reject): void => {
			const timeout: NodeJS.Timeout = setTimeout((): void => {
				this.pendingRequests.delete(seq);
				reject(new Error(`request_timeout: ${command}`));
			}, timeoutMs);
			this.pendingRequests.set(seq, { resolve, reject, timeout });
			this.socket.write(encodeContentLengthMessage(payload));
		});
	}

	async waitForEvents(timeoutMs: number): Promise<JsonObject[]> {
		const startedLength: number = this.events.length;
		await new Promise<void>((resolve): void => {
			setTimeout(resolve, timeoutMs);
		});
		return this.events.slice(startedLength);
	}

	getEvents(): JsonObject[] {
		return [...this.events];
	}

	close(): void {
		this.socket.end();
		this.socket.destroy();
	}

	private handleMessage(message: unknown): void {
		if (!isRecord(message)) {
			return;
		}

		if (message.type === "response" && typeof message.request_seq === "number") {
			const pending: PendingDapRequest | undefined = this.pendingRequests.get(message.request_seq);
			if (pending === undefined) {
				return;
			}

			this.pendingRequests.delete(message.request_seq);
			clearTimeout(pending.timeout);
			pending.resolve(message as DapResponse);
			return;
		}

		if (message.type === "event") {
			this.events.push(message);
		}
	}

	private rejectAll(error: Error): void {
		for (const [seq, pending] of this.pendingRequests.entries()) {
			this.pendingRequests.delete(seq);
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
	}
}

function normalizeRange(range: unknown): JsonObject | null {
	if (!isRecord(range) || !isRecord(range.start) || !isRecord(range.end)) {
		return null;
	}

	return {
		lineStart: Number(range.start["line"] ?? 0) + 1,
		columnStart: Number(range.start["character"] ?? 0) + 1,
		lineEnd: Number(range.end["line"] ?? 0) + 1,
		columnEnd: Number(range.end["character"] ?? 0) + 1
	};
}

function normalizeDiagnostics(resourcePath: string, diagnosticsValue: unknown): JsonObject[] {
	if (!Array.isArray(diagnosticsValue)) {
		return [];
	}

	return diagnosticsValue.slice(0, MAX_DIAGNOSTICS).filter(isRecord).map((diagnostic: JsonObject): JsonObject => {
		const range: JsonObject | null = normalizeRange(diagnostic.range);
		return {
			resourcePath,
			severity: severityLabel(diagnostic.severity),
			message: clipText(diagnostic.message ?? ""),
			code: diagnostic.code ?? null,
			lineStart: range?.["lineStart"] ?? 1,
			columnStart: range?.["columnStart"] ?? 1,
			lineEnd: range?.["lineEnd"] ?? 1,
			columnEnd: range?.["columnEnd"] ?? 1
		};
	});
}

function severityLabel(value: unknown): string {
	if (value === 1) {
		return "error";
	}
	if (value === 2) {
		return "warning";
	}
	if (value === 3) {
		return "information";
	}
	if (value === 4) {
		return "hint";
	}

	return "unknown";
}

function normalizeSymbols(symbolsValue: unknown): JsonObject[] {
	if (!Array.isArray(symbolsValue)) {
		return [];
	}

	const output: JsonObject[] = [];
	const visit = (symbols: unknown[], depth: number): void => {
		for (const symbolValue of symbols) {
			if (output.length >= MAX_SYMBOLS || !isRecord(symbolValue)) {
				continue;
			}

			const range: JsonObject | null = normalizeRange(symbolValue.range);
			output.push({
				name: clipText(symbolValue.name ?? "", 200),
				kind: symbolValue.kind ?? null,
				detail: symbolValue.detail === undefined ? null : clipText(symbolValue.detail, 400),
				depth,
				lineStart: range?.["lineStart"] ?? null,
				columnStart: range?.["columnStart"] ?? null,
				lineEnd: range?.["lineEnd"] ?? null,
				columnEnd: range?.["columnEnd"] ?? null
			});

			if (Array.isArray(symbolValue.children)) {
				visit(symbolValue.children, depth + 1);
			}
		}
	};

	visit(symbolsValue, 0);
	return output;
}

function normalizeLocations(workspace: WorkspaceConfig, locationValue: unknown): JsonObject[] {
	const locations: unknown[] = Array.isArray(locationValue) ? locationValue : locationValue === null || locationValue === undefined ? [] : [locationValue];
	return locations.filter(isRecord).map((location: JsonObject): JsonObject => {
		const range: JsonObject | null = normalizeRange(location.range);
		return {
			uri: location.uri ?? null,
			resourcePath: uriToResourcePath(workspace, location.uri),
			lineStart: range?.["lineStart"] ?? null,
			columnStart: range?.["columnStart"] ?? null,
			lineEnd: range?.["lineEnd"] ?? null,
			columnEnd: range?.["columnEnd"] ?? null
		};
	});
}

function sourcePathToResourcePath(workspace: WorkspaceConfig, sourcePath: unknown): string | null {
	if (typeof sourcePath !== "string" || sourcePath.length === 0) {
		return null;
	}

	if (sourcePath.startsWith("res://")) {
		return sourcePath;
	}

	const absolutePath: string = path.isAbsolute(sourcePath)
		? path.resolve(sourcePath)
		: path.resolve(workspace.rootPath, sourcePath);
	const projectRoot: string = path.resolve(workspace.rootPath);
	const relativePath: string = path.relative(projectRoot, absolutePath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		return sourcePath;
	}

	return `res://${relativePath.split(path.sep).join("/")}`;
}

function normalizeDapFrame(workspace: WorkspaceConfig, frame: JsonObject): JsonObject {
	const source: unknown = frame.source;
	const sourcePath: unknown = isRecord(source) ? source.path : undefined;
	return {
		id: frame.id ?? null,
		name: clipText(frame.name ?? "", 300),
		resourcePath: sourcePathToResourcePath(workspace, sourcePath),
		sourcePath: typeof sourcePath === "string" ? sourcePath : null,
		line: frame.line ?? null,
		column: frame.column ?? null
	};
}

function normalizeDapVariable(variable: JsonObject): JsonObject {
	return {
		name: clipText(variable.name ?? "", 200),
		value: clipText(variable.value ?? "", 600),
		type: variable.type === undefined ? null : clipText(variable.type, 120),
		variablesReference: variable.variablesReference ?? 0,
		indexedVariables: variable.indexedVariables ?? null,
		namedVariables: variable.namedVariables ?? null
	};
}

export class GodotDiagnosticsBridge {
	private workspace?: WorkspaceConfig | undefined;
	private cachedLspStatus: CachedEndpointStatus = this.createDefaultCachedStatus(DEFAULT_LSP_HOST, DEFAULT_LSP_PORT, "default");
	private cachedDapStatus: CachedEndpointStatus = this.createDefaultCachedStatus(DEFAULT_DAP_HOST, DEFAULT_DAP_PORT, "default");

	setWorkspace(workspace: WorkspaceConfig): void {
		this.workspace = workspace;
		this.cachedLspStatus = this.createDefaultCachedStatus(DEFAULT_LSP_HOST, DEFAULT_LSP_PORT, "default");
		this.cachedDapStatus = this.createDefaultCachedStatus(DEFAULT_DAP_HOST, DEFAULT_DAP_PORT, "default");
	}

	clearWorkspace(workspaceId?: string): void {
		if (workspaceId !== undefined && this.workspace?.id !== workspaceId) {
			return;
		}

		this.workspace = undefined;
		this.cachedLspStatus = this.createDefaultCachedStatus(DEFAULT_LSP_HOST, DEFAULT_LSP_PORT, "default");
		this.cachedDapStatus = this.createDefaultCachedStatus(DEFAULT_DAP_HOST, DEFAULT_DAP_PORT, "default");
	}

	getCachedStatus(): JsonObject {
		return {
			serverId: GODOT_DIAGNOSTICS_SERVER_ID,
			workspaceId: this.workspace?.id ?? null,
			workspaceRoot: this.workspace?.rootPath ?? null,
			lsp: this.cachedLspStatus,
			dap: this.cachedDapStatus
		};
	}

	listTools() {
		return {
			tools: [
				{
					name: "lsp_get_status",
					description: "探测 Godot GDScript LSP 是否可用，并返回 host/port/最近错误。",
					inputSchema: { type: "object", properties: {}, required: [] }
				},
				{
					name: "lsp_get_file_diagnostics",
					description: "读取指定 GDScript 文件的 LSP 诊断，返回 1-based 行列。",
					inputSchema: {
						type: "object",
						properties: {
							resourcePath: { type: "string", description: "脚本路径，可用 res://、项目相对路径或项目内绝对路径。" }
						},
						required: ["resourcePath"]
					}
				},
				{
					name: "lsp_get_document_symbols",
					description: "读取指定 GDScript 文件的 document symbols 摘要。",
					inputSchema: {
						type: "object",
						properties: {
							resourcePath: { type: "string" }
						},
						required: ["resourcePath"]
					}
				},
				{
					name: "lsp_hover",
					description: "读取指定 GDScript 文件某个 1-based 行列位置的 hover 信息。",
					inputSchema: {
						type: "object",
						properties: {
							resourcePath: { type: "string" },
							line: { type: "integer" },
							column: { type: "integer" }
						},
						required: ["resourcePath", "line", "column"]
					}
				},
				{
					name: "lsp_goto_definition",
					description: "读取指定 GDScript 文件某个 1-based 行列位置的 definition 位置。",
					inputSchema: {
						type: "object",
						properties: {
							resourcePath: { type: "string" },
							line: { type: "integer" },
							column: { type: "integer" }
						},
						required: ["resourcePath", "line", "column"]
					}
				},
				{
					name: "dap_get_status",
					description: "探测 Godot DAP 是否可用，并只读检查是否可 attach 到当前运行会话。",
					inputSchema: { type: "object", properties: {}, required: [] }
				},
				{
					name: "dap_get_last_error",
					description: "只读读取当前 DAP stopped/output 事件和顶部调用栈摘要；不控制调试器。",
					inputSchema: { type: "object", properties: {}, required: [] }
				},
				{
					name: "dap_get_stack_trace",
					description: "只读读取当前运行会话调用栈和 frame scopes。",
					inputSchema: { type: "object", properties: {}, required: [] }
				},
				{
					name: "dap_get_variables",
					description: "只读读取 DAP variablesReference 对应变量摘要。",
					inputSchema: {
						type: "object",
						properties: {
							variablesReference: { type: "integer", description: "来自 dap_get_stack_trace scopes 或变量结果的 variablesReference。" }
						},
						required: ["variablesReference"]
					}
				}
			]
		};
	}

	listResources() {
		return {
			resources: [
				{
					uri: "godot-diagnostics://status",
					name: "Godot Diagnostics Status",
					mimeType: "application/json"
				}
			]
		};
	}

	readResource(uri: string) {
		if (uri !== "godot-diagnostics://status") {
			throw new Error(`Unknown godot_diagnostics resource: ${uri}`);
		}

		return {
			contents: [
				{
					uri,
					mimeType: "application/json",
					text: JSON.stringify(this.getCachedStatus(), null, 2)
				}
			]
		};
	}

	async callTool(name: string, args: JsonObject): Promise<ToolTextResult> {
		try {
			switch (name) {
				case "lsp_get_status":
					return jsonTextResult(await this.getLspStatus());
				case "lsp_get_file_diagnostics":
					return jsonTextResult(await this.getLspFileDiagnostics(this.getStringArg(args, "resourcePath")));
				case "lsp_get_document_symbols":
					return jsonTextResult(await this.getLspDocumentSymbols(this.getStringArg(args, "resourcePath")));
				case "lsp_hover":
					return jsonTextResult(await this.getLspHover(this.getStringArg(args, "resourcePath"), this.getIntegerArg(args, "line"), this.getIntegerArg(args, "column")));
				case "lsp_goto_definition":
					return jsonTextResult(await this.getLspDefinition(this.getStringArg(args, "resourcePath"), this.getIntegerArg(args, "line"), this.getIntegerArg(args, "column")));
				case "dap_get_status":
					return jsonTextResult(await this.getDapStatus());
				case "dap_get_last_error":
					return jsonTextResult(await this.getDapLastError());
				case "dap_get_stack_trace":
					return jsonTextResult(await this.getDapStackTrace());
				case "dap_get_variables":
					return jsonTextResult(await this.getDapVariables(this.getIntegerArg(args, "variablesReference")));
				default:
					throw new Error(`Unknown godot_diagnostics tool: ${name}`);
			}
		} catch (error: unknown) {
			if (error instanceof DiagnosticsUnavailableError) {
				return jsonTextResult({
					ok: false,
					validationStatus: "not_applicable",
					environmentIssue: true,
					applicabilityCode: error.applicabilityCode,
					notApplicableReason: error.message,
					error: {
						code: error.applicabilityCode,
						message: error.message
					}
				});
			}
			return jsonTextResult({
				ok: false,
				error: {
					code: "godot_diagnostics_error",
					message: error instanceof Error ? error.message : "Godot diagnostics tool failed"
				}
			});
		}
	}

	private async getLspStatus(): Promise<JsonObject> {
		const { config, peer } = await this.connectLsp();
		peer.close();
		this.markStatus("lsp", config.lsp, true, null);
		return {
			ok: true,
			available: true,
			endpoint: config.lsp,
			editorSettingsFile: config.editorSettingsFile
		};
	}

	private async getLspFileDiagnostics(resourcePathInput: string): Promise<JsonObject> {
		const workspace: WorkspaceConfig = this.requireWorkspace();
		const resolvedPath: ResolvedResourcePath = ensureWorkspaceResourcePath(workspace, resourcePathInput);
		const { config, peer } = await this.connectLsp();

		try {
			const diagnostics: JsonObject[] = await this.withOpenLspDocument(peer, resolvedPath, async (): Promise<JsonObject[]> => {
				const notification: JsonObject | null = await peer.waitForNotification((message: JsonObject): boolean => (
					message.method === "textDocument/publishDiagnostics"
					&& isRecord(message.params)
					&& message.params["uri"] === resolvedPath.uri
				), DIAGNOSTICS_WAIT_MS);

				if (notification === null || !isRecord(notification.params)) {
					return [];
				}

				return normalizeDiagnostics(resolvedPath.resourcePath, notification.params["diagnostics"]);
			});
			this.markStatus("lsp", config.lsp, true, null);
			return {
				ok: true,
				resourcePath: resolvedPath.resourcePath,
				diagnostics,
				truncated: diagnostics.length >= MAX_DIAGNOSTICS
			};
		} finally {
			peer.close();
		}
	}

	private async getLspDocumentSymbols(resourcePathInput: string): Promise<JsonObject> {
		const workspace: WorkspaceConfig = this.requireWorkspace();
		const resolvedPath: ResolvedResourcePath = ensureWorkspaceResourcePath(workspace, resourcePathInput);
		const { config, peer } = await this.connectLsp();

		try {
			const symbols: JsonObject[] = await this.withOpenLspDocument(peer, resolvedPath, async (): Promise<JsonObject[]> => {
				const result: unknown = await peer.request("textDocument/documentSymbol", {
					textDocument: { uri: resolvedPath.uri }
				});
				return normalizeSymbols(result);
			});
			this.markStatus("lsp", config.lsp, true, null);
			return {
				ok: true,
				resourcePath: resolvedPath.resourcePath,
				symbols,
				truncated: symbols.length >= MAX_SYMBOLS
			};
		} finally {
			peer.close();
		}
	}

	private async getLspHover(resourcePathInput: string, line: number, column: number): Promise<JsonObject> {
		const workspace: WorkspaceConfig = this.requireWorkspace();
		const resolvedPath: ResolvedResourcePath = ensureWorkspaceResourcePath(workspace, resourcePathInput);
		const { config, peer } = await this.connectLsp();

		try {
			const hover: unknown = await this.withOpenLspDocument(peer, resolvedPath, async (): Promise<unknown> => await peer.request("textDocument/hover", {
				textDocument: { uri: resolvedPath.uri },
				position: {
					line: Math.max(0, line - 1),
					character: Math.max(0, column - 1)
				}
			}));
			this.markStatus("lsp", config.lsp, true, null);
			return {
				ok: true,
				resourcePath: resolvedPath.resourcePath,
				line,
				column,
				hover: hover === null ? null : clipText(hover, 3000)
			};
		} finally {
			peer.close();
		}
	}

	private async getLspDefinition(resourcePathInput: string, line: number, column: number): Promise<JsonObject> {
		const workspace: WorkspaceConfig = this.requireWorkspace();
		const resolvedPath: ResolvedResourcePath = ensureWorkspaceResourcePath(workspace, resourcePathInput);
		const { config, peer } = await this.connectLsp();

		try {
			const definition: unknown = await this.withOpenLspDocument(peer, resolvedPath, async (): Promise<unknown> => await peer.request("textDocument/definition", {
				textDocument: { uri: resolvedPath.uri },
				position: {
					line: Math.max(0, line - 1),
					character: Math.max(0, column - 1)
				}
			}));
			this.markStatus("lsp", config.lsp, true, null);
			return {
				ok: true,
				resourcePath: resolvedPath.resourcePath,
				line,
				column,
				locations: normalizeLocations(workspace, definition)
			};
		} finally {
			peer.close();
		}
	}

	private async getDapStatus(): Promise<JsonObject> {
		const { config, peer } = await this.connectDap();
		try {
			const attachResponse: DapResponse = await peer.request("attach", { project: this.requireWorkspace().rootPath });
			const running: boolean = attachResponse.success;
			this.markStatus("dap", config.dap, true, running ? null : attachResponse.message ?? "not_running");
			return {
				ok: true,
				available: true,
				running,
				endpoint: config.dap,
				attach: this.summarizeDapResponse(attachResponse),
				editorSettingsFile: config.editorSettingsFile
			};
		} finally {
			peer.close();
		}
	}

	private async getDapLastError(): Promise<JsonObject> {
		const stackResult: JsonObject = await this.getDapStackTrace();
		if (stackResult.ok !== true) {
			return stackResult;
		}

		const events: unknown = stackResult["events"];
		const stoppedEvents: JsonObject[] = Array.isArray(events)
			? events.filter(isRecord).filter((event: JsonObject): boolean => event.event === "stopped")
			: [];
		return {
			ok: true,
			running: stackResult["running"],
			lastStoppedEvent: stoppedEvents.at(-1) ?? null,
			topFrame: Array.isArray(stackResult["frames"]) ? stackResult["frames"][0] ?? null : null,
			frames: stackResult["frames"] ?? [],
			events: stackResult["events"] ?? []
		};
	}

	private async getDapStackTrace(): Promise<JsonObject> {
		const workspace: WorkspaceConfig = this.requireWorkspace();
		const { config, peer } = await this.connectDap();
		try {
			const attachResponse: DapResponse = await peer.request("attach", { project: workspace.rootPath });
			if (!attachResponse.success) {
				this.markStatus("dap", config.dap, true, attachResponse.message ?? "not_running");
				return {
					ok: true,
					running: false,
					endpoint: config.dap,
					attach: this.summarizeDapResponse(attachResponse),
					frames: [],
					events: peer.getEvents()
				};
			}

			await peer.waitForEvents(DAP_EVENT_WAIT_MS);
			const threadsResponse: DapResponse = await peer.request("threads", {});
			const threads: JsonObject[] = this.extractDapArray(threadsResponse.body, "threads");
			const threadId: unknown = threads[0]?.["id"] ?? 1;
			const stackResponse: DapResponse = await peer.request("stackTrace", {
				threadId,
				startFrame: 0,
				levels: MAX_STACK_FRAMES
			});
			const rawFrames: JsonObject[] = this.extractDapArray(stackResponse.body, "stackFrames");
			const frames: JsonObject[] = [];
			for (const rawFrame of rawFrames.slice(0, MAX_STACK_FRAMES)) {
				const frame: JsonObject = normalizeDapFrame(workspace, rawFrame);
				if (typeof rawFrame.id === "number") {
					const scopesResponse: DapResponse = await peer.request("scopes", { frameId: rawFrame.id }).catch((error: unknown): DapResponse => ({
						type: "response",
						request_seq: -1,
						command: "scopes",
						success: false,
						message: error instanceof Error ? error.message : "scopes failed"
					}));
					frame["scopes"] = scopesResponse.success ? this.extractDapArray(scopesResponse.body, "scopes") : [];
				} else {
					frame["scopes"] = [];
				}
				frames.push(frame);
			}

			this.markStatus("dap", config.dap, true, null);
			return {
				ok: true,
				running: true,
				endpoint: config.dap,
				threads,
				frames,
				events: peer.getEvents()
			};
		} finally {
			peer.close();
		}
	}

	private async getDapVariables(variablesReference: number): Promise<JsonObject> {
		if (!Number.isInteger(variablesReference) || variablesReference <= 0) {
			throw new Error("variablesReference must be a positive integer");
		}

		const { config, peer } = await this.connectDap();
		try {
			const attachResponse: DapResponse = await peer.request("attach", { project: this.requireWorkspace().rootPath });
			if (!attachResponse.success) {
				this.markStatus("dap", config.dap, true, attachResponse.message ?? "not_running");
				return {
					ok: true,
					running: false,
					endpoint: config.dap,
					variablesReference,
					variables: [],
					attach: this.summarizeDapResponse(attachResponse)
				};
			}

			const variablesResponse: DapResponse = await peer.request("variables", { variablesReference });
			if (!variablesResponse.success) {
				return {
					ok: false,
					error: {
						code: "dap_variables_failed",
						message: variablesResponse.message ?? "variables request failed"
					},
					variablesReference
				};
			}

			const variables: JsonObject[] = this.extractDapArray(variablesResponse.body, "variables")
				.slice(0, MAX_VARIABLES)
				.map(normalizeDapVariable);
			this.markStatus("dap", config.dap, true, null);
			return {
				ok: true,
				running: true,
				endpoint: config.dap,
				variablesReference,
				variables,
				truncated: variables.length >= MAX_VARIABLES
			};
		} finally {
			peer.close();
		}
	}

	private async connectLsp(): Promise<{ config: DiagnosticsConfig; peer: JsonRpcPeer }> {
		const workspace: WorkspaceConfig = this.requireWorkspace();
		const config: DiagnosticsConfig = await resolveDiagnosticsConfig(workspace);
		try {
			const socket: net.Socket = await connectTcp(config.lsp);
			const peer: JsonRpcPeer = new JsonRpcPeer(socket);
			await peer.request("initialize", {
				processId: process.pid,
				rootPath: workspace.rootPath,
				rootUri: pathToFileURL(path.resolve(workspace.rootPath)).href,
				capabilities: {
					textDocument: {
						publishDiagnostics: {
							relatedInformation: true
						}
					}
				},
				workspaceFolders: [
					{
						uri: pathToFileURL(path.resolve(workspace.rootPath)).href,
						name: path.basename(workspace.rootPath)
					}
				]
			});
			peer.notify("initialized", {});
			return { config, peer };
		} catch (error: unknown) {
			this.markStatus("lsp", config.lsp, false, error instanceof Error ? error.message : "lsp_unavailable");
			throw new DiagnosticsUnavailableError(
				"diagnostics_unavailable",
				`lsp_unavailable: ${error instanceof Error ? error.message : "Godot LSP is not available"}`
			);
		}
	}

	private async connectDap(): Promise<{ config: DiagnosticsConfig; peer: DapPeer }> {
		const workspace: WorkspaceConfig = this.requireWorkspace();
		const config: DiagnosticsConfig = await resolveDiagnosticsConfig(workspace);
		try {
			const socket: net.Socket = await connectTcp(config.dap);
			const peer: DapPeer = new DapPeer(socket);
			const initializeResponse: DapResponse = await peer.request("initialize", {
				adapterID: "godot",
				clientID: "godot-daedalus",
				clientName: "Godot Daedalus",
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: "path",
				supportsVariableType: true,
				supportsInvalidatedEvent: true,
				supportsRunInTerminalRequest: false
			});
			if (!initializeResponse.success) {
				throw new Error(initializeResponse.message ?? "DAP initialize failed");
			}
			return { config, peer };
		} catch (error: unknown) {
			this.markStatus("dap", config.dap, false, error instanceof Error ? error.message : "dap_unavailable");
			throw new DiagnosticsUnavailableError(
				"diagnostics_unavailable",
				`dap_unavailable: ${error instanceof Error ? error.message : "Godot DAP is not available"}`
			);
		}
	}

	private async withOpenLspDocument<T>(peer: JsonRpcPeer, resolvedPath: ResolvedResourcePath, callback: () => Promise<T>): Promise<T> {
		const text: string = await fs.readFile(resolvedPath.absolutePath, "utf8");
		peer.notify("textDocument/didOpen", {
			textDocument: {
				uri: resolvedPath.uri,
				languageId: "gdscript",
				version: 1,
				text
			}
		});

		try {
			return await callback();
		} finally {
			peer.notify("textDocument/didClose", {
				textDocument: {
					uri: resolvedPath.uri
				}
			});
		}
	}

	private extractDapArray(body: unknown, key: string): JsonObject[] {
		if (!isRecord(body) || !Array.isArray(body[key])) {
			return [];
		}

		return body[key].filter(isRecord);
	}

	private summarizeDapResponse(response: DapResponse): JsonObject {
		return {
			success: response.success,
			command: response.command,
			message: response.message ?? null,
			error: isRecord(response.body) ? response.body["error"] ?? null : null
		};
	}

	private markStatus(kind: "lsp" | "dap", endpoint: Endpoint, available: boolean, error: string | null): void {
		const status: CachedEndpointStatus = {
			host: endpoint.host,
			port: endpoint.port,
			source: endpoint.source,
			available,
			lastCheckedAt: new Date().toISOString(),
			lastError: error
		};
		if (kind === "lsp") {
			this.cachedLspStatus = status;
		} else {
			this.cachedDapStatus = status;
		}
	}

	private createDefaultCachedStatus(host: string, port: number, source: string): CachedEndpointStatus {
		return {
			host,
			port,
			source,
			available: null,
			lastCheckedAt: null,
			lastError: null
		};
	}

	private requireWorkspace(): WorkspaceConfig {
		if (this.workspace === undefined) {
			throw new DiagnosticsUnavailableError("workspace_unavailable", "godot_diagnostics_unavailable: no active workspace");
		}

		return this.workspace;
	}

	private getStringArg(args: JsonObject, key: string): string {
		const value: unknown = args[key];
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new Error(`${key} must be a non-empty string`);
		}

		return value;
	}

	private getIntegerArg(args: JsonObject, key: string): number {
		const value: unknown = args[key];
		if (!Number.isInteger(value)) {
			throw new Error(`${key} must be an integer`);
		}

		return Number(value);
	}
}
