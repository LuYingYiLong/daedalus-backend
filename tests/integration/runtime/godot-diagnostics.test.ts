import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContentLengthMessageParser, encodeContentLengthMessage } from "../../../src/mcp/content-length-protocol.js";
import { GodotDiagnosticsBridge } from "../../../src/mcp/godot/bridges/diagnostics-bridge.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

type FakeLspServer = {
	server: net.Server;
	port: number;
	close: () => Promise<void>;
};

type FakeDapServer = {
	server: net.Server;
	port: number;
	close: () => Promise<void>;
};

function asJsonText(result: Awaited<ReturnType<GodotDiagnosticsBridge["callTool"]>>): Record<string, unknown> {
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function sendMessage(socket: net.Socket, payload: unknown): void {
	socket.write(encodeContentLengthMessage(payload));
}

function getServerPort(server: net.Server): number {
	const address: string | AddressInfo | null = server.address();
	assert.equal(typeof address, "object");
	assert.notEqual(address, null);
	return (address as AddressInfo).port;
}

async function createTempWorkspace(): Promise<{ workspace: WorkspaceConfig; appDataDir: string; restoreAppData: () => void }> {
	const rootPath: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-workspace-"));
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-appdata-"));
	await fs.writeFile(path.join(rootPath, "project.godot"), [
		"[application]",
		"config/name=\"DiagnosticsTest\"",
		"config/features=PackedStringArray(\"4.7\")",
		""
	].join("\n"), "utf8");
	await fs.mkdir(path.join(rootPath, "scripts"), { recursive: true });
	await fs.writeFile(path.join(rootPath, "scripts", "broken.gd"), [
		"extends Node",
		"func _ready() -> void:",
		"\tprint(unknown_value)",
		""
	].join("\n"), "utf8");

	const previousAppData: string | undefined = process.env.APPDATA;
	process.env.APPDATA = appDataDir;
	const workspace: WorkspaceConfig = {
		id: "diagnostics-test",
		name: "Diagnostics Test",
		kind: "godot",
		rootPath,
		icon: 0,
		color: 0,
		sourceFolders: [{ id: "primary", path: rootPath, capabilities: { git: false, godot: true } }],
		primarySourceFolderId: "primary"
	};

	return {
		workspace,
		appDataDir,
		restoreAppData: (): void => {
			if (previousAppData === undefined) {
				delete process.env.APPDATA;
			} else {
				process.env.APPDATA = previousAppData;
			}
		}
	};
}

async function writeEditorSettings(appDataDir: string, lspPort: number, dapPort: number): Promise<void> {
	const godotConfigDir: string = path.join(appDataDir, "Godot");
	await fs.mkdir(godotConfigDir, { recursive: true });
	await fs.writeFile(path.join(godotConfigDir, "editor_settings-4.7.tres"), [
		"network/language_server/remote_host=\"127.0.0.1\"",
		`network/language_server/remote_port=${lspPort}`,
		`network/debug_adapter/remote_port=${dapPort}`,
		""
	].join("\n"), "utf8");
}

async function startFakeLspServer(): Promise<FakeLspServer> {
	const server: net.Server = net.createServer((socket: net.Socket): void => {
		const parser: ContentLengthMessageParser = new ContentLengthMessageParser();
		socket.on("data", (chunk: Buffer): void => {
			for (const message of parser.push(chunk)) {
				if (typeof message !== "object" || message === null || Array.isArray(message)) {
					continue;
				}

				const request = message as Record<string, unknown>;
				const id: unknown = request.id;
				const method: unknown = request.method;
				if (method === "initialize" && typeof id === "number") {
					sendMessage(socket, {
						jsonrpc: "2.0",
						id,
						result: {
							capabilities: {
								textDocumentSync: 1,
								documentSymbolProvider: true,
								hoverProvider: true,
								definitionProvider: true
							}
						}
					});
				} else if (method === "textDocument/didOpen") {
					const params = request.params as Record<string, unknown>;
					const textDocument = params.textDocument as Record<string, unknown>;
					sendMessage(socket, {
						jsonrpc: "2.0",
						method: "textDocument/publishDiagnostics",
						params: {
							uri: textDocument.uri,
							diagnostics: [
								{
									range: {
										start: { line: 2, character: 7 },
										end: { line: 2, character: 20 }
									},
									severity: 1,
									message: "Identifier not found: unknown_value",
									code: "unknown_identifier"
								}
							]
						}
					});
				} else if (method === "textDocument/documentSymbol" && typeof id === "number") {
					sendMessage(socket, {
						jsonrpc: "2.0",
						id,
						result: [
							{
								name: "_ready",
								kind: 12,
								range: {
									start: { line: 1, character: 0 },
									end: { line: 2, character: 21 }
								}
							}
						]
					});
				} else if (method === "textDocument/hover" && typeof id === "number") {
					sendMessage(socket, {
						jsonrpc: "2.0",
						id,
						result: {
							contents: {
								kind: "markdown",
								value: "Hover text"
							}
						}
					});
				} else if (method === "textDocument/definition" && typeof id === "number") {
					const params = request.params as Record<string, unknown>;
					const textDocument = params.textDocument as Record<string, unknown>;
					sendMessage(socket, {
						jsonrpc: "2.0",
						id,
						result: {
							uri: textDocument.uri,
							range: {
								start: { line: 1, character: 5 },
								end: { line: 1, character: 11 }
							}
						}
					});
				}
			}
		});
	});

	await new Promise<void>((resolve): void => {
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		server,
		port: getServerPort(server),
		close: async (): Promise<void> => {
			await new Promise<void>((resolve, reject): void => {
				server.close((error?: Error): void => error === undefined ? resolve() : reject(error));
			});
		}
	};
}

async function startFakeDapServer(): Promise<FakeDapServer> {
	const server: net.Server = net.createServer((socket: net.Socket): void => {
		const parser: ContentLengthMessageParser = new ContentLengthMessageParser();
		socket.on("data", (chunk: Buffer): void => {
			for (const message of parser.push(chunk)) {
				if (typeof message !== "object" || message === null || Array.isArray(message)) {
					continue;
				}

				const request = message as Record<string, unknown>;
				const seq: number = Number(request.seq);
				const command: string = String(request.command);
				const respond = (body: unknown = {}, success: boolean = true, messageText?: string): void => {
					const response: Record<string, unknown> = {
						type: "response",
						request_seq: seq,
						command,
						success,
						body
					};
					if (messageText !== undefined) {
						response.message = messageText;
					}
					sendMessage(socket, response);
				};

				if (command === "initialize") {
					respond({ supportsConfigurationDoneRequest: true });
					sendMessage(socket, { type: "event", event: "initialized", body: {} });
				} else if (command === "attach") {
					respond({});
					sendMessage(socket, { type: "event", event: "process", body: { name: "Godot", startMethod: "attach" } });
					sendMessage(socket, { type: "event", event: "stopped", body: { reason: "exception", description: "Fake runtime error" } });
				} else if (command === "threads") {
					respond({ threads: [{ id: 1, name: "Main Thread" }] });
				} else if (command === "stackTrace") {
					respond({
						stackFrames: [
							{
								id: 10,
								name: "_ready",
								source: { path: path.join("scripts", "broken.gd") },
								line: 3,
								column: 1
							}
						]
					});
				} else if (command === "scopes") {
					respond({
						scopes: [
							{ name: "Locals", variablesReference: 42 }
						]
					});
				} else if (command === "variables") {
					respond({
						variables: [
							{ name: "score", value: "12", type: "int", variablesReference: 0 }
						]
					});
				}
			}
		});
	});

	await new Promise<void>((resolve): void => {
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		server,
		port: getServerPort(server),
		close: async (): Promise<void> => {
			await new Promise<void>((resolve, reject): void => {
				server.close((error?: Error): void => error === undefined ? resolve() : reject(error));
			});
		}
	};
}

test("ContentLengthMessageParser handles split and coalesced messages", () => {
	const first: Buffer = encodeContentLengthMessage({ id: 1, value: "a" });
	const second: Buffer = encodeContentLengthMessage({ id: 2, value: "b" });
	const combined: Buffer = Buffer.concat([first, second]);
	const parser: ContentLengthMessageParser = new ContentLengthMessageParser();

	assert.deepEqual(parser.push(combined.subarray(0, 8)), []);
	const messages: unknown[] = parser.push(combined.subarray(8));
	assert.deepEqual(messages, [
		{ id: 1, value: "a" },
		{ id: 2, value: "b" }
	]);
});

test("GodotDiagnosticsBridge reads fake LSP diagnostics and symbols", async () => {
	const lspServer: FakeLspServer = await startFakeLspServer();
	const dapServer: FakeDapServer = await startFakeDapServer();
	const { workspace, appDataDir, restoreAppData } = await createTempWorkspace();
	await writeEditorSettings(appDataDir, lspServer.port, dapServer.port);

	const bridge: GodotDiagnosticsBridge = new GodotDiagnosticsBridge();
	bridge.setWorkspace(workspace);

	try {
		const diagnosticsResult: Record<string, unknown> = asJsonText(await bridge.callTool("lsp_get_file_diagnostics", {
			resourcePath: "scripts/broken.gd"
		}));
		assert.equal(diagnosticsResult.ok, true);
		const diagnostics = diagnosticsResult.diagnostics as Array<Record<string, unknown>>;
		assert.equal(diagnostics[0]!.lineStart, 3);
		assert.equal(diagnostics[0]!.severity, "error");

		const symbolsResult: Record<string, unknown> = asJsonText(await bridge.callTool("lsp_get_document_symbols", {
			resourcePath: "res://scripts/broken.gd"
		}));
		assert.equal(symbolsResult.ok, true);
		const symbols = symbolsResult.symbols as Array<Record<string, unknown>>;
		assert.equal(symbols[0]!.name, "_ready");
	} finally {
		restoreAppData();
		await lspServer.close();
		await dapServer.close();
	}
});

test("GodotDiagnosticsBridge reads fake DAP stack and variables", async () => {
	const lspServer: FakeLspServer = await startFakeLspServer();
	const dapServer: FakeDapServer = await startFakeDapServer();
	const { workspace, appDataDir, restoreAppData } = await createTempWorkspace();
	await writeEditorSettings(appDataDir, lspServer.port, dapServer.port);

	const bridge: GodotDiagnosticsBridge = new GodotDiagnosticsBridge();
	bridge.setWorkspace(workspace);

	try {
		const stackResult: Record<string, unknown> = asJsonText(await bridge.callTool("dap_get_stack_trace", {}));
		assert.equal(stackResult.ok, true);
		assert.equal(stackResult.running, true);
		const frames = stackResult.frames as Array<Record<string, unknown>>;
		assert.equal(frames[0]!.name, "_ready");

		const variablesResult: Record<string, unknown> = asJsonText(await bridge.callTool("dap_get_variables", {
			variablesReference: 42
		}));
		assert.equal(variablesResult.ok, true);
		const variables = variablesResult.variables as Array<Record<string, unknown>>;
		assert.equal(variables[0]!.name, "score");
	} finally {
		restoreAppData();
		await lspServer.close();
		await dapServer.close();
	}
});
