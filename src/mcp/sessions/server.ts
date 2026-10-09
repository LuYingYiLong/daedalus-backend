import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSessionTools } from "./registration.js";

export async function main(): Promise<void> {
	const server = new McpServer({ name: "daedalus-sessions", version: "1.0.0" });
	registerSessionTools(server);
	await server.connect(new StdioServerTransport());
}
