import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GODOT_EXECUTABLE } from "../../terminal/presets.js";
import {
	asJsonTextResult,
	isPathInsideRoot,
	projectRoot,
	resolveGodotResourceProjectPath
} from "../context.js";
import { materializeRuntimeAsset } from "../../../runtime/runtime-assets.js";

const execFileAsync = promisify(execFile);
const HEADLESS_OPERATION_TIMEOUT_MS: number = 120_000;
const HEADLESS_WRITE_EXTENSIONS: ReadonlySet<string> = new Set([".tscn", ".tres", ".res"]);

type HeadlessOperationResult = {
	ok: boolean;
	operation: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	parsed: unknown;
	failure?: unknown;
	failureCode?: string | undefined;
	validationStatus?: "passed" | "failed";
};

const HEADLESS_RESULT_PREFIX: string = "DAEDALUS_RESULT:";

export async function buildGodotHeadlessOperationInvocation(operation: Record<string, unknown>): Promise<{
	executable: string;
	args: string[];
	cwd: string;
	operationJson: string;
}> {
	const operationJson: string = JSON.stringify(operation);
	const operationsScript = await materializeRuntimeAsset("godot.operationsScript");
	return {
		executable: GODOT_EXECUTABLE,
		args: [
			"--headless",
			"--disable-crash-handler",
			"--path", projectRoot,
			"--script", operationsScript.path,
			"--", operationJson
		],
		cwd: projectRoot,
		operationJson
	};
}

function parseJsonObjectsFromOutput(output: string): unknown[] {
	const values: unknown[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const trimmedLine: string = line.trim();
		if (!trimmedLine.startsWith(HEADLESS_RESULT_PREFIX)) {
			continue;
		}
		const jsonText: string = trimmedLine.slice(HEADLESS_RESULT_PREFIX.length);
		if (!jsonText.startsWith("{") || !jsonText.endsWith("}")) {
			continue;
		}
		try {
			values.push(JSON.parse(jsonText));
		} catch {
			continue;
		}
	}
	return values;
}

function enrichHeadlessResult(
	base: Omit<HeadlessOperationResult, "parsed" | "failure" | "failureCode" | "validationStatus">,
	parsed: unknown
): HeadlessOperationResult {
	const record: Record<string, unknown> | undefined = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
		? parsed as Record<string, unknown>
		: undefined;
	const ok: boolean = record?.ok === true;
	return {
		...base,
		parsed,
		validationStatus: ok ? "passed" : "failed",
		failure: record?.failure,
		failureCode: typeof record?.failureCode === "string"
			? record.failureCode
			: typeof record?.code === "string" ? record.code : undefined
	};
}

async function toProjectResPath(resourcePath: string): Promise<string> {
	const absolutePath: string = await resolveGodotResourceProjectPath(resourcePath);
	return `res://${path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/")}`;
}

async function assertReadableResourcePath(resourcePath: string): Promise<string> {
	const absolutePath: string = await resolveGodotResourceProjectPath(resourcePath);
	await access(absolutePath);
	return `res://${path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/")}`;
}

async function assertWritableResourcePath(resourcePath: string, allowedExtensions: ReadonlySet<string> = HEADLESS_WRITE_EXTENSIONS): Promise<string> {
	const absolutePath: string = await resolveGodotResourceProjectPath(resourcePath);
	if (!isPathInsideRoot(absolutePath, projectRoot)) {
		throw new Error(`Resource path is outside Godot project: ${resourcePath}`);
	}

	const normalizedPath: string = path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
	for (const segment of normalizedPath.split("/")) {
		if (segment.startsWith(".") && segment !== ".") {
			throw new Error(`Path contains hidden directory: ${segment}`);
		}
	}
	if (normalizedPath === "addons" || normalizedPath.startsWith("addons/")) {
		throw new Error("Writing to addons/ is not allowed");
	}

	const extension: string = path.extname(absolutePath).toLowerCase();
	if (!allowedExtensions.has(extension)) {
		throw new Error(`Unsupported headless operation extension: ${extension || "(none)"}`);
	}
	return `res://${normalizedPath}`;
}

export async function runGodotHeadlessOperation(operation: Record<string, unknown>): Promise<HeadlessOperationResult> {
	const operationName: unknown = operation.operation;
	if (typeof operationName !== "string" || operationName.length === 0) {
		throw new Error("Missing required operation name");
	}

	const invocation = await buildGodotHeadlessOperationInvocation(operation);

	try {
		const result = await execFileAsync(invocation.executable, invocation.args, {
			cwd: invocation.cwd,
			timeout: HEADLESS_OPERATION_TIMEOUT_MS,
			maxBuffer: 2 * 1024 * 1024
		});
		const parsedEvents: unknown[] = parseJsonObjectsFromOutput(result.stdout);
		const parsed: unknown = parsedEvents.at(-1) ?? null;
		return enrichHeadlessResult({
			ok: parsedEvents.some((event: unknown): boolean =>
				typeof event === "object" && event !== null && !Array.isArray(event) && (event as Record<string, unknown>).ok === true
			),
			operation: operationName,
			exitCode: 0,
			stdout: result.stdout,
			stderr: result.stderr,
		}, parsed);
	} catch (error: unknown) {
		const execError = error as { code?: number | string | null; stdout?: string; stderr?: string; message?: string; killed?: boolean };
		const stdout: string = execError.stdout ?? "";
		const stderr: string = execError.stderr ?? execError.message ?? "Godot headless operation failed";
		const parsedEvents: unknown[] = parseJsonObjectsFromOutput(stdout);
		const unavailable: boolean = execError.code === "ENOENT" || execError.killed === true;
		const failureCode: string = unavailable ? "godot_runtime_unavailable" : "headless_result_missing";
		const parsed: unknown = parsedEvents.at(-1) ?? {
			ok: false,
			code: failureCode,
			failureCode,
			failure: {
				code: failureCode,
				category: unavailable ? "environment" : "protocol",
				message: stderr,
				retryable: unavailable,
				artifactRefs: []
			}
		};
		return enrichHeadlessResult({
			ok: false,
			operation: operationName,
			exitCode: typeof execError.code === "number" ? execError.code : null,
			stdout,
			stderr,
		}, parsed);
	}
}

const resourcePathSchema = z.string().min(1);
const nodePathSchema = z.string().min(1);
const meshItemNamesSchema = z.array(z.string().min(1)).max(100).optional();

export function registerHeadlessOperationTools(server: McpServer): void {
	server.registerTool(
		"get_uid",
		{
			title: "Get Godot Resource UID",
			description: "通过 Godot ResourceLoader 读取资源 UID。",
			inputSchema: z.object({
				resourcePath: resourcePathSchema
			})
		},
		async ({ resourcePath }) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "get_uid",
			resource_path: await assertReadableResourcePath(resourcePath)
		}))
	);

	server.registerTool(
		"resave_resource",
		{
			title: "Resave Godot Resource",
			description: "通过 Godot ResourceSaver 重新保存资源，用于刷新 UID/import 相关元数据。需要审批。",
			inputSchema: z.object({
				resourcePath: resourcePathSchema
			})
		},
		async ({ resourcePath }) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "resave_resource",
			resource_path: await assertWritableResourcePath(resourcePath)
		}))
	);

	server.registerTool(
		"update_project_uids",
		{
			title: "Update Project UIDs",
			description: "递归重新保存当前项目中的 .tscn/.tres/.res 资源，用于刷新 UID 引用。需要审批。",
			inputSchema: z.object({
				subdir: z.string().optional()
			})
		},
		async ({ subdir }) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "update_project_uids",
			subdir: subdir === undefined ? "" : await toProjectResPath(subdir)
		}))
	);

	server.registerTool(
		"save_scene_variant",
		{
			title: "Save Godot Scene Variant",
			description: "加载已有 PackedScene 并保存到新 .tscn 路径。需要审批。",
			inputSchema: z.object({
				scenePath: resourcePathSchema,
				outputPath: resourcePathSchema
			})
		},
		async ({ scenePath, outputPath }) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "save_scene_variant",
			scene_path: await assertReadableResourcePath(scenePath),
			output_path: await assertWritableResourcePath(outputPath, new Set([".tscn"]))
		}))
	);

	server.registerTool(
		"load_sprite_texture",
		{
			title: "Load Sprite Texture",
			description: "通过 Godot 引擎给场景内 Sprite2D/TextureRect 等节点加载贴图并保存场景。需要审批。",
			inputSchema: z.object({
				scenePath: resourcePathSchema,
				nodePath: nodePathSchema,
				texturePath: resourcePathSchema
			})
		},
		async ({ scenePath, nodePath, texturePath }) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "load_sprite_texture",
			scene_path: await assertWritableResourcePath(scenePath, new Set([".tscn"])),
			node_path: nodePath,
			texture_path: await assertReadableResourcePath(texturePath)
		}))
	);

	server.registerTool(
		"export_mesh_library",
		{
			title: "Export MeshLibrary",
			description: "从 3D 场景中的 MeshInstance3D 节点导出 MeshLibrary .tres。需要审批。",
			inputSchema: z.object({
				scenePath: resourcePathSchema,
				outputPath: resourcePathSchema,
				meshItemNames: meshItemNamesSchema
			})
		},
		async ({ scenePath, outputPath, meshItemNames }) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "export_mesh_library",
			scene_path: await assertReadableResourcePath(scenePath),
			output_path: await assertWritableResourcePath(outputPath, new Set([".tres", ".res"])),
			mesh_item_names: meshItemNames ?? []
		}))
	);
}
