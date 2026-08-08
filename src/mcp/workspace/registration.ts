import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWorkspaceFileService } from "../../workspace/files.js";

function asJsonTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(value, null, 2)
		}]
	};
}

function asTextResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{ type: "text", text }]
	};
}

const workspaceRootText: string | undefined = process.env.WORKSPACE_ROOT;
if (workspaceRootText === undefined || workspaceRootText.trim().length === 0) {
	console.error("WORKSPACE_ROOT environment variable is required");
	process.exit(1);
}

const service = createWorkspaceFileService({
	rootPath: workspaceRootText
});

const listFilesSchema = z.object({
	subdir: z.string().optional().describe("Workspace relative directory to list."),
	extensions: z.array(z.string()).optional().describe("Optional extension filter, for example ['.ts', '.tsx']."),
	includeIgnored: z.boolean().optional().describe("Include normally ignored heavy/internal directories."),
	limit: z.number().int().positive().max(500).optional().describe("Maximum file count. Results are paged; use continuationToken for more.")
});

const readFileSchema = z.object({
	relativePath: z.string().min(1).describe("Workspace relative file path."),
	startLine: z.number().int().positive().optional().describe("Optional 1-based first line to read."),
	endLine: z.number().int().positive().optional().describe("Optional 1-based last line to read, inclusive.")
});

const searchTextSchema = z.object({
	query: z.string().min(1).describe("Text to search for."),
	extensions: z.array(z.string()).optional().describe("Optional extension filter."),
	limit: z.number().int().positive().max(500).optional().describe("Maximum match count.")
});

const writeFileSchema = z.object({
	relativePath: z.string().min(1).describe("Workspace relative file path."),
	content: z.string().describe("Complete UTF-8 text content.")
});

const replaceTextSchema = z.object({
	relativePath: z.string().min(1).describe("Workspace relative file path."),
	oldText: z.string().min(1).describe("Exact text to replace. Whitespace must match."),
	newText: z.string().describe("Replacement text.")
});

const replaceLineSchema = z.object({
	relativePath: z.string().min(1).describe("Workspace relative file path."),
	lineNumber: z.number().int().positive().describe("1-based line number to replace."),
	expectedText: z.string().describe("Exact current line text. Used to prevent stale line edits."),
	newText: z.string().describe("Replacement line text.")
});

const downloadFileSchema = z.object({
	url: z.string().url().describe("HTTPS URL to download. Credentials are not allowed."),
	relativePath: z.string().min(1).describe("Workspace-relative destination path."),
	dependency: z.string().min(1).max(240).describe("Short dependency name shown in the approval card."),
	purpose: z.string().min(1).max(1000).describe("Why the current task needs this download."),
	criticality: z.enum(["required", "recommended", "optional"]),
	expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/u).optional().describe("Optional SHA-256 checksum in hexadecimal."),
	overwrite: z.boolean().optional().describe("Allow replacing an existing file. Defaults to false.")
});

export function registerWorkspaceTools(server: McpServer): void {
	server.registerTool(
		"list_files",
		{
			title: "List Workspace Files",
			description: "List files under the active workspace. Paths are always workspace relative.",
			inputSchema: listFilesSchema
		},
		async (input) => asJsonTextResult(await service.listFilesDetailed(input))
	);

	server.registerTool(
		"read_text_file",
		{
			title: "Read Workspace Text File",
			description: "Read a UTF-8 text file inside the active workspace with path and size checks.",
			inputSchema: readFileSchema
		},
		async (input) => asTextResult(await service.readTextFile(input.relativePath, input))
	);

	server.registerTool(
		"search_text",
		{
			title: "Search Workspace Text",
			description: "Search text in workspace files and return matching files and line numbers.",
			inputSchema: searchTextSchema
		},
		async (input) => asJsonTextResult({ matches: await service.searchText(input) })
	);

	server.registerTool(
		"propose_create_text_file",
		{
			title: "Propose Create Workspace Text File",
			description: "Validate a new text file without writing it.",
			inputSchema: writeFileSchema
		},
		async ({ relativePath, content }) => {
			const validation = await service.validateNewTextFile(relativePath, content);
			return asJsonTextResult({
				valid: validation.valid,
				path: validation.path,
				size: content.length,
				errors: validation.errors,
				preview: content.slice(0, 500) + (content.length > 500 ? "\n..." : "")
			});
		}
	);

	server.registerTool(
		"create_text_file",
		{
			title: "Create Workspace Text File",
			description: "Create a new UTF-8 text file inside the active workspace. This writes to disk.",
			inputSchema: writeFileSchema
		},
		async ({ relativePath, content }) => asJsonTextResult(await service.createTextFile(relativePath, content))
	);

	server.registerTool(
		"propose_overwrite_text_file",
		{
			title: "Propose Overwrite Workspace Text File",
			description: "Validate overwriting an existing text file without writing it.",
			inputSchema: writeFileSchema
		},
		async ({ relativePath, content }) => {
			const validation = await service.validateOverwriteTextFile(relativePath, content);
			return asJsonTextResult({
				valid: validation.valid,
				path: validation.path,
				size: content.length,
				oldSize: validation.oldSize ?? null,
				errors: validation.errors,
				preview: content.slice(0, 500) + (content.length > 500 ? "\n..." : "")
			});
		}
	);

	server.registerTool(
		"overwrite_text_file",
		{
			title: "Overwrite Workspace Text File",
			description: "Overwrite an existing UTF-8 text file inside the active workspace. This writes to disk.",
			inputSchema: writeFileSchema
		},
		async ({ relativePath, content }) => asJsonTextResult(await service.overwriteTextFile(relativePath, content))
	);

	server.registerTool(
		"propose_replace_text_in_file",
		{
			title: "Propose Replace Workspace Text",
			description: "Validate replacing exact text in an existing file without writing it.",
			inputSchema: replaceTextSchema
		},
		async ({ relativePath, oldText, newText }) => {
			try {
				const content = await service.readTextFile(relativePath);
				if (!content.includes(oldText)) {
					return asJsonTextResult({ valid: false, failureCode: "replace_target_not_found", path: relativePath, errors: ["oldText not found in file"] });
				}
				const nextContent = content.replace(oldText, newText);
				return asJsonTextResult({
					valid: true,
					path: relativePath,
					occurrences: content.split(oldText).length - 1,
					oldLength: content.length,
					newLength: nextContent.length,
					preview: nextContent.slice(0, 500) + (nextContent.length > 500 ? "\n..." : "")
				});
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Path validation failed"]
				});
			}
		}
	);

	server.registerTool(
		"replace_text_in_file",
		{
			title: "Replace Workspace Text",
			description: "Replace the first exact text occurrence in an existing workspace file. This writes to disk.",
			inputSchema: replaceTextSchema
		},
		async ({ relativePath, oldText, newText }) => asJsonTextResult(await service.replaceTextInFile(relativePath, oldText, newText))
	);

	server.registerTool(
		"propose_replace_line_in_file",
		{
			title: "Propose Replace Workspace Line",
			description: "Validate replacing one 1-based line using expectedText without writing it.",
			inputSchema: replaceLineSchema
		},
		async ({ relativePath, lineNumber, expectedText, newText }) => {
			try {
				const content = await service.readTextFile(relativePath);
				const lines = content.split(/\r?\n/u);
				const currentLine: string | undefined = lines[lineNumber - 1];
				if (currentLine === undefined) {
					return asJsonTextResult({ valid: false, path: relativePath, errors: [`lineNumber is outside file: ${lineNumber}`] });
				}
				if (currentLine !== expectedText) {
					return asJsonTextResult({ valid: false, path: relativePath, errors: ["expectedText does not match the current line"], currentLine });
				}
				lines[lineNumber - 1] = newText;
				const preview = lines.join(content.includes("\r\n") ? "\r\n" : "\n");
				return asJsonTextResult({
					valid: true,
					path: relativePath,
					lineNumber,
					oldLength: content.length,
					newLength: preview.length,
					preview: preview.slice(0, 500) + (preview.length > 500 ? "\n..." : "")
				});
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Path validation failed"]
				});
			}
		}
	);

	server.registerTool(
		"replace_line_in_file",
		{
			title: "Replace Workspace Line",
			description: "Replace one 1-based line if expectedText matches the current line. This writes to disk.",
			inputSchema: replaceLineSchema
		},
		async ({ relativePath, lineNumber, expectedText, newText }) =>
			asJsonTextResult(await service.replaceLineInFile(relativePath, lineNumber, expectedText, newText))
	);

	server.registerTool(
		"download_file",
		{
			title: "Download Workspace File",
			description: "Download one HTTPS file into the active workspace. This writes a file but never installs or runs it.",
			inputSchema: downloadFileSchema
		},
		async ({ url, relativePath, expectedSha256, overwrite }) => asJsonTextResult(await service.downloadFile({
			url,
			relativePath,
			expectedSha256,
			overwrite
		}))
	);

	server.registerTool(
		"delete_file",
		{
			title: "Delete Workspace File",
			description: "Delete a file inside the active workspace. This is destructive.",
			inputSchema: readFileSchema
		},
		async ({ relativePath }) => asJsonTextResult(await service.deleteFile(relativePath))
	);
}
