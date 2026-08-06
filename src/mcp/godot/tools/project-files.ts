import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { validateTscnContent } from "./tscn-tools.js";
import { asJsonTextResult, asTextResult, assertWritablePath, parseProjectFeatureVersion, parseProjectSettingString, projectRoot, readProjectConfig, resolveProjectPath, toProjectRelativePath, type ProjectSummary } from "../context.js";
import { createWorkspaceFileService } from "../../../workspace/files.js";

const MAX_TEXT_FILE_BYTES: number = 512 * 1024;
const MAX_NEW_FILE_BYTES: number = 64 * 1024;
const MAX_TSCN_FILE_BYTES: number = 256 * 1024;

const DEFAULT_IGNORED_DIRECTORIES: Set<string> = new Set([
	".git",
	".godot",
	".vscode",
	".idea",
	"android",
	"node_modules"
]);

const TEXT_EXTENSIONS: Set<string> = new Set([
	".cfg",
	".cs",
	".gd",
	".gdshader",
	".godot",
	".json",
	".md",
	".res",
	".tres",
	".tscn",
	".txt",
	".uid"
]);

const godotFileService = createWorkspaceFileService({
	rootPath: projectRoot,
	readMaxBytes: MAX_TEXT_FILE_BYTES,
	newFileMaxBytes: MAX_TSCN_FILE_BYTES,
	writeMaxBytes: MAX_TEXT_FILE_BYTES,
	validateWritablePath: assertWritablePath,
	validateContent: ({ relativePath, content, operation }): string[] => {
		const errors: string[] = [];
		if (operation === "create" && !relativePath.endsWith(".tscn") && content.length > MAX_NEW_FILE_BYTES) {
			errors.push(`Content too large: ${content.length} bytes (max ${MAX_NEW_FILE_BYTES})`);
		}
		if (relativePath.endsWith(".tscn")) {
			if (content.length > MAX_TSCN_FILE_BYTES) {
				errors.push(`Content too large: ${content.length} bytes (max ${MAX_TSCN_FILE_BYTES})`);
			}
			if (content.length > 0) {
				errors.push(...validateTscnContent(content));
			}
		}
		return errors;
	}
});


function shouldSkipDirectory(name: string): boolean {
	return DEFAULT_IGNORED_DIRECTORIES.has(name);
}

async function walkProjectFiles(options?: {
	subdir?: string | undefined;
	extensions?: string[] | undefined;
	includeAddons?: boolean | undefined;
}): Promise<string[]> {
	const startPath: string = options?.subdir !== undefined
		? await resolveProjectPath(options.subdir)
		: projectRoot;
	const extensions: Set<string> | undefined = options?.extensions !== undefined && options.extensions.length > 0
		? new Set(options.extensions.map((extension: string): string => extension.startsWith(".") ? extension : `.${extension}`))
		: undefined;
	const results: string[] = [];

	async function walk(directoryPath: string): Promise<void> {
		const entries: Dirent[] = await fs.readdir(directoryPath, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory() && shouldSkipDirectory(entry.name)) {
				continue;
			}

			if (entry.isDirectory() && entry.name === "addons" && options?.includeAddons !== true) {
				continue;
			}

			const fullPath: string = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			const extension: string = path.extname(entry.name);
			if (extensions !== undefined && !extensions.has(extension)) {
				continue;
			}

			results.push(toProjectRelativePath(fullPath));
		}
	}

	await walk(startPath);
	results.sort();
	return results;
}

async function listAddons(): Promise<string[]> {
	const addonsPath: string = path.join(projectRoot, "addons");
	try {
		const entries: Dirent[] = await fs.readdir(addonsPath, { withFileTypes: true });
		return entries
			.filter((entry: Dirent): boolean => entry.isDirectory())
			.map((entry: Dirent): string => entry.name)
			.sort();
	} catch {
		return [];
	}
}

async function getProjectSummary(): Promise<ProjectSummary> {
	const config: Record<string, string> = await readProjectConfig();
	const scenes: string[] = await walkProjectFiles({ extensions: [".tscn"] });
	const scripts: string[] = await walkProjectFiles({ extensions: [".gd"] });
	const addons: string[] = await listAddons();

	return {
		path: projectRoot,
		name: parseProjectSettingString(config["application/config/name"] ?? config["config/name"]) ?? "unknown",
		mainScene: parseProjectSettingString(config["application/run/main_scene"] ?? config["run/main_scene"]) ?? "",
		features: config["application/config/features"] ?? config["config/features"] ?? "",
		addons,
		sceneCount: scenes.length,
		scriptCount: scripts.length
	};
}

async function readTextFile(relativePath: string): Promise<string> {
	const fullPath: string = await resolveProjectPath(relativePath);
	const stat = await fs.stat(fullPath);

	if (!stat.isFile()) {
		throw new Error(`Not a file: ${relativePath}`);
	}

	if (stat.size > MAX_TEXT_FILE_BYTES) {
		throw new Error(`File too large: ${relativePath} (${stat.size} bytes)`);
	}

	const extension: string = path.extname(fullPath);
	const fileName: string = path.basename(fullPath);
	if (fileName !== "project.godot" && !TEXT_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported text file extension: ${extension || "(none)"}`);
	}

	return fs.readFile(fullPath, "utf8");
}

export async function validateNewTextFile(relativePath: string, content: string): Promise<{
	valid: boolean;
	resolvedPath?: string;
	normalizedPath: string;
	errors: string[];
}> {
	const errors: string[] = [];
	let resolvedPath: string;

	if (content.length === 0) {
		errors.push("File content is empty");
	}

	if (relativePath.endsWith(".tscn")) {
		if (content.length > MAX_TSCN_FILE_BYTES) {
			errors.push(`Content too large: ${content.length} bytes (max ${MAX_TSCN_FILE_BYTES})`);
		}
	} else if (content.length > MAX_NEW_FILE_BYTES) {
		errors.push(`Content too large: ${content.length} bytes (max ${MAX_NEW_FILE_BYTES})`);
	}

	if (relativePath.endsWith(".tscn") && content.length > 0) {
		errors.push(...validateTscnContent(content));
	}

	try {
		resolvedPath = await assertWritablePath(relativePath);
	} catch (error: unknown) {
		return {
			valid: false,
			normalizedPath: relativePath,
			errors: [error instanceof Error ? error.message : "Path validation failed"]
		};
	}

	const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

	try {
		await fs.access(resolvedPath);
		errors.push(`File already exists: ${normalizedPath}`);
	} catch {
		// File does not exist — this is required for create.
	}

	return {
		valid: errors.length === 0,
		resolvedPath,
		normalizedPath,
		errors
	};
}

export async function createTextFile(relativePath: string, content: string): Promise<{
	created: true;
	path: string;
	size: number;
}> {
	return godotFileService.createTextFile(relativePath, content);
}

export async function overwriteTextFile(relativePath: string, content: string): Promise<{
	overwritten: true;
	path: string;
	size: number;
	oldSize: number;
}> {
	if (content.length === 0) {
		throw new Error("File content is empty");
	}

	const maxBytes: number = relativePath.endsWith(".tscn") ? MAX_TSCN_FILE_BYTES : MAX_TEXT_FILE_BYTES;
	if (content.length > maxBytes) {
		throw new Error(`Content too large: ${content.length} bytes (max ${maxBytes})`);
	}

	if (relativePath.endsWith(".tscn")) {
		const tscnErrors: string[] = validateTscnContent(content);
		if (tscnErrors.length > 0) {
			throw new Error(`TSCN validation failed: ${tscnErrors.join("; ")}`);
		}
	}

	return godotFileService.overwriteTextFile(relativePath, content);
}

export async function replaceTextInFile(relativePath: string, oldText: string, newText: string): Promise<{
	replaced: true;
	path: string;
	occurrences: number;
	size: number;
	oldSize: number;
}> {
	if (oldText.length === 0) {
		throw new Error("oldText must not be empty");
	}

	return godotFileService.replaceTextInFile(relativePath, oldText, newText);
}

export function registerProjectFileTools(server: McpServer): void {
server.registerTool(
		"get_project_summary",
		{
			title: "Get Godot Project Summary",
			description: "返回当前 Godot 项目的名称、主场景、插件列表和文件数量",
			inputSchema: z.object({})
		},
		async () => asJsonTextResult(await getProjectSummary())
	);

server.registerTool(
		"list_project_files",
		{
			title: "List Godot Project Files",
			description: "递归列出 Godot 项目文件，可按子目录和扩展名过滤",
			inputSchema: z.object({
				subdir: z.string().optional().describe("相对于项目根目录的子目录"),
				extensions: z.array(z.string()).optional().describe("扩展名过滤，例如 ['.gd', '.tscn']"),
				includeAddons: z.boolean().optional().describe("是否包含 addons 目录")
			})
		},
		async ({ subdir, extensions, includeAddons }) => {
			const files: string[] = await walkProjectFiles({ subdir, extensions, includeAddons });
			return asJsonTextResult({ files });
		}
	);

server.registerTool(
		"list_scenes",
		{
			title: "List Godot Scenes",
			description: "列出 Godot 项目中所有 .tscn 场景文件",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("是否包含 addons 目录")
			})
		},
		async ({ includeAddons }) => {
			const scenes: string[] = await walkProjectFiles({ extensions: [".tscn"], includeAddons });
			return asJsonTextResult({ scenes });
		}
	);

server.registerTool(
		"list_scripts",
		{
			title: "List GDScript Files",
			description: "列出 Godot 项目中所有 .gd 脚本文件",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("是否包含 addons 目录")
			})
		},
		async ({ includeAddons }) => {
			const scripts: string[] = await walkProjectFiles({ extensions: [".gd"], includeAddons });
			return asJsonTextResult({ scripts });
		}
	);

server.registerTool(
		"read_text_file",
		{
			title: "Read Text File",
			description: "读取 Godot 项目中的文本文件，带路径越界和大小限制",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的文件路径")
			})
		},
		async ({ relativePath }) => asTextResult(await readTextFile(relativePath))
	);

server.registerTool(
		"search_text",
		{
			title: "Search Text",
			description: "在项目文本文件中搜索关键词，返回匹配文件和行号",
			inputSchema: z.object({
				query: z.string().min(1).describe("要搜索的文本"),
				extensions: z.array(z.string()).optional().describe("扩展名过滤，例如 ['.gd']"),
				limit: z.number().int().positive().max(200).optional().describe("最多返回多少条匹配")
			})
		},
		async ({ query, extensions, limit }) => {
			const maxMatches: number = limit ?? 50;
			const files: string[] = await walkProjectFiles({
				extensions: extensions ?? Array.from(TEXT_EXTENSIONS)
			});
			const matches: Array<{ file: string; line: number; text: string }> = [];

			for (const file of files) {
				if (matches.length >= maxMatches) {
					break;
				}

				let content: string;
				try {
					content = await readTextFile(file);
				} catch {
					continue;
				}

				const lines: string[] = content.split("\n");
				for (let index: number = 0; index < lines.length; index += 1) {
					const lineText: string | undefined = lines[index];
					if (lineText === undefined || !lineText.includes(query)) {
						continue;
					}

					matches.push({
						file,
						line: index + 1,
						text: lineText.trim()
					});

					if (matches.length >= maxMatches) {
						break;
					}
				}
			}

			return asJsonTextResult({ matches });
		}
	);

server.registerTool(
		"propose_create_text_file",
		{
			title: "Propose Create Text File",
			description: "提出新建一个文本文件的提案。不会实际写入磁盘，仅返回校验结果和预览。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许覆盖已有文件，不允许写入 .godot/ 或 addons/ 目录。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的新文件路径"),
				content: z.string().describe("文件内容")
			})
		},
		async ({ relativePath, content }) => {
			const validation = await validateNewTextFile(relativePath, content);

			if (!validation.valid) {
				return asJsonTextResult({
					valid: false,
					path: validation.normalizedPath,
					errors: validation.errors
				});
			}

			const previewLength: number = Math.min(content.length, 500);
			const preview: string = content.slice(0, previewLength) + (content.length > previewLength ? "\n..." : "");

			return asJsonTextResult({
				valid: true,
				path: validation.normalizedPath,
				size: content.length,
				preview
			});
		}
	);

server.registerTool(
		"create_text_file",
		{
			title: "Create Text File",
			description: "创建一个新的文本文件，会实际写入磁盘。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许覆盖已有文件，不允许写入 .godot/ 或 addons/ 目录。写入后 Daedalus 会请求在线 Godot 编辑器重新扫描文件系统；建议运行 godot.check_only 验证。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的新文件路径"),
				content: z.string().describe("文件内容")
			})
		},
		async ({ relativePath, content }) => asJsonTextResult(await createTextFile(relativePath, content))
	);

server.registerTool(
		"propose_overwrite_text_file",
		{
			title: "Propose Overwrite Text File",
			description: "提出覆盖已有文件的提案。不会实际写入，仅校验并返回新旧内容对比。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。文件必须已存在，不允许写入 .godot/。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径"),
				content: z.string().describe("新的完整文件内容")
			})
		},
		async ({ relativePath, content }) => {
			const errors: string[] = [];
			let resolvedPath: string;

			try {
				resolvedPath = await assertWritablePath(relativePath);
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Path validation failed"]
				});
			}

			if (content.length === 0) {
				errors.push("File content is empty");
			}

			const overwriteMaxBytes: number = relativePath.endsWith(".tscn") ? MAX_TSCN_FILE_BYTES : MAX_TEXT_FILE_BYTES;
			if (content.length > overwriteMaxBytes) {
				errors.push(`Content too large: ${content.length} bytes (max ${overwriteMaxBytes})`);
			}

			if (relativePath.endsWith(".tscn") && content.length > 0) {
				errors.push(...validateTscnContent(content));
			}
			let oldContent: string;
			try {
				oldContent = await fs.readFile(resolvedPath, "utf8");
			} catch {
				errors.push(`File does not exist: ${relativePath}`);
				return asJsonTextResult({ valid: false, failureCode: "target_file_missing", path: relativePath, errors });
			}

			if (errors.length > 0) {
				return asJsonTextResult({ valid: false, failureCode: "write_validation_failed", path: relativePath, errors });
			}

			const previewLength: number = Math.min(content.length, 500);
			const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

			return asJsonTextResult({
				valid: true,
				path: normalizedPath,
				size: content.length,
				oldSize: oldContent.length,
				preview: content.slice(0, previewLength) + (content.length > previewLength ? "\n..." : "")
			});
		}
	);

server.registerTool(
		"overwrite_text_file",
		{
			title: "Overwrite Text File",
			description: "覆盖已有文本文件，会实际写入磁盘。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许写入 .godot/、addons/ 或隐藏目录。写入后 Daedalus 会请求在线 Godot 编辑器重新扫描文件系统；建议运行 godot.check_only 验证。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径"),
				content: z.string().describe("新的完整文件内容")
			})
		},
		async ({ relativePath, content }) => asJsonTextResult(await overwriteTextFile(relativePath, content))
	);

server.registerTool(
		"propose_replace_text_in_file",
		{
			title: "Propose Replace Text In File",
			description: "提出替换文件中指定文本的提案。不会实际写入，仅校验并返回 diff 预览。文件必须已存在。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径"),
				oldText: z.string().min(1).describe("要被替换的原文本（必须精确匹配）"),
				newText: z.string().describe("替换后的新文本")
			})
		},
		async ({ relativePath, oldText, newText }) => {
			const errors: string[] = [];
			let resolvedPath: string;

			try {
				resolvedPath = await assertWritablePath(relativePath);
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Path validation failed"]
				});
			}

			let oldContent: string;
			try {
				oldContent = await fs.readFile(resolvedPath, "utf8");
			} catch {
				errors.push(`File does not exist: ${relativePath}`);
				return asJsonTextResult({ valid: false, path: relativePath, errors });
			}

			if (!oldContent.includes(oldText)) {
				errors.push("oldText not found in file. Ensure exact match including whitespace and indentation.");
				return asJsonTextResult({ valid: false, failureCode: "replace_target_not_found", path: relativePath, errors });
			}

			const newContent: string = oldContent.replace(oldText, newText);
			const occurrenceCount: number = oldContent.split(oldText).length - 1;
			const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

			return asJsonTextResult({
				valid: true,
				path: normalizedPath,
				occurrences: occurrenceCount,
				oldLength: oldContent.length,
				newLength: newContent.length,
				preview: newContent.slice(0, 500) + (newContent.length > 500 ? "\n..." : "")
			});
		}
	);

server.registerTool(
		"replace_text_in_file",
		{
			title: "Replace Text In File",
			description: "替换已有文件中首次出现的指定文本，会实际写入磁盘。oldText 必须精确匹配。写入后 Daedalus 会请求在线 Godot 编辑器重新扫描文件系统。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径"),
				oldText: z.string().min(1).describe("要被替换的原文本（必须精确匹配）"),
				newText: z.string().describe("替换后的新文本")
			})
		},
		async ({ relativePath, oldText, newText }) => asJsonTextResult(await replaceTextInFile(relativePath, oldText, newText))
	);

server.registerTool(
		"delete_file",
		{
			title: "Delete File",
			description: "删除项目中的文件。文件必须存在，不允许删除 .godot/ 中的文件。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径")
			})
		},
		async ({ relativePath }) => {
			const errors: string[] = [];
			let resolvedPath: string;

			try {
				resolvedPath = await assertWritablePath(relativePath);
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Path validation failed"]
				});
			}

			const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

			if (normalizedPath.startsWith(".godot/") || normalizedPath === ".godot") {
				return asJsonTextResult({
					valid: false,
					path: normalizedPath,
					errors: ["Cannot delete files in .godot/"]
				});
			}

			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isFile()) {
					errors.push(`Not a file: ${normalizedPath}`);
				}
			} catch {
				errors.push(`File does not exist: ${normalizedPath}`);
			}

			if (errors.length > 0) {
				return asJsonTextResult({ valid: false, path: normalizedPath, errors });
			}

			try {
				await fs.unlink(resolvedPath);
				return asJsonTextResult({ deleted: true, path: normalizedPath });
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: normalizedPath,
					errors: [error instanceof Error ? error.message : "Failed to delete file"]
				});
			}
		}
	);

}

export function registerProjectFileResources(server: McpServer): void {
server.registerResource(
		"project",
		"godot://project",
		{
			title: "Godot Project Summary",
			description: "当前 Godot 项目的摘要信息",
			mimeType: "application/json"
		},
		async (uri: URL) => ({
			contents: [{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify(await getProjectSummary(), null, 2)
			}]
		})
	);

server.registerResource(
		"scenes",
		"godot://scenes",
		{
			title: "Godot Scenes",
			description: "当前 Godot 项目的场景文件列表",
			mimeType: "application/json"
		},
		async (uri: URL) => ({
			contents: [{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify({ scenes: await walkProjectFiles({ extensions: [".tscn"] }) }, null, 2)
			}]
		})
	);

server.registerResource(
		"scripts",
		"godot://scripts",
		{
			title: "GDScript Files",
			description: "当前 Godot 项目的 GDScript 文件列表",
			mimeType: "application/json"
		},
		async (uri: URL) => ({
			contents: [{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify({ scripts: await walkProjectFiles({ extensions: [".gd"] }) }, null, 2)
			}]
		})
	);

}
