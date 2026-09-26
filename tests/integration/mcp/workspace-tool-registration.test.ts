import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocumentXml, createMinimalDocx } from "../../helpers/minimal-docx.js";
import { createWorkspaceToolCatalog } from "../../../src/tools/tool-catalog.js";

type ToolHandlerResult = {
	content: Array<{ type: string; text: string }>;
};

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolHandlerResult>;

type FakeMcpServer = {
	toolNames: string[];
	handlers: Map<string, ToolHandler>;
	registerTool(name: string, _config: unknown, handler: ToolHandler): void;
};

function createFakeServer(): FakeMcpServer {
	return {
		toolNames: [],
		handlers: new Map<string, ToolHandler>(),
		registerTool(name: string, _config: unknown, handler: ToolHandler): void {
			this.toolNames.push(name);
			this.handlers.set(name, handler);
		}
	};
}

test("workspace MCP registers read_docx behind a catalog-backed read mapping", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-workspace-mcp-"));
	try {
		process.env.WORKSPACE_ROOT = root;
		const { registerWorkspaceTools } = await import("../../../src/mcp/workspace/registration.js");
		const server: FakeMcpServer = createFakeServer();
		registerWorkspaceTools(server as never);

		const entry = createWorkspaceToolCatalog({ workspaceId: "workspace-read-docx" }).getEntry("mcp_workspace_read_docx");
		assert.deepEqual(entry?.mapping, { serverId: "workspace", toolName: "read_docx" });
		assert.equal(entry?.policy.risk, "read");
		assert.equal(
			server.toolNames.includes("read_docx"),
			true,
			"The LLM tool mapping must resolve to a tool the workspace MCP server actually registers."
		);

		await writeFile(
			join(root, "report.docx"),
			createMinimalDocx(createDocumentXml("<w:p><w:r><w:t>Title &amp; body</w:t></w:r></w:p><w:p><w:r><w:t>Details</w:t></w:r></w:p>"))
		);

		const handler: ToolHandler | undefined = server.handlers.get("read_docx");
		assert.notEqual(handler, undefined);
		if (handler === undefined) {
			throw new Error("read_docx handler was not registered");
		}
		const result: ToolHandlerResult = await handler({ relativePath: "report.docx", startParagraph: 1, endParagraph: 1 });
		const payload = JSON.parse(result.content[0]!.text) as {
			path: string;
			paragraphCount: number;
			startParagraph: number;
			endParagraph: number;
			charCount: number;
			text: string;
		};

		assert.equal(payload.path, "report.docx");
		assert.equal(payload.paragraphCount, 2);
		assert.deepEqual([payload.startParagraph, payload.endParagraph], [1, 1]);
		assert.equal(payload.text, "Title & body");
		assert.equal(payload.charCount, "Title & body".length);
	} finally {
		delete process.env.WORKSPACE_ROOT;
		await rm(root, { recursive: true, force: true });
	}
});
