import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEditorConfigTools } from "./tools/editor-config.js";
import { registerProjectFileResources, registerProjectFileTools } from "./tools/project-files.js";
import { registerProjectLogTools } from "./tools/project-logs.js";
import { registerProjectAnalysisTools } from "./tools/project-analysis-tools.js";
import { registerProjectSemanticTools } from "./tools/project-semantic-tools.js";
import { registerProjectSettingsTools } from "./tools/project-settings.js";
import { registerHeadlessOperationTools } from "./tools/headless-operations.js";
import { registerRuntimeTools } from "./tools/runtime-tools.js";
import { registerSceneTools } from "./tools/scene-tools.js";

export function registerGodotToolsAndResources(server: McpServer): void {
	registerRuntimeTools(server);
	registerProjectFileTools(server);
	registerProjectLogTools(server);
	registerProjectSettingsTools(server);
	registerProjectSemanticTools(server);
	registerProjectAnalysisTools(server);
	registerEditorConfigTools(server);
	registerHeadlessOperationTools(server);
	registerProjectFileResources(server);
	registerSceneTools(server);
}
