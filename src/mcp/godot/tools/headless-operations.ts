import { access } from "node:fs/promises";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCommandInvocationWait, type CommandInvocation } from "../../terminal/process-runner.js";
import {
	resolveSandboxedProcessInvocation,
	type ProcessInvocationResolution,
	type SandboxExecutionInput
} from "../../terminal/sandbox-execution.js";
import { GODOT_EXECUTABLE, describePresetCommand } from "../../terminal/presets.js";
import {
	asJsonTextResult,
	isPathInsideRoot,
	projectRoot,
	resolveGodotResourceProjectPath
} from "../context.js";
import { materializeRuntimeAsset } from "../../../runtime/runtime-assets.js";

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
	runtimeAssetPath: string;
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
		operationJson,
		runtimeAssetPath: operationsScript.path
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

export async function runGodotHeadlessOperation(
	operation: Record<string, unknown>,
	executionInput: SandboxExecutionInput & Record<string, unknown> = {}
): Promise<HeadlessOperationResult> {
	const operationName: unknown = operation.operation;
	if (typeof operationName !== "string" || operationName.length === 0) {
		throw new Error("Missing required operation name");
	}

	const invocation = await buildGodotHeadlessOperationInvocation(operation);
	const command: string[] = [invocation.executable, ...invocation.args];
	const invocationResolution: ProcessInvocationResolution = resolveSandboxedProcessInvocation({
		input: executionInput,
		command: { kind: "argv", command: invocation.executable, args: invocation.args },
		commandLine: describePresetCommand(command),
		cwd: invocation.cwd,
		workspaceRoot: projectRoot,
		readOnlyPaths: [
			path.dirname(invocation.runtimeAssetPath),
			...(path.isAbsolute(invocation.executable) ? [path.dirname(invocation.executable)] : [])
		],
		workspaceId: typeof executionInput.__daedalusWorkspaceId === "string"
			? executionInput.__daedalusWorkspaceId
			: undefined
	});
	if (!invocationResolution.ok) {
		const stderr: string = String(invocationResolution.result.error ?? "OS sandbox is unavailable");
		const code: string = String(invocationResolution.result.code ?? "sandbox_unavailable");
		return enrichHeadlessResult({
			ok: false,
			operation: operationName,
			exitCode: null,
			stdout: "",
			stderr
		}, {
			ok: false,
			code,
			failureCode: code,
			failure: {
				code,
				category: "policy",
				message: stderr,
				retryable: false,
				artifactRefs: []
			}
		});
	}
	const executableInvocation: CommandInvocation = {
		...invocationResolution.invocation,
		godotProjectPath: projectRoot,
		godotExecutablePath: GODOT_EXECUTABLE
	};

	try {
		const result = await runCommandInvocationWait({
			presetName: "godot.headless_operation",
			invocation: executableInvocation,
			cwd: invocation.cwd,
			timeoutMs: HEADLESS_OPERATION_TIMEOUT_MS
		});
		const parsedEvents: unknown[] = parseJsonObjectsFromOutput(result.stdout);
		const parsed: unknown = parsedEvents.at(-1) ?? (result.ok ? null : {
			ok: false,
			code: "godot_runtime_unavailable",
			failureCode: "godot_runtime_unavailable",
			failure: {
				code: "godot_runtime_unavailable",
				category: "environment",
				message: result.stderr || "Godot headless operation failed",
				retryable: true,
				artifactRefs: []
			}
		});
		return enrichHeadlessResult({
			ok: result.ok && parsedEvents.some((event: unknown): boolean =>
				typeof event === "object" && event !== null && !Array.isArray(event) && (event as Record<string, unknown>).ok === true
			),
			operation: operationName,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr
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
			}).passthrough()
		},
		async (input) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "get_uid",
			resource_path: await assertReadableResourcePath(input.resourcePath)
		}, input as typeof input & SandboxExecutionInput))
	);

	server.registerTool(
		"resave_resource",
		{
			title: "Resave Godot Resource",
			description: "通过 Godot ResourceSaver 重新保存资源，用于刷新 UID/import 相关元数据。需要审批。",
			inputSchema: z.object({
				resourcePath: resourcePathSchema
			}).passthrough()
		},
		async (input) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "resave_resource",
			resource_path: await assertWritableResourcePath(input.resourcePath)
		}, input as typeof input & SandboxExecutionInput))
	);

	server.registerTool(
		"update_project_uids",
		{
			title: "Update Project UIDs",
			description: "递归重新保存当前项目中的 .tscn/.tres/.res 资源，用于刷新 UID 引用。需要审批。",
			inputSchema: z.object({
				subdir: z.string().optional()
			}).passthrough()
		},
		async (input) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "update_project_uids",
			subdir: input.subdir === undefined ? "" : await toProjectResPath(input.subdir)
		}, input as typeof input & SandboxExecutionInput))
	);

	server.registerTool(
		"save_scene_variant",
		{
			title: "Save Godot Scene Variant",
			description: "加载已有 PackedScene 并保存到新 .tscn 路径。需要审批。",
			inputSchema: z.object({
				scenePath: resourcePathSchema,
				outputPath: resourcePathSchema
			}).passthrough()
		},
		async (input) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "save_scene_variant",
			scene_path: await assertReadableResourcePath(input.scenePath),
			output_path: await assertWritableResourcePath(input.outputPath, new Set([".tscn"]))
		}, input as typeof input & SandboxExecutionInput))
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
			}).passthrough()
		},
		async (input) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "load_sprite_texture",
			scene_path: await assertWritableResourcePath(input.scenePath, new Set([".tscn"])),
			node_path: input.nodePath,
			texture_path: await assertReadableResourcePath(input.texturePath)
		}, input as typeof input & SandboxExecutionInput))
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
			}).passthrough()
		},
		async (input) => asJsonTextResult(await runGodotHeadlessOperation({
			operation: "export_mesh_library",
			scene_path: await assertReadableResourcePath(input.scenePath),
			output_path: await assertWritableResourcePath(input.outputPath, new Set([".tres", ".res"])),
			mesh_item_names: input.meshItemNames ?? []
		}, input as typeof input & SandboxExecutionInput))
	);
}
