import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PLUGIN_CAPABILITIES, type NativePluginDeclaration, type PluginCompatibility, type PluginPackageManifest, type PluginPresentation, type PluginScanResult } from "./types.js";
import { parseHarnessBundlePatch } from "./harness/patch-parser.js";

const MAX_MANIFEST_BYTES: number = 256 * 1024;
const MAX_PATCH_BYTES: number = 512 * 1024;
const MAX_PACKAGE_FILES: number = 10_000;
const MAX_PACKAGE_BYTES: number = 128 * 1024 * 1024;
const MAX_PRESENTATION_TEXT_BYTES: number = 128 * 1024;
const MAX_ICON_BYTES: number = 256 * 1024;

type FileEntry = { relativePath: string; absolutePath: string; size: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertInside(root: string, candidate: string): void {
	const resolvedRoot: string = resolve(root);
	const resolvedCandidate: string = resolve(candidate);
	if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
		throw Object.assign(new Error("Plugin path escapes the package root."), { code: "plugin_path_escape" });
	}
}

async function collectFiles(root: string, current: string = ""): Promise<FileEntry[]> {
	const directory: string = join(root, current);
	const entries = await readdir(directory, { withFileTypes: true });
	const files: FileEntry[] = [];
	for (const entry of entries) {
		const relativePath: string = current.length === 0 ? entry.name : join(current, entry.name);
		const absolutePath: string = join(root, relativePath);
		assertInside(root, absolutePath);
		if (entry.isSymbolicLink()) {
			throw Object.assign(new Error(`Plugin packages cannot contain symbolic links: ${relativePath}`), { code: "plugin_symlink_not_allowed" });
		}
		if (entry.isDirectory()) {
			files.push(...await collectFiles(root, relativePath));
			continue;
		}
		if (!entry.isFile()) {
			throw Object.assign(new Error(`Unsupported plugin filesystem entry: ${relativePath}`), { code: "plugin_entry_not_supported" });
		}
		const info = await lstat(absolutePath);
		files.push({ relativePath, absolutePath, size: info.size });
		if (files.length > MAX_PACKAGE_FILES) {
			throw Object.assign(new Error(`Plugin package contains more than ${MAX_PACKAGE_FILES} files.`), { code: "plugin_too_many_files" });
		}
	}
	return files;
}

async function hashPackage(root: string, files: readonly FileEntry[]): Promise<string> {
	const hash = createHash("sha256");
	let totalBytes: number = 0;
	for (const file of [...files].sort((left, right): number => left.relativePath.localeCompare(right.relativePath))) {
		totalBytes += file.size;
		if (totalBytes > MAX_PACKAGE_BYTES) {
			throw Object.assign(new Error(`Plugin package exceeds ${MAX_PACKAGE_BYTES} bytes.`), { code: "plugin_too_large" });
		}
		hash.update(file.relativePath.replace(/\\/g, "/"));
		hash.update("\0");
		hash.update(await readFile(file.absolutePath));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function collectExportPaths(value: unknown, result: string[], depth: number = 0): void {
	if (result.length >= 32 || depth > 6) return;
	if (typeof value === "string") {
		result.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectExportPaths(item, result, depth + 1);
		return;
	}
	if (!isRecord(value)) return;
	for (const child of Object.values(value)) collectExportPaths(child, result, depth + 1);
}

function resolveEntryPaths(root: string, manifest: PluginPackageManifest, declaredEntries: readonly (string | undefined)[]): string[] {
	const rawPaths: string[] = [
		...(manifest.main === undefined ? [] : [manifest.main]),
		...declaredEntries.filter((entry): entry is string => entry !== undefined)
	];
	collectExportPaths(manifest.exports, rawPaths);
	const uniquePaths: string[] = [];
	for (const rawPath of rawPaths) {
		if (!rawPath.startsWith(".")) continue;
		const normalized: string = rawPath.replace(/\\/g, "/");
		const candidate: string = resolve(root, normalized);
		assertInside(root, candidate);
		if (!uniquePaths.includes(normalized)) uniquePaths.push(normalized);
	}
	return uniquePaths.slice(0, 32);
}

function createManifest(value: unknown): PluginPackageManifest {
	if (!isRecord(value)) {
		throw Object.assign(new Error("package.json must contain a JSON object."), { code: "plugin_manifest_invalid" });
	}
	const name: string | undefined = readString(value.name);
	const version: string | undefined = readString(value.version);
	if (name === undefined || version === undefined) {
		throw Object.assign(new Error("Plugin package.json requires name and version."), { code: "plugin_manifest_invalid" });
	}
	return {
		name,
		version,
		...(readString(value.description) === undefined ? {} : { description: readString(value.description) }),
		...(readString(value.type) === undefined ? {} : { type: readString(value.type) }),
		...(readString(value.main) === undefined ? {} : { main: readString(value.main) }),
		...(value.exports === undefined ? {} : { exports: value.exports }),
		...(value.files === undefined ? {} : { files: value.files }),
		...(value.engines === undefined ? {} : { engines: value.engines }),
		...(value.dsh === undefined ? {} : { dsh: value.dsh }),
		...(value.daedalus === undefined ? {} : { daedalus: value.daedalus })
	};
}

async function readOptionalTextAsset(root: string, fileName: string): Promise<string | undefined> {
	const path: string = join(root, fileName);
	assertInside(root, path);
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > MAX_PRESENTATION_TEXT_BYTES) return undefined;
		const bytes: Buffer = await readFile(path);
		const decoder = new TextDecoder("utf-8", { fatal: true });
		return decoder.decode(bytes);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof TypeError) return undefined;
		throw error;
	}
}

async function readOptionalIcon(root: string): Promise<string | undefined> {
	for (const [fileName, mimeType] of [["icon.png", "image/png"], ["icon.svg", "image/svg+xml"]] as const) {
		const path: string = join(root, fileName);
		assertInside(root, path);
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.size > MAX_ICON_BYTES) continue;
			const bytes: Buffer = await readFile(path);
			return `data:${mimeType};base64,${bytes.toString("base64")}`;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return undefined;
}

async function readPresentation(root: string, manifest: PluginPackageManifest): Promise<PluginPresentation | undefined> {
	const readme: string | undefined = await readOptionalTextAsset(root, "README.md");
	const changelog: string | undefined = await readOptionalTextAsset(root, "CHANGELOG.md");
	const iconDataUrl: string | undefined = await readOptionalIcon(root);
	if (manifest.description === undefined && readme === undefined && changelog === undefined && iconDataUrl === undefined) return undefined;
	return {
		...(manifest.description === undefined ? {} : { description: manifest.description }),
		...(readme === undefined ? {} : { readme }),
		...(changelog === undefined ? {} : { changelog }),
		...(iconDataUrl === undefined ? {} : { iconDataUrl })
	};
}

export async function readPluginPresentation(root: string): Promise<PluginPresentation | undefined> {
	const normalizedRoot: string = resolve(root);
	const { manifest } = await readManifest(normalizedRoot);
	return await readPresentation(normalizedRoot, manifest);
}

async function readManifest(root: string): Promise<{ manifest: PluginPackageManifest; manifestHash: string }> {
	const manifestPath: string = join(root, "package.json");
	assertInside(root, manifestPath);
	const content: Buffer = await readFile(manifestPath);
	if (content.byteLength > MAX_MANIFEST_BYTES) {
		throw Object.assign(new Error(`package.json exceeds ${MAX_MANIFEST_BYTES} bytes.`), { code: "plugin_manifest_too_large" });
	}
	let value: unknown;
	try {
		value = JSON.parse(content.toString("utf8"));
	} catch {
		throw Object.assign(new Error("Plugin package.json is not valid JSON."), { code: "plugin_manifest_invalid" });
	}
	return { manifest: createManifest(value), manifestHash: createHash("sha256").update(content).digest("hex") };
}

async function existsFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function analyzeCompatibility(root: string, manifest: PluginPackageManifest): Promise<PluginCompatibility> {
	const dsh: Record<string, unknown> | undefined = isRecord(manifest.dsh) ? manifest.dsh : undefined;
	const bundleDeclaration: unknown = dsh?.bundle;
	const bundle: Record<string, unknown> | undefined = isRecord(bundleDeclaration) ? bundleDeclaration : undefined;
	const harnessBundle: boolean = bundleDeclaration !== undefined;
	const harnessClient: boolean = dsh?.client !== undefined;
	const daedalusRoot: Record<string, unknown> | undefined = isRecord(manifest.daedalus) ? manifest.daedalus : undefined;
	const daedalusPlugin: Record<string, unknown> | undefined = isRecord(daedalusRoot?.plugin) ? daedalusRoot.plugin : undefined;
	const daedalusEntry: string | undefined = readString(daedalusPlugin?.entry);
	const harnessClientValue: unknown = dsh?.client;
	const harnessClientEntry: string | undefined = readString(harnessClientValue) ?? (isRecord(harnessClientValue) ? readString(harnessClientValue.entry) : undefined);
	const entryPaths: string[] = resolveEntryPaths(root, manifest, [daedalusEntry, harnessClientEntry]);
	const warnings: string[] = [];
	const unsupportedFeatures: string[] = [];
	let patchPath: string | undefined;
	let patchExists: boolean = false;
	if (harnessBundle) {
		if (bundle === undefined) {
			warnings.push("dsh.bundle must be an object.");
			unsupportedFeatures.push("invalid dsh.bundle declaration");
		}
		patchPath = readString(bundle?.patch);
		if (patchPath === undefined) {
			warnings.push("dsh.bundle is missing a patch path.");
		} else if (!patchPath.startsWith(".")) {
			unsupportedFeatures.push("absolute or package-external Cordis patch path");
		} else {
			const patchAbsolutePath: string = resolve(root, patchPath);
			assertInside(root, patchAbsolutePath);
			patchExists = await existsFile(patchAbsolutePath);
			if (!patchExists) warnings.push(`Cordis patch file not found: ${patchPath}`);
			if (patchExists) {
				const patchContent: Buffer = await readFile(patchAbsolutePath);
				if (patchContent.byteLength > MAX_PATCH_BYTES) warnings.push(`Cordis patch file exceeds ${MAX_PATCH_BYTES} bytes.`);
				else {
					const text: string = patchContent.toString("utf8");
					if (/!!js\b/iu.test(text)) warnings.push("Cordis patch contains !!js expressions that execute only inside the trusted Harness Sidecar.");
					if (/^\s*inject\s*:/imu.test(text)) warnings.push("Cordis patch declares service injection.");
					if (/\b(?:dynamic|group|include)\s*:/iu.test(text)) warnings.push("Cordis patch contains dynamic composition that may not be bridgeable.");
					for (const operation of ["insert", "replace", "override"]) {
						if (new RegExp(`\\b${operation}\\s*:`, "iu").test(text)) warnings.push(`Cordis patch declares ${operation}.`);
					}
				}
			}
		}
	}
	if (harnessClient) {
		warnings.push("Harness client modules require a Harness-compatible client runtime.");
		if (harnessClientEntry === undefined) warnings.push("dsh.client does not declare a statically inspectable entry path.");
	}
	if (daedalusPlugin !== undefined && daedalusEntry === undefined) warnings.push("daedalus.plugin is missing an entry path.");
	for (const entryPath of entryPaths) {
		if (!(await existsFile(resolve(root, entryPath)))) warnings.push(`Declared entry file not found: ${entryPath}`);
	}
	const native: boolean = daedalusPlugin !== undefined && daedalusEntry !== undefined;
	let classification: PluginCompatibility["classification"];
	if (unsupportedFeatures.length > 0) classification = "unsupported";
	else if (native && harnessBundle) classification = "both";
	else if (native) classification = "native";
	else if (harnessBundle) classification = "harness-bundle";
	else if (harnessClient) classification = "harness-client";
	else classification = "metadata-only";
	return {
		daedalus: native ? "native" : "unknown",
		harnessBundle,
		harnessClient,
		...(patchPath === undefined ? {} : { patchPath }),
		patchExists,
		entryPaths,
		unsupportedFeatures,
		warnings,
		classification
	};
}

export function readNativePluginDeclaration(manifest: PluginPackageManifest): NativePluginDeclaration | undefined {
	if (!isRecord(manifest.daedalus) || !isRecord(manifest.daedalus.plugin)) return undefined;
	const value: Record<string, unknown> = manifest.daedalus.plugin;
	const apiVersion: unknown = value.apiVersion;
	const entry: unknown = value.entry;
	const capabilities: unknown = value.capabilities;
	if (apiVersion !== 1 || typeof entry !== "string" || !entry.startsWith(".") || !Array.isArray(capabilities)) return undefined;
	const normalized: string[] = [...new Set(capabilities.filter((item): item is string => typeof item === "string" && (PLUGIN_CAPABILITIES as readonly string[]).includes(item)))];
	if (normalized.length !== capabilities.length || normalized.length === 0) return undefined;
	return { apiVersion: 1, entry, capabilities: normalized as NativePluginDeclaration["capabilities"] };
}

export async function analyzePluginDirectory(root: string): Promise<PluginScanResult> {
	const normalizedRoot: string = resolve(root);
	const info = await lstat(normalizedRoot);
	if (!info.isDirectory()) throw Object.assign(new Error("Plugin source must be a directory."), { code: "plugin_source_invalid" });
	const files: FileEntry[] = await collectFiles(normalizedRoot);
	const { manifest, manifestHash } = await readManifest(normalizedRoot);
	const contentHash: string = await hashPackage(normalizedRoot, files);
	const nativePlugin: NativePluginDeclaration | undefined = readNativePluginDeclaration(manifest);
	if (nativePlugin !== undefined) {
		const nativeEntryPath: string = resolve(normalizedRoot, nativePlugin.entry);
		assertInside(normalizedRoot, nativeEntryPath);
		if (!(await existsFile(nativeEntryPath))) {
			throw Object.assign(new Error(`Daedalus plugin entry does not exist: ${nativePlugin.entry}`), { code: "plugin_native_entry_missing" });
		}
	}
	let dependencyLockHash: string | undefined;
	for (const lockName of ["package-lock.json", "npm-shrinkwrap.json"]) {
		try {
			dependencyLockHash = createHash("sha256").update(await readFile(join(normalizedRoot, lockName))).digest("hex");
			break;
		} catch {
			// A plugin may not declare runtime dependencies.
		}
	}
	const presentation: PluginPresentation | undefined = await readPresentation(normalizedRoot, manifest);
	const compatibility: PluginCompatibility = await analyzeCompatibility(normalizedRoot, manifest);
	const harnessBundle = compatibility.harnessBundle && compatibility.patchPath !== undefined && compatibility.patchExists
		? await parseHarnessBundlePatch(normalizedRoot, compatibility.patchPath)
		: undefined;
	return {
		packageName: manifest.name,
		version: manifest.version,
		manifest,
		manifestHash,
		contentHash,
		compatibility,
		...(presentation === undefined ? {} : { presentation }),
		...(nativePlugin === undefined ? {} : { nativePlugin }),
		...(dependencyLockHash === undefined ? {} : { dependencyLockHash }),
		...(harnessBundle === undefined ? {} : { harnessBundle }),
		packageRoot: normalizedRoot
	};
}

export function isPathInside(root: string, candidate: string): boolean {
	const rootPath: string = resolve(root);
	const candidatePath: string = resolve(candidate);
	const relativePath: string = relative(rootPath, candidatePath);
	return relativePath.length === 0 || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}
