import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { getAsset, isSea } from "node:sea";
import { getBackendRuntimeAssetsRoot } from "../app-paths.js";
import { getBackendBuildMetadata } from "./build-metadata.js";

export const RUNTIME_ASSET_PATHS = {
	"provider.providers": "src/providers/catalog/providers.json",
	"provider.models": "src/providers/catalog/models.json",
	"prompt.base.godotAssistant": "src/prompts/templates/base/godot-assistant.md",
	"prompt.base.workspaceAssistant": "src/prompts/templates/base/workspace-assistant.md",
	"prompt.base.gdscriptReviewer": "src/prompts/templates/base/gdscript-reviewer.md",
	"prompt.base.sceneArchitect": "src/prompts/templates/base/scene-architect.md",
	"prompt.base.backendHelper": "src/prompts/templates/base/backend-helper.md",
	"prompt.base.gitCommitter": "src/prompts/templates/base/git-committer.md",
	"prompt.mode.agent": "src/prompts/templates/modes/agent-mode.md",
	"prompt.mode.ask": "src/prompts/templates/modes/ask-mode.md",
	"prompt.fragment.core": "src/prompts/templates/fragments/CORE.md",
	"prompt.fragment.customInstructionsBoundary": "src/prompts/templates/fragments/custom-instructions-boundary.md",
	"prompt.internal.commandReview": "src/prompts/templates/internal/command-review.md",
	"prompt.internal.sessionCompressor": "src/prompts/templates/internal/session-compressor.md",
	"skill.godotProjectInit": "src/skills/builtin/godot-project-init/SKILL.md",
	"skill.gdscriptReview": "src/skills/builtin/gdscript-review/SKILL.md",
	"skill.sceneBuilder": "src/skills/builtin/scene-builder/SKILL.md",
	"skill.fileCreator": "src/skills/builtin/file-creator/SKILL.md",
	"skill.backendHelper": "src/skills/builtin/backend-helper/SKILL.md",
	"skill.skillCreator": "src/skills/builtin/skill-creator/SKILL.md",
	"skill.pluginCreator": "src/skills/builtin/plugin-creator/SKILL.md",
	"skill.imageGen": "src/skills/builtin/image-gen/SKILL.md",
	"godot.operationsScript": "src/mcp/godot/scripts/godot_operations.gd",
	"native.keytar.win32-x64": "node_modules/keytar/build/Release/keytar.node",
	"plugin.workerBootstrap": "src/plugins/runtime/worker-bootstrap.js",
	"plugin.workerProtocol": "src/plugins/runtime/worker-protocol.js"
} as const;

export type RuntimeAssetKey = keyof typeof RUNTIME_ASSET_PATHS;

const RUNTIME_ASSET_KEYS_BY_SOURCE_PATH: ReadonlyMap<string, RuntimeAssetKey> = new Map(
	Object.entries(RUNTIME_ASSET_PATHS).map(([key, path]): [string, RuntimeAssetKey] => [
		path.replaceAll("\\", "/"),
		key as RuntimeAssetKey
	])
);

export function getRuntimeAssetKeyForSourcePath(sourcePath: string): RuntimeAssetKey {
	const key: RuntimeAssetKey | undefined = RUNTIME_ASSET_KEYS_BY_SOURCE_PATH.get(sourcePath.replaceAll("\\", "/"));
	if (key === undefined) {
		throw new Error(`Unknown Daedalus runtime asset path: ${sourcePath}`);
	}
	return key;
}

function getSourceAssetPath(key: RuntimeAssetKey): string {
	const sourceRoot: string = process.env.DAEDALUS_SOURCE_ROOT?.trim() || process.cwd();
	return resolve(sourceRoot, RUNTIME_ASSET_PATHS[key]);
}

function toBuffer(value: ArrayBuffer): Buffer {
	return Buffer.from(value);
}

export function readRuntimeAssetSync(key: RuntimeAssetKey): Buffer {
	if (isSea()) {
		return toBuffer(getAsset(key));
	}
	return readFileSync(getSourceAssetPath(key));
}

export function readRuntimeAssetTextSync(key: RuntimeAssetKey): string {
	if (isSea()) {
		return getAsset(key, "utf8");
	}
	return readFileSync(getSourceAssetPath(key), "utf8");
}

export async function readRuntimeAsset(key: RuntimeAssetKey): Promise<Buffer> {
	if (isSea()) {
		return readRuntimeAssetSync(key);
	}
	return readFile(getSourceAssetPath(key));
}

export async function readRuntimeAssetText(key: RuntimeAssetKey): Promise<string> {
	if (isSea()) {
		return readRuntimeAssetTextSync(key);
	}
	return readFile(getSourceAssetPath(key), "utf8");
}

export function sha256Buffer(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

async function fileMatches(path: string, expectedHash: string): Promise<boolean> {
	try {
		const info = await stat(path);
		if (!info.isFile()) {
			return false;
		}
		return sha256Buffer(await readFile(path)) === expectedHash;
	} catch {
		return false;
	}
}

export async function materializeRuntimeAsset(
	key: RuntimeAssetKey,
	options: {
		rootDir?: string | undefined;
		fileName?: string | undefined;
	} = {}
): Promise<{ path: string; sha256: string }> {
	const content: Buffer = await readRuntimeAsset(key);
	const sha256: string = sha256Buffer(content);
	const version: string = getBackendBuildMetadata().version;
	const rootDir: string = options.rootDir ?? getBackendRuntimeAssetsRoot();
	const targetDir: string = resolve(rootDir, version, sha256);
	const fileName: string = options.fileName ?? basename(RUNTIME_ASSET_PATHS[key]);
	const targetPath: string = resolve(targetDir, fileName);

	if (await fileMatches(targetPath, sha256)) {
		return { path: targetPath, sha256 };
	}

	await mkdir(dirname(targetPath), { recursive: true });
	const temporaryPath: string = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
		if (!(await fileMatches(temporaryPath, sha256))) {
			throw new Error(`Runtime asset hash verification failed: ${key}`);
		}
		await rm(targetPath, { force: true });
		await rename(temporaryPath, targetPath);
		return { path: targetPath, sha256 };
	} finally {
		await rm(temporaryPath, { force: true }).catch((): void => undefined);
	}
}
