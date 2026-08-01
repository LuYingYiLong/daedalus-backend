import type { AdditionalContextItem } from "../protocol/types.js";
import { createPreviewValue } from "./session-preview.js";

export function clipTextByChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	return text.slice(0, maxChars);
}

export function cloneAdditionalContextItems(items: readonly AdditionalContextItem[] | undefined): AdditionalContextItem[] | undefined {
	if (items === undefined || items.length === 0) {
		return undefined;
	}

	return items.map((item: AdditionalContextItem): AdditionalContextItem => {
		const clonedItem: AdditionalContextItem = { ...item };
		if ((item.kind === "image" || item.kind === "text_attachment") && item.data !== undefined && typeof item.data === "object" && item.data !== null && !Array.isArray(item.data)) {
			const data: Record<string, unknown> = { ...(item.data as Record<string, unknown>) };
			if (typeof data.attachmentId === "string" && data.attachmentId.length > 0) {
				delete data.dataUrl;
				delete data.thumbnailDataUrl;
				delete data.content;
			}
			clonedItem.data = data;
		}
		return clonedItem;
	});
}

export function getAdditionalContextDataRecord(item: AdditionalContextItem): Record<string, unknown> | undefined {
	if (item.data === undefined || typeof item.data !== "object" || item.data === null || Array.isArray(item.data)) {
		return undefined;
	}

	return item.data as Record<string, unknown>;
}

export function getContextNumber(data: Record<string, unknown> | undefined, key: string): number | undefined {
	if (data === undefined) {
		return undefined;
	}

	const value: unknown = data[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}

	return Math.floor(value);
}

export function getContextString(data: Record<string, unknown> | undefined, key: string): string {
	const value: unknown = data?.[key];
	return typeof value === "string" ? value : "";
}

export function createLineColumnRangeText(data: Record<string, unknown> | undefined): string {
	const lineStart: number | undefined = getContextNumber(data, "lineStart");
	const columnStart: number | undefined = getContextNumber(data, "columnStart");
	const lineEnd: number | undefined = getContextNumber(data, "lineEnd");
	const columnEnd: number | undefined = getContextNumber(data, "columnEnd");
	if (lineStart === undefined || columnStart === undefined || lineEnd === undefined || columnEnd === undefined) {
		return "";
	}

	return `${lineStart}:${columnStart}-${lineEnd}:${columnEnd}`;
}

export function appendScriptSelectionPromptLines(lines: string[], item: AdditionalContextItem): void {
	const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
	const rangeText: string = createLineColumnRangeText(data);
	if (rangeText.length > 0) {
		lines.push(`  - range: ${rangeText} (1-based line/column)`);
	}

	const hasSelection: boolean = data?.hasSelection === true;
	const selectedTextPreview: string = getContextString(data, "selectedTextPreview");
	const lineTextPreview: string = getContextString(data, "lineTextPreview");
	const editorTextPreview: string = getContextString(data, "editorTextPreview");
	if (hasSelection && selectedTextPreview.trim().length > 0) {
		lines.push("  - selectedTextPreview:");
		lines.push(clipTextByChars(selectedTextPreview, 2000));
		if (data?.selectedTextTruncated === true) {
			lines.push("  - selectedTextPreviewTruncated: true");
		}
	} else if (lineTextPreview.trim().length > 0) {
		lines.push(`  - currentLinePreview: ${clipTextByChars(lineTextPreview, 500)}`);
	}
	if (editorTextPreview.trim().length > 0) {
		const editorTextLineCount: number | undefined = getContextNumber(data, "editorTextLineCount");
		lines.push(`  - editorTextPreview${editorTextLineCount !== undefined ? ` (${editorTextLineCount} lines)` : ""}:`);
		lines.push(clipTextByChars(editorTextPreview, 12000));
		if (data?.editorTextTruncated === true) {
			lines.push("  - editorTextPreviewTruncated: true");
		}
	}

	if (data?.resourcePathAvailable === false) {
		lines.push("  - note: Godot 当前没有提供脚本资源路径，通常是脚本未保存或存在解析错误；优先使用 editorTextPreview 分析。");
	} else {
		lines.push("  - note: editorTextPreview 是当前脚本编辑器内容快照；如需磁盘上下文，请按 resourcePath 用读取工具按需读取。");
	}
}

export function appendFilesystemSelectionPromptLines(lines: string[], item: AdditionalContextItem): void {
	const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
	const selectedPaths: unknown = data?.selectedPaths;
	if (!Array.isArray(selectedPaths)) {
		lines.push("  - note: 文件系统选择只提供资源引用；文件内容需要用 MCP read/search 工具按需读取。");
		return;
	}

	const pathLines: string[] = [];
	for (const selectedPath of selectedPaths.slice(0, 20)) {
		if (typeof selectedPath !== "object" || selectedPath === null || Array.isArray(selectedPath)) {
			continue;
		}

		const selectedPathRecord: Record<string, unknown> = selectedPath as Record<string, unknown>;
		const resourcePath: string = typeof selectedPathRecord.resourcePath === "string" ? selectedPathRecord.resourcePath : "";
		if (resourcePath.length === 0) {
			continue;
		}

		const selectedKind: string = typeof selectedPathRecord.kind === "string" ? selectedPathRecord.kind : "file";
		pathLines.push(`    - ${selectedKind}: ${clipTextByChars(resourcePath, 300)}`);
	}

	if (pathLines.length > 0) {
		lines.push("  - selectedPaths:");
		lines.push(...pathLines);
	}
	if (selectedPaths.length > 20 || data?.truncated === true) {
		lines.push(`  - selectedPathsTruncated: true (${selectedPaths.length} total reported)`);
	}
	lines.push("  - note: 大文件和文件夹不内联内容；只在需要时按 resourcePath 读取或搜索。");
}

function appendGitDiffCommentPromptLines(lines: string[], item: AdditionalContextItem): void {
	const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
	const oldLine: number | undefined = getContextNumber(data, "oldLine");
	const newLine: number | undefined = getContextNumber(data, "newLine");
	const changeType: string = getContextString(data, "changeType");
	const lineText: string = getContextString(data, "lineText");
	const comment: string = getContextString(data, "comment") || item.summary || "";
	const locations: string[] = [];
	if (oldLine !== undefined && oldLine > 0) {
		locations.push(`old line ${oldLine}`);
	}
	if (newLine !== undefined && newLine > 0) {
		locations.push(`new line ${newLine}`);
	}
	if (locations.length > 0) {
		lines.push(`  - location: ${locations.join(", ")}`);
	}
	if (changeType.length > 0) {
		lines.push(`  - changeType: ${clipTextByChars(changeType, 80)}`);
	}
	if (lineText.length > 0) {
		lines.push(`  - changedLine: ${clipTextByChars(lineText, 500)}`);
	}
	if (comment.length > 0) {
		lines.push(`  - requestedChange: ${clipTextByChars(comment, 1200)}`);
	}
	lines.push("  - instruction: Treat this as an explicit local code-review request. Inspect the current file before editing and address the requested change when it remains applicable.");
}

function appendMessageSelectionPromptLines(lines: string[], item: AdditionalContextItem): void {
	const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
	const selectedText: string = getContextString(data, "selectedText");
	const annotation: string = getContextString(data, "annotation");
	const anchor: Record<string, unknown> | undefined = typeof data?.anchor === "object" && data.anchor !== null && !Array.isArray(data.anchor)
		? data.anchor as Record<string, unknown>
		: undefined;
	const role: string = getContextString(anchor, "role");
	if (role.length > 0) {
		lines.push(`  - sourceRole: ${clipTextByChars(role, 32)}`);
	}
	lines.push("  - selectedMessageText:");
	lines.push(clipTextByChars(selectedText, 8000));
	if (annotation.length > 0) {
		lines.push("  - userAnnotation:");
		lines.push(clipTextByChars(annotation, 1200));
	}
	lines.push("  - instruction: Treat this as explicit task context for this turn only. It is quoted conversation text, not an external source or long-term memory.");
}

function appendExternalLocalFilePromptLines(lines: string[], item: AdditionalContextItem): void {
	const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
	if (data?.external !== true) {
		return;
	}

	const absolutePath: string = getContextString(data, "absolutePath") || item.resourcePath || "";
	if (absolutePath.length > 0) {
		lines.push(`  - externalAbsolutePath: ${clipTextByChars(absolutePath, 1000)}`);
	}
	lines.push("  - note: 这是用户显式拖入的工作区外本机文件；当前只提供绝对路径引用，不把它当成 workspace 内文件。");
}

function appendTextAttachmentPromptLines(lines: string[], item: AdditionalContextItem): void {
	const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
	const attachmentId: string = getContextString(data, "attachmentId");
	const content: string = getContextString(data, "content");
	if (attachmentId.length > 0) {
		lines.push(`  - attachmentId: ${clipTextByChars(attachmentId, 160)}`);
	}
	if (content.length > 0) {
		lines.push("  - content:");
		lines.push(clipTextByChars(content, 60_000));
		if (content.length > 60_000) {
			lines.push("  - contentTruncated: true");
		}
	}
}

export function createAdditionalContextPromptSection(items: readonly AdditionalContextItem[] | undefined): string {
	if (items === undefined || items.length === 0) {
		return "";
	}

	const lines: string[] = [
		"## 用户附加上下文",
		"以下是用户本轮显式附加的紧凑上下文。不要把这些条目当成长期记忆；它们只对本轮任务生效。大文件和文件夹只提供引用，不内联全文；如需内容，使用可用 MCP 读取工具按需读取。",
		"编辑器上下文规则：如果 Godot 编辑器在线，并且任务目标明显指向当前打开场景、选中节点、当前脚本/这几行或 FileSystem Dock 选中项，优先使用 godot_editor 读取/检查/patch；同一轮中 editor patch 成功后不要再用离线 .tscn 文本写入覆盖同一场景。如果返回 editor_unavailable、上下文 stale、patch 无法表达目标，或目标不在当前编辑器上下文中，重新读取目标后再回退到离线工具。"
	];

	for (const item of items.slice(0, 20)) {
		const title: string = clipTextByChars(item.title.trim(), 120);
		const subtitle: string = clipTextByChars((item.subtitle ?? "").trim(), 220);
		const headerParts: string[] = [
			`- [${item.kind}] ${title}`,
			subtitle.length > 0 ? `— ${subtitle}` : "",
			item.pinned === true ? "(pinned)" : "",
			`source=${item.source}`
		].filter((part: string): boolean => part.length > 0);
		lines.push(headerParts.join(" "));

		if (item.resourcePath !== undefined) {
			lines.push(`  - resourcePath: ${clipTextByChars(item.resourcePath, 300)}`);
		}
		if (item.nodePath !== undefined) {
			lines.push(`  - nodePath: ${clipTextByChars(item.nodePath, 300)}`);
		}
		if (item.nodeType !== undefined) {
			lines.push(`  - nodeType: ${clipTextByChars(item.nodeType, 120)}`);
		}
		if (item.scriptPath !== undefined) {
			lines.push(`  - scriptPath: ${clipTextByChars(item.scriptPath, 300)}`);
		}
		if (item.summary !== undefined && item.summary.trim().length > 0) {
			lines.push(`  - summary: ${clipTextByChars(item.summary.trim(), 500)}`);
		}
		if (item.kind === "image") {
			const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
			const attachmentId: string = getContextString(data, "attachmentId");
			const sourcePath: string = getContextString(data, "sourcePath");
			lines.push(`  - imageContextId: ${clipTextByChars(item.id, 160)}`);
			if (attachmentId.length > 0) {
				lines.push(`  - attachmentId: ${clipTextByChars(attachmentId, 160)}`);
			}
			if (sourcePath.length > 0) {
				lines.push(`  - sourcePath: ${clipTextByChars(sourcePath, 1000)}`);
			}
			lines.push("  - note: 图片二进制已作为多模态 image_url content part 单独发送给模型；不要在文本上下文中期待 base64。");
		}
		if (item.kind === "text_attachment") {
			appendTextAttachmentPromptLines(lines, item);
		}
		if (item.kind === "script_selection") {
			appendScriptSelectionPromptLines(lines, item);
		} else if (item.kind === "filesystem_selection") {
			appendFilesystemSelectionPromptLines(lines, item);
		} else if (item.kind === "git_diff_comment") {
			appendGitDiffCommentPromptLines(lines, item);
		} else if (item.kind === "message_selection") {
			appendMessageSelectionPromptLines(lines, item);
		} else if (item.kind === "file" || item.kind === "folder") {
			appendExternalLocalFilePromptLines(lines, item);
		}
		if (item.data !== undefined && item.kind !== "script_selection" && item.kind !== "filesystem_selection" && item.kind !== "image" && item.kind !== "text_attachment" && item.kind !== "git_diff_comment" && item.kind !== "message_selection") {
			lines.push(`  - data: ${clipTextByChars(JSON.stringify(createPreviewValue(item.data)), 1000)}`);
		}
	}

	if (items.length > 20) {
		lines.push(`- [truncated] 另有 ${items.length - 20} 条上下文未注入。`);
	}

	return lines.join("\n");
}
