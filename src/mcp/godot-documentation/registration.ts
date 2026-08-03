import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchGodotDocumentation } from "../../godot-documentation/search.js";

export const GODOT_DOCUMENTATION_MCP_TOOL_NAMES: readonly string[] = ["search_documentation"];

function asJsonTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
	};
}

export function registerGodotDocumentationTools(server: McpServer): void {
	server.registerTool(
		"search_documentation",
		{
			title: "Search Local Godot Documentation",
			description: "Search user-imported offline godot-docs Class Reference and manuals. Use this before guessing an uncertain Godot API.",
			inputSchema: z.object({
				query: z.string().min(1).max(500).describe("Godot class, method, property, concept, or natural-language query."),
				branch: z.string().min(1).max(120).optional().describe("Optional installed godot-docs branch. Omit to match the current project version."),
				scope: z.enum(["all", "class_reference", "manual"]).optional().describe("Defaults to all."),
				limit: z.number().int().min(1).max(8).optional().describe("Maximum results, defaults to 5."),
				__daedalusProjectVersion: z.string().regex(/^\d+\.\d+$/u).optional()
			})
		},
		async ({ query, branch, scope, limit, __daedalusProjectVersion }) => {
			return asJsonTextResult(await searchGodotDocumentation({
				query,
				branch,
				scope,
				limit,
				projectVersion: __daedalusProjectVersion
			}));
		}
	);
}
