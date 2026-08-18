import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./types.js";
import type { McpProgressNotification } from "./terminal/progress.js";

export type McpCallToolOptions = {
	signal?: AbortSignal | undefined;
	timeoutMs?: number | undefined;
	onProgress?: ((progress: McpProgressNotification) => void) | undefined;
};

const WINDOWS_MCP_ENV_ALLOWLIST: readonly string[] = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA"
];
const UNIX_MCP_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL"];

export function createMcpProcessEnvironment(
	configuredEnv: Record<string, string> | undefined,
	sourceEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform
): Record<string, string> {
	const allowedNames: readonly string[] = platform === "win32" ? WINDOWS_MCP_ENV_ALLOWLIST : UNIX_MCP_ENV_ALLOWLIST;
	const inheritedEnvironment: Record<string, string> = {};
	for (const name of allowedNames) {
		const value: string | undefined = sourceEnv[name];
		if (value !== undefined) inheritedEnvironment[name] = value;
	}
	return {
		...inheritedEnvironment,
		...(configuredEnv ?? {})
	};
}

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
				env: createMcpProcessEnvironment(this.config.env)
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
			...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
			...(options.onProgress === undefined ? {} : {
				onprogress: options.onProgress,
				resetTimeoutOnProgress: true
			})
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
