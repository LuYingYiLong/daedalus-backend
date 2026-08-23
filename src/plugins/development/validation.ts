import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { analyzePluginDirectory } from "../manifest.js";
import type { PluginScanResult } from "../types.js";
import { pluginDevelopmentTestPlanSchema, type PluginDevelopmentDiagnostic, type PluginDevelopmentFile, type PluginDevelopmentTestPlan } from "./types.js";

const execFileAsync = promisify(execFile);
const REQUIRED_FILES: readonly string[] = [
	"package.json",
	"index.js",
	"README.md",
	"CHANGELOG.md",
	"tests/daedalus.plugin-tests.json"
];
const FORBIDDEN_IMPORT_PATTERN: RegExp = /(?:node:)?(?:child_process|cluster|worker_threads|http|https|net|tls|dgram)|\b(?:fetch|WebSocket)\s*\(/u;
const SECRET_PATTERN: RegExp = /(?:sk-[a-z0-9_-]{12,}|api[_-]?key\s*[:=]\s*["'][^"']{8,}|bearer\s+[a-z0-9._-]{16,})/iu;
const REGISTER_EXPORT_PATTERN: RegExp = /export\s+(?:(?:async\s+)?function|const|let|var)\s+register\b|export\s*\{[^}]*\bregister\b/um;

function summarizeCapabilities(scan: PluginScanResult): Record<string, number> {
	const declarations = scan.p2?.declarations;
	return {
		tools: scan.nativePlugin?.capabilities.includes("tools") === true ? 1 : 0,
		skills: scan.nativePlugin?.capabilities.includes("skills") === true ? 1 : 0,
		hooks: scan.nativePlugin?.capabilities.includes("hooks") === true ? 1 : 0,
		mcp: scan.nativePlugin?.capabilities.includes("mcp") === true ? 1 : 0,
		commands: declarations?.commands?.length ?? 0,
		contextProviders: declarations?.contextProviders?.length ?? 0,
		panels: declarations?.panels?.length ?? 0,
		settings: declarations?.settings?.length ?? 0,
		timelineParts: declarations?.timelineParts?.length ?? 0,
		browser: declarations?.browser === undefined ? 0 : 1,
		languageServices: declarations?.languageServices?.length ?? 0,
		events: declarations?.events?.length ?? 0
	};
}

function diagnostic(error: unknown, path?: string): PluginDevelopmentDiagnostic {
	const value = error as { code?: unknown; message?: unknown };
	return {
		code: typeof value.code === "string" ? value.code : "plugin_validation_failed",
		message: typeof value.message === "string" ? value.message : String(error),
		severity: "error",
		...(path === undefined ? {} : { path })
	};
}

async function writeFiles(root: string, files: readonly PluginDevelopmentFile[]): Promise<void> {
	for (const file of files) {
		const target = join(root, ...file.path.split("/"));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.content, "utf8");
	}
}

function validateSourceText(files: readonly PluginDevelopmentFile[]): PluginDevelopmentDiagnostic[] {
	const diagnostics: PluginDevelopmentDiagnostic[] = [];
	for (const required of REQUIRED_FILES) {
		if (!files.some((file): boolean => file.path.toLowerCase() === required.toLowerCase())) {
			diagnostics.push({ code: "plugin_required_file_missing", message: `Required plugin file is missing: ${required}.`, severity: "error", path: required });
		}
	}
	for (const file of files) {
		if (SECRET_PATTERN.test(file.content)) diagnostics.push({ code: "plugin_secret_detected", message: "Generated plugin source appears to contain a credential or token.", severity: "error", path: file.path });
		if (/\.(?:c?js|mjs|ts)$/iu.test(file.path) && FORBIDDEN_IMPORT_PATTERN.test(file.content)) diagnostics.push({ code: "plugin_forbidden_runtime_api", message: "P0 plugins cannot use network or child-process APIs.", severity: "error", path: file.path });
	}
	const manifestFile = files.find((file): boolean => file.path.toLowerCase() === "package.json");
	if (manifestFile !== undefined) {
		try {
			const manifest: unknown = JSON.parse(manifestFile.content);
			if (manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)) diagnostics.push(...validateManifest(manifest as Record<string, unknown>));
		} catch (error: unknown) {
			diagnostics.push(diagnostic(error, "package.json"));
		}
	}
	return diagnostics;
}

function validateManifest(manifest: Record<string, unknown>): PluginDevelopmentDiagnostic[] {
	const diagnostics: PluginDevelopmentDiagnostic[] = [];
	if (manifest.type !== "module") diagnostics.push({ code: "plugin_module_type_required", message: "P0 plugins must use JavaScript ESM with package.json type=module.", severity: "error", path: "package.json" });
	for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		const value = manifest[key];
		if (typeof value === "object" && value !== null && Object.keys(value).length > 0) diagnostics.push({ code: "plugin_dependencies_not_supported", message: `P0 generated plugins cannot declare ${key}.`, severity: "error", path: "package.json" });
	}
	const scripts = typeof manifest.scripts === "object" && manifest.scripts !== null ? manifest.scripts as Record<string, unknown> : {};
	for (const name of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) {
		if (name in scripts) diagnostics.push({ code: "plugin_lifecycle_script_forbidden", message: `Lifecycle script is not allowed: ${name}.`, severity: "error", path: "package.json" });
	}
	return diagnostics;
}

export async function validatePluginDevelopmentDirectory(root: string): Promise<{
	diagnostics: PluginDevelopmentDiagnostic[];
	scan?: PluginScanResult | undefined;
	testPlan?: PluginDevelopmentTestPlan | undefined;
	capabilitySummary: Record<string, number>;
}> {
	const diagnostics: PluginDevelopmentDiagnostic[] = [];
	let scan: PluginScanResult | undefined;
	let testPlan: PluginDevelopmentTestPlan | undefined;
	try {
		scan = await analyzePluginDirectory(root);
		if (scan.nativePlugin === undefined || scan.nativePlugin.apiVersion !== 1) diagnostics.push({ code: "plugin_native_manifest_required", message: "A Daedalus Native API v1 declaration is required.", severity: "error", path: "package.json" });
		if (scan.compatibility.harnessBundle || scan.compatibility.harnessClient) diagnostics.push({ code: "plugin_harness_not_supported", message: "@plugin-creator P0 does not generate Harness Bundle or Client plugins.", severity: "error", path: "package.json" });
		diagnostics.push(...validateManifest(scan.manifest as Record<string, unknown>));
	} catch (error: unknown) {
		diagnostics.push(diagnostic(error));
	}
	try {
		const value: unknown = JSON.parse(await readFile(join(root, "tests", "daedalus.plugin-tests.json"), "utf8"));
		testPlan = pluginDevelopmentTestPlanSchema.parse(value);
	} catch (error: unknown) {
		diagnostics.push(diagnostic(error, "tests/daedalus.plugin-tests.json"));
	}
	if (scan?.nativePlugin?.entry !== undefined) {
		try {
			const entryPath = join(root, scan.nativePlugin.entry);
			const entrySource = await readFile(entryPath, "utf8");
			if (!REGISTER_EXPORT_PATTERN.test(entrySource)) diagnostics.push({ code: "plugin_register_export_required", message: "The Native plugin entry must export register(api).", severity: "error", path: scan.nativePlugin.entry });
			await execFileAsync(process.execPath, ["--check", entryPath], { windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 });
		} catch (error: unknown) {
			diagnostics.push(diagnostic(error, scan.nativePlugin.entry));
		}
	}
	return { diagnostics, scan, testPlan, capabilitySummary: scan === undefined ? {} : summarizeCapabilities(scan) };
}

export async function validatePluginDevelopmentSnapshot(files: readonly PluginDevelopmentFile[]): Promise<{
	diagnostics: PluginDevelopmentDiagnostic[];
	capabilitySummary: Record<string, number>;
}> {
	const diagnostics = validateSourceText(files);
	const root = await mkdtemp(join(tmpdir(), "daedalus-plugin-dev-validate-"));
	try {
		await writeFiles(root, files);
		const result = await validatePluginDevelopmentDirectory(root);
		return { diagnostics: [...diagnostics, ...result.diagnostics], capabilitySummary: result.capabilitySummary };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
