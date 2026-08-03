import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGodotDocumentationTools } from "./registration.js";

export async function main(): Promise<void> {
	const server = new McpServer({
		name: "godot-documentation-server",
		version: "1.0.0"
	});

	registerGodotDocumentationTools(server);
	await server.connect(new StdioServerTransport());
	console.error("Godot Documentation MCP Server started");
}
