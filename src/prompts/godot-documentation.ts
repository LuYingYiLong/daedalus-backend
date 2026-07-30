import type { GodotDocumentationSettings } from "../godot-documentation/types.js";

export function createGodotDocumentationPromptSection(settings: GodotDocumentationSettings): string {
	const records = Object.values(settings.documents)
		.sort((left, right): number => left.branch.localeCompare(right.branch, undefined, { numeric: true }));
	if (!settings.enabled || records.length === 0) {
		return "";
	}

	const branches: string = records
		.map((record): string => `\`${record.branch}\`（commit \`${record.commitSha.slice(0, 12)}\`）`)
		.join("、");
	return [
		"## Godot 本地文档",
		`- 用户已启用本机离线 godot-docs：${branches}。文档查询是本地只读操作，不是联网搜索。`,
		"- 用户明确要求查询、检索、核对 Godot 文档或 API 时，必须通过 API `tool_calls` 调用 `mcp_godot_search_documentation`，不能直接凭记忆回答。",
		"- 未显式指定 `branch` 时，工具会按当前项目 Godot 主次版本选择最合适的已安装文档。",
		"- 只有本轮收到成功的文档工具结果后，才能说“已查询”“根据本地文档”或“文档显示”；没有工具结果、查询失败或没有命中时必须如实说明。",
		"- 回答应以工具返回的 `selected.branch`、符号、正文片段和 `sourceUrl` 为依据；不要补造结果中没有的成员、签名或引擎行为。",
		"- 不要在正文或 thinking 中输出 `<tool>`、`<tools>`、`<tool_call>`、`<tool_calls>`、DSML 或 JSON 工具协议；工具只能由 API `tool_calls` 发起。"
	].join("\n");
}
