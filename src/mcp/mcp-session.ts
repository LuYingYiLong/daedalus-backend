import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./types.js";

export type McpCallToolOptions = {
	signal?: AbortSignal | undefined;
	timeoutMs?: number | undefined;
};

export class McpSession {
	private client: Client;
	private transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;

	constructor(private readonly config: McpServerConfig) {
		this.client = new Client({
			name: `daedalus-${config.id}-client`,
			version: "1.0.0"
		});
	}

	async connect(): Promise<void> {
		if (this.config.transport === "http") {
			if (this.config.url === undefined) {
				throw new Error(`HTTP MCP server has no URL: ${this.config.id}`);
			}

			this.transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
				requestInit: {
					headers: this.config.headers ?? {}
				}
			});
		} else {
			if (this.config.command === undefined) {
				throw new Error(`STDIO MCP server has no command: ${this.config.id}`);
			}

			this.transport = new StdioClientTransport({
				command: this.config.command,
				args: this.config.args ?? [],
				env: {
					...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
					...this.config.env
				} as Record<string, string>
			});
		}

		await this.client.connect(this.transport as unknown as Transport);
	}

	async listTools() {
		return this.client.listTools();
	}

	async callTool(name: string, args: Record<string, unknown>, options: McpCallToolOptions = {}) {
		return this.client.callTool({
			name,
			arguments: args
		}, undefined, {
			...(options.signal === undefined ? {} : { signal: options.signal }),
			...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs })
		});
	}

	async listResources() {
		return this.client.listResources();
	}

	async readResource(uri: string) {
		return this.client.readResource({ uri });
	}

	async close(): Promise<void> {
		await this.client.close();
	}

	get id(): string {
		return this.config.id;
	}

	get name(): string {
		return this.config.name;
	}

	get isCustom(): boolean {
		return this.config.custom === true;
	}
}
