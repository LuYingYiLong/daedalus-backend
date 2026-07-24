import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
	getExtResourceIdFromScriptValue,
	getSceneRelativeNodePath,
	parseTscn,
	type TscnData,
	type TscnExtResource,
	type TscnNode
} from "./tscn-tools.js";
import { asJsonTextResult, projectRoot, resolveProjectPath, toProjectRelativePath } from "../context.js";

const MAX_SCAN_FILE_BYTES: number = 1024 * 1024;
const MAX_RESULTS: number = 500;

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".godot",
	".idea",
	".vscode",
	"android",
	"node_modules"
]);

const ANALYZED_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	".gd",
	".gdshader",
	".godot",
	".tres",
	".tscn"
]);

const UNUSED_RESOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
	".aseprite",
	".bmp",
	".dae",
	".exr",
	".fbx",
	".glb",
	".gltf",
	".gdshader",
	".jpg",
	".jpeg",
	".json",
	".material",
	".mp3",
	".obj",
	".ogg",
	".otf",
	".png",
	".res",
	".scn",
	".shader",
	".svg",
	".tga",
	".tres",
	".tscn",
	".ttf",
	".wav",
	".webp"
]);

export type ResourceReference = {
	sourcePath: string;
	targetPath: string;
	rawReference: string;
};

export type SceneNodeSearchMatch = {
	scenePath: string;
	nodePath: string;
	name: string;
	type: string;
	parent: string | null;
	scriptPath: string | null;
	groups: string[];
	matchingSignals: string[];
};

function shouldSkipDirectory(name: string, includeAddons: boolean): boolean {
	return SKIPPED_DIRECTORIES.has(name) || (name === "addons" && !includeAddons);
}

function isObviousGeneratedFile(relativePath: string): boolean {
	const normalizedPath: string = relativePath.replaceAll("\\", "/");
	return normalizedPath.endsWith(".import")
		|| normalizedPath.endsWith(".uid")
		|| normalizedPath.includes("/.import/")
		|| normalizedPath.startsWith("imported/")
		|| normalizedPath.startsWith("exports/");
}

async function walkProjectFiles(options?: {
	includeAddons?: boolean | undefined;
	extensions?: ReadonlySet<string> | undefined;
	rootRelativePath?: string | undefined;
}): Promise<string[]> {
	const includeAddons: boolean = options?.includeAddons === true;
	const results: string[] = [];

	async function walk(directoryPath: string): Promise<void> {
		const entries: Dirent[] = await fs.readdir(directoryPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && shouldSkipDirectory(entry.name, includeAddons)) {
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

			const relativePath: string = toProjectRelativePath(fullPath);
			if (isObviousGeneratedFile(relativePath)) {
				continue;
			}
			const extension: string = path.extname(relativePath).toLowerCase();
			if (options?.extensions !== undefined && !options.extensions.has(extension)) {
				continue;
			}
			results.push(relativePath);
		}
	}

	const rootPath: string = options?.rootRelativePath === undefined
		? projectRoot
		: await resolveProjectPath(options.rootRelativePath);
	await walk(rootPath);
	results.sort();
	return results;
}

async function readSmallTextFile(relativePath: string): Promise<string | null> {
	const fullPath: string = await resolveProjectPath(relativePath);
	const stat = await fs.stat(fullPath);
	if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) {
		return null;
	}
	return fs.readFile(fullPath, "utf8");
}

function normalizeResourceReference(rawReference: string): string | null {
	const withoutScheme: string = rawReference.trim().replaceAll("\\", "/").replace(/^res:\/\//u, "");
	if (withoutScheme.length === 0 || withoutScheme.startsWith("/") || /^[A-Za-z]:/u.test(withoutScheme)) {
		return null;
	}

	const normalized: string = path.posix.normalize(withoutScheme);
	if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
		return null;
	}
	return normalized;
}

function normalizeProjectRelativeInput(rawPath: string | undefined, fallback: string = ""): string {
	const trimmedPath: string = (rawPath ?? fallback).trim().replaceAll("\\", "/").replace(/^res:\/\//u, "");
	if (trimmedPath.length === 0) {
		return "";
	}
	if (trimmedPath.startsWith("/") || /^[A-Za-z]:/u.test(trimmedPath)) {
		throw new Error(`Absolute paths are not allowed: ${rawPath}`);
	}

	const normalized: string = path.posix.normalize(trimmedPath);
	if (normalized === "." || normalized.length === 0) {
		return "";
	}
	if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith(".godot/") || normalized === ".godot") {
		throw new Error(`Invalid project path: ${rawPath}`);
	}
	return normalized;
}

function addReference(references: ResourceReference[], sourcePath: string, rawReference: string): void {
	const normalizedTarget: string | null = normalizeResourceReference(rawReference);
	if (normalizedTarget === null) {
		return;
	}

	if (references.some((reference: ResourceReference): boolean => reference.sourcePath === sourcePath && reference.targetPath === normalizedTarget)) {
		return;
	}

	references.push({
		sourcePath,
		targetPath: normalizedTarget,
		rawReference
	});
}

export function extractGodotResourceReferences(sourcePath: string, content: string): ResourceReference[] {
	const references: ResourceReference[] = [];
	const resReferenceRegex = /res:\/\/[^\s"'`\])},]+/gu;
	let match: RegExpExecArray | null;
	while ((match = resReferenceRegex.exec(content)) !== null) {
		addReference(references, sourcePath, match[0]!);
	}

	if (sourcePath.endsWith(".tscn")) {
		try {
			const scene: TscnData = parseTscn(content);
			for (const resource of scene.extResources) {
				if (resource.path !== undefined) {
					addReference(references, sourcePath, resource.path);
				}
			}
		} catch {
			return references;
		}
	}

	return references.sort((left: ResourceReference, right: ResourceReference): number => left.targetPath.localeCompare(right.targetPath));
}

function buildDependencyGraph(files: string[], references: ResourceReference[]): Map<string, string[]> {
	const existingFiles: Set<string> = new Set(files);
	const graph: Map<string, string[]> = new Map(files.map((filePath: string): [string, string[]] => [filePath, []]));
	for (const reference of references) {
		if (existingFiles.has(reference.targetPath)) {
			graph.get(reference.sourcePath)?.push(reference.targetPath);
		}
	}

	for (const [filePath, targets] of graph) {
		graph.set(filePath, [...new Set(targets)].sort());
	}
	return graph;
}

function detectCycles(graph: Map<string, string[]>): string[][] {
	const visiting: Set<string> = new Set();
	const visited: Set<string> = new Set();
	const stack: string[] = [];
	const cycles: string[][] = [];
	const seenCycles: Set<string> = new Set();

	function visit(node: string): void {
		if (visiting.has(node)) {
			const cycleStart: number = stack.indexOf(node);
			if (cycleStart >= 0) {
				const cycle: string[] = [...stack.slice(cycleStart), node];
				const key: string = cycle.join(" -> ");
				if (!seenCycles.has(key)) {
					seenCycles.add(key);
					cycles.push(cycle);
				}
			}
			return;
		}
		if (visited.has(node)) {
			return;
		}

		visiting.add(node);
		stack.push(node);
		for (const target of graph.get(node) ?? []) {
			visit(target);
		}
		stack.pop();
		visiting.delete(node);
		visited.add(node);
	}

	for (const node of graph.keys()) {
		visit(node);
	}
	return cycles;
}

async function collectDependencyData(includeAddons: boolean | undefined): Promise<{
	files: string[];
	analyzedFiles: string[];
	references: ResourceReference[];
	missingReferences: ResourceReference[];
	cycles: string[][];
	graph: Map<string, string[]>;
}> {
	const files: string[] = await walkProjectFiles({ includeAddons });
	const fileSet: Set<string> = new Set(files);
	const analyzedFiles: string[] = files.filter((filePath: string): boolean => ANALYZED_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
	const references: ResourceReference[] = [];

	for (const filePath of analyzedFiles) {
		const content: string | null = await readSmallTextFile(filePath);
		if (content === null) {
			continue;
		}
		references.push(...extractGodotResourceReferences(filePath, content));
	}

	const missingReferences: ResourceReference[] = references.filter((reference: ResourceReference): boolean => !fileSet.has(reference.targetPath));
	const graph: Map<string, string[]> = buildDependencyGraph(analyzedFiles, references);
	const cycles: string[][] = detectCycles(graph);

	return { files, analyzedFiles, references, missingReferences, cycles, graph };
}

async function analyzeProjectDependencies(includeAddons: boolean | undefined): Promise<Record<string, unknown>> {
	const data = await collectDependencyData(includeAddons);
	return {
		projectRoot,
		includeAddons: includeAddons === true,
		analyzedFileCount: data.analyzedFiles.length,
		referenceCount: data.references.length,
		references: data.references.slice(0, MAX_RESULTS),
		missingReferences: data.missingReferences.slice(0, MAX_RESULTS),
		cycles: data.cycles.slice(0, MAX_RESULTS),
		truncated: data.references.length > MAX_RESULTS || data.missingReferences.length > MAX_RESULTS || data.cycles.length > MAX_RESULTS
	};
}

async function findUnusedResources(includeAddons: boolean | undefined): Promise<Record<string, unknown>> {
	const data = await collectDependencyData(includeAddons);
	const used: Set<string> = new Set(data.references.map((reference: ResourceReference): string => reference.targetPath));
	const candidates: string[] = data.files.filter((filePath: string): boolean => {
		if (filePath === "project.godot" || isObviousGeneratedFile(filePath)) {
			return false;
		}
		const extension: string = path.extname(filePath).toLowerCase();
		return UNUSED_RESOURCE_EXTENSIONS.has(extension);
	});
	const unused: string[] = candidates.filter((filePath: string): boolean => !used.has(filePath));

	return {
		projectRoot,
		includeAddons: includeAddons === true,
		candidateCount: candidates.length,
		unusedCount: unused.length,
		unused: unused.slice(0, MAX_RESULTS),
		truncated: unused.length > MAX_RESULTS
	};
}

function extractQuotedArrayStrings(valueExpression: string | undefined): string[] {
	if (valueExpression === undefined) {
		return [];
	}

	const quotedValues: string[] = [];
	const regex = /"((?:[^"\\]|\\.)*)"/gu;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(valueExpression)) !== null) {
		quotedValues.push(match[1]!.replace(/\\"/gu, "\"").replace(/\\\\/gu, "\\"));
	}
	return quotedValues;
}

function getNodeScriptPath(scene: TscnData, node: TscnNode): string | null {
	const extResourceId: string | null = getExtResourceIdFromScriptValue(node.script);
	if (extResourceId === null) {
		return null;
	}

	const resource: TscnExtResource | undefined = scene.extResources.find((item: TscnExtResource): boolean => item.id === extResourceId);
	return resource?.path === undefined ? null : normalizeResourceReference(resource.path);
}

function normalizeOptionalFilter(value: string | undefined): string | null {
	const trimmed: string | undefined = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? null : trimmed.toLowerCase();
}

async function findSceneNodes(args: {
	scenePath?: string | undefined;
	nodeType?: string | undefined;
	name?: string | undefined;
	scriptPath?: string | undefined;
	group?: string | undefined;
	signal?: string | undefined;
	includeAddons?: boolean | undefined;
	limit?: number | undefined;
}): Promise<Record<string, unknown>> {
	const scenePaths: string[] = args.scenePath !== undefined
		? [toProjectRelativePath(await resolveProjectPath(args.scenePath))]
		: await walkProjectFiles({ includeAddons: args.includeAddons, extensions: new Set([".tscn"]) });
	const nodeTypeFilter: string | null = normalizeOptionalFilter(args.nodeType);
	const nameFilter: string | null = normalizeOptionalFilter(args.name);
	const scriptPathFilter: string | null = args.scriptPath === undefined ? null : normalizeResourceReference(args.scriptPath)?.toLowerCase() ?? args.scriptPath.toLowerCase();
	const groupFilter: string | null = normalizeOptionalFilter(args.group);
	const signalFilter: string | null = normalizeOptionalFilter(args.signal);
	const limit: number = Math.min(Math.max(args.limit ?? MAX_RESULTS, 1), MAX_RESULTS);
	const matches: SceneNodeSearchMatch[] = [];

	for (const scenePath of scenePaths) {
		const content: string | null = await readSmallTextFile(scenePath);
		if (content === null) {
			continue;
		}

		const scene: TscnData = parseTscn(content);
		for (const node of scene.nodes) {
			const nodePath: string = getSceneRelativeNodePath(node);
			const scriptPath: string | null = getNodeScriptPath(scene, node);
			const groups: string[] = extractQuotedArrayStrings(node.properties["groups"]);
			const matchingSignals: string[] = scene.connections
				.filter((connection): boolean => connection.from === nodePath || connection.to === nodePath)
				.map((connection): string => connection.signal);

			if (nodeTypeFilter !== null && node.type.toLowerCase() !== nodeTypeFilter) {
				continue;
			}
			if (nameFilter !== null && !node.name.toLowerCase().includes(nameFilter)) {
				continue;
			}
			if (scriptPathFilter !== null && scriptPath?.toLowerCase() !== scriptPathFilter) {
				continue;
			}
			if (groupFilter !== null && !groups.some((group: string): boolean => group.toLowerCase() === groupFilter)) {
				continue;
			}
			if (signalFilter !== null && !matchingSignals.some((signal: string): boolean => signal.toLowerCase() === signalFilter)) {
				continue;
			}

			matches.push({
				scenePath,
				nodePath,
				name: node.name,
				type: node.type,
				parent: node.parent,
				scriptPath,
				groups,
				matchingSignals
			});
			if (matches.length >= limit) {
				return { matches, totalMatched: matches.length, truncated: true };
			}
		}
	}

	return { matches, totalMatched: matches.length, truncated: false };
}

async function findScriptReferences(scriptPath: string, includeAddons: boolean | undefined): Promise<Record<string, unknown>> {
	const normalizedScriptPath: string | null = normalizeResourceReference(scriptPath);
	if (normalizedScriptPath === null) {
		throw new Error(`Invalid scriptPath: ${scriptPath}`);
	}

	const data = await collectDependencyData(includeAddons);
	const references: ResourceReference[] = data.references.filter((reference: ResourceReference): boolean => reference.targetPath === normalizedScriptPath);

	return {
		scriptPath: normalizedScriptPath,
		includeAddons: includeAddons === true,
		references: references.slice(0, MAX_RESULTS),
		totalMatched: references.length,
		truncated: references.length > MAX_RESULTS
	};
}

type ProjectGlobalClass = {
	className: string;
	baseClass: string | null;
	scriptPath: string;
	language: "gdscript" | "csharp";
	isTool: boolean;
	matches: string[];
};

type ProjectTestEntry = {
	framework: "gut" | "gdunit" | "python";
	testPath: string;
	runnable: boolean;
	runnerHint: string;
	matchedFunctions: string[];
};

type ImportMetadataSectionMap = Record<string, Record<string, string>>;

function extractGdscriptGlobalClass(filePath: string, content: string): ProjectGlobalClass | null {
	const className: string | undefined = content.match(/^\s*class_name\s+([A-Za-z_][A-Za-z0-9_]*)/mu)?.[1];
	if (className === undefined) {
		return null;
	}
	const baseClass: string | undefined = content.match(/^\s*extends\s+([A-Za-z_][A-Za-z0-9_.]*)/mu)?.[1];
	const isTool: boolean = /^\s*@tool\s*$/mu.test(content) || /^\s*tool\s*$/mu.test(content);
	const matches: string[] = [`class_name ${className}`];
	if (baseClass !== undefined) {
		matches.push(`extends ${baseClass}`);
	}
	if (isTool) {
		matches.push("@tool");
	}
	return {
		className,
		baseClass: baseClass ?? null,
		scriptPath: filePath,
		language: "gdscript",
		isTool,
		matches
	};
}

function extractCsharpGlobalClasses(filePath: string, content: string): ProjectGlobalClass[] {
	const classes: ProjectGlobalClass[] = [];
	const classRegex = /((?:\[[^\]]+\]\s*)*)(?:public\s+|internal\s+|private\s+|protected\s+)*(?:abstract\s+|sealed\s+|static\s+|partial\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_.<>]*))?/gu;
	let match: RegExpExecArray | null;
	while ((match = classRegex.exec(content)) !== null) {
		const attributes: string = match[1] ?? "";
		if (!/\bGlobalClass\b/u.test(attributes)) {
			continue;
		}
		const className: string = match[2]!;
		const baseClass: string | undefined = match[3];
		const isTool: boolean = /\bTool\b/u.test(attributes);
		const matches: string[] = ["[GlobalClass]", `class ${className}`];
		if (baseClass !== undefined) {
			matches.push(`: ${baseClass}`);
		}
		classes.push({
			className,
			baseClass: baseClass ?? null,
			scriptPath: filePath,
			language: "csharp",
			isTool,
			matches
		});
	}
	return classes;
}

async function listProjectGlobalClasses(args: {
	filter?: string | undefined;
	includeAddons?: boolean | undefined;
	limit?: number | undefined;
}): Promise<Record<string, unknown>> {
	const files: string[] = await walkProjectFiles({
		includeAddons: args.includeAddons,
		extensions: new Set([".gd", ".cs"])
	});
	const filter: string | null = normalizeOptionalFilter(args.filter);
	const limit: number = Math.min(Math.max(args.limit ?? MAX_RESULTS, 1), MAX_RESULTS);
	const classes: ProjectGlobalClass[] = [];
	for (const filePath of files) {
		const content: string | null = await readSmallTextFile(filePath);
		if (content === null) {
			continue;
		}
		if (filePath.endsWith(".gd")) {
			const entry: ProjectGlobalClass | null = extractGdscriptGlobalClass(filePath, content);
			if (entry !== null) {
				classes.push(entry);
			}
		} else if (filePath.endsWith(".cs")) {
			classes.push(...extractCsharpGlobalClasses(filePath, content));
		}
	}

	const filteredClasses: ProjectGlobalClass[] = filter === null
		? classes
		: classes.filter((entry: ProjectGlobalClass): boolean => [
			entry.className,
			entry.baseClass ?? "",
			entry.scriptPath,
			entry.language
		].some((value: string): boolean => value.toLowerCase().includes(filter)));
	filteredClasses.sort((left: ProjectGlobalClass, right: ProjectGlobalClass): number => left.className.localeCompare(right.className) || left.scriptPath.localeCompare(right.scriptPath));

	return {
		includeAddons: args.includeAddons === true,
		count: filteredClasses.length,
		classes: filteredClasses.slice(0, limit),
		truncated: filteredClasses.length > limit
	};
}

function detectTestEntry(filePath: string, content: string, gutAvailable: boolean, gdunitAvailable: boolean): ProjectTestEntry | null {
	const matchedFunctions: string[] = [...content.matchAll(/^\s*func\s+(test_[A-Za-z0-9_]+)\s*\(/gmu)].map((match: RegExpMatchArray): string => match[1]!);
	if (filePath.endsWith(".py")) {
		const pythonFunctions: string[] = [...content.matchAll(/^\s*def\s+(test_[A-Za-z0-9_]+)\s*\(/gmu)].map((match: RegExpMatchArray): string => match[1]!);
		const looksLikePythonTest: boolean = pythonFunctions.length > 0 || /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/u.test(filePath);
		return looksLikePythonTest ? {
			framework: "python",
			testPath: filePath,
			runnable: true,
			runnerHint: `python ${filePath}`,
			matchedFunctions: pythonFunctions
		} : null;
	}

	if (!filePath.endsWith(".gd")) {
		return null;
	}
	if (/extends\s+GdUnitTestSuite\b/u.test(content)) {
		return {
			framework: "gdunit",
			testPath: filePath,
			runnable: gdunitAvailable,
			runnerHint: "Godot headless with GdUnit4 runner",
			matchedFunctions
		};
	}
	if (/extends\s+GutTest\b/u.test(content) || /extends\s+"res:\/\/addons\/gut\/test\.gd"/u.test(content) || /(?:^|\/)test_[^/]+\.gd$/u.test(filePath) || matchedFunctions.length > 0) {
		return {
			framework: "gut",
			testPath: filePath,
			runnable: gutAvailable,
			runnerHint: "Godot headless with addons/gut/gut_cmdln.gd",
			matchedFunctions
		};
	}
	return null;
}

async function pathExists(relativePath: string): Promise<boolean> {
	try {
		await fs.access(path.join(projectRoot, relativePath));
		return true;
	} catch {
		return false;
	}
}

async function listProjectTests(args: {
	searchPath?: string | undefined;
	framework?: string | undefined;
	limit?: number | undefined;
}): Promise<Record<string, unknown>> {
	const configuredSearchPath: string | undefined = args.searchPath;
	const searchRoots: string[] = configuredSearchPath === undefined
		? ["test", "tests"]
		: [normalizeProjectRelativeInput(configuredSearchPath)];
	const frameworkFilter: string | null = normalizeOptionalFilter(args.framework);
	const limit: number = Math.min(Math.max(args.limit ?? MAX_RESULTS, 1), MAX_RESULTS);
	const gutAvailable: boolean = await pathExists("addons/gut/gut_cmdln.gd");
	const gdunitAvailable: boolean = await pathExists("addons/gdUnit4/src/core/discovery/GdUnitTestDiscoverer.gd") || await pathExists("addons/gdUnit4");
	const tests: ProjectTestEntry[] = [];

	for (const searchRoot of searchRoots) {
		if (searchRoot.length > 0 && !await pathExists(searchRoot)) {
			continue;
		}
		const files: string[] = await walkProjectFiles({
			rootRelativePath: searchRoot,
			includeAddons: searchRoot.startsWith("addons/") || searchRoot === "addons",
			extensions: new Set([".gd", ".py"])
		});
		for (const filePath of files) {
			const content: string | null = await readSmallTextFile(filePath);
			if (content === null) {
				continue;
			}
			const testEntry: ProjectTestEntry | null = detectTestEntry(filePath, content, gutAvailable, gdunitAvailable);
			if (testEntry === null) {
				continue;
			}
			if (frameworkFilter !== null && testEntry.framework !== frameworkFilter) {
				continue;
			}
			tests.push(testEntry);
		}
	}
	tests.sort((left: ProjectTestEntry, right: ProjectTestEntry): number => left.testPath.localeCompare(right.testPath));

	return {
		searchPaths: searchRoots.map((root: string): string => root.length === 0 ? "." : root),
		framework: frameworkFilter,
		count: tests.length,
		tests: tests.slice(0, limit),
		truncated: tests.length > limit
	};
}

function parseXmlAttributes(attributesText: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const regex = /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*"([^"]*)"/gu;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(attributesText)) !== null) {
		attributes[match[1]!] = match[2]!;
	}
	return attributes;
}

function extractXmlTagValues(content: string, tagName: string): string[] {
	const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gu");
	return [...content.matchAll(regex)].map((match: RegExpMatchArray): string => match[1]!.trim()).filter((value: string): boolean => value.length > 0);
}

function parseCsproj(projectPath: string, content: string): Record<string, unknown> {
	const issues: string[] = [];
	if (!/<Project\b/u.test(content)) {
		issues.push("Missing <Project> root element.");
	}
	if (/<Project\b[^>]*>/u.test(content) && !/<\/Project>/u.test(content) && !/<Project\b[^>]*\/>/u.test(content)) {
		issues.push("Malformed XML: missing </Project> closing tag.");
	}
	const sdk: string | null = parseXmlAttributes(content.match(/<Project\b([^>]*)>/u)?.[1] ?? "").Sdk ?? null;
	const targetFrameworks: string[] = [
		...extractXmlTagValues(content, "TargetFramework"),
		...extractXmlTagValues(content, "TargetFrameworks").flatMap((value: string): string[] => value.split(";").map((item: string): string => item.trim()).filter(Boolean))
	];
	const packageReferences: Array<Record<string, string | null>> = [];
	for (const match of content.matchAll(/<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gu)) {
		const attributes: Record<string, string> = parseXmlAttributes(match[1] ?? "");
		const body: string = match[2] ?? "";
		packageReferences.push({
			include: attributes.Include ?? attributes.Update ?? null,
			version: attributes.Version ?? extractXmlTagValues(body, "Version")[0] ?? null
		});
	}
	const projectReferences: string[] = [...content.matchAll(/<ProjectReference\b([^>]*?)(?:\/>|>[\s\S]*?<\/ProjectReference>)/gu)]
		.map((match: RegExpMatchArray): string | undefined => parseXmlAttributes(match[1] ?? "").Include)
		.filter((value: string | undefined): value is string => value !== undefined);
	return {
		path: projectPath,
		sdk,
		targetFrameworks: [...new Set(targetFrameworks)],
		usesGodotSdk: sdk?.toLowerCase().includes("godot") === true || packageReferences.some((reference: Record<string, string | null>): boolean => String(reference.include ?? "").toLowerCase().includes("godot")),
		packageReferences,
		projectReferences,
		issues
	};
}

function parseSolution(solutionPath: string, content: string): Record<string, unknown> {
	const projects: Array<Record<string, string>> = [];
	for (const match of content.matchAll(/^Project\("[^"]+"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/gmu)) {
		projects.push({
			name: match[1]!,
			path: match[2]!,
			guid: match[3]!
		});
	}
	return {
		path: solutionPath,
		projects,
		issues: projects.length === 0 ? ["No project entries found."] : []
	};
}

async function inspectCsharpProjectSupport(args: {
	searchPath?: string | undefined;
	limit?: number | undefined;
}): Promise<Record<string, unknown>> {
	const searchPath: string = normalizeProjectRelativeInput(args.searchPath, "");
	const limit: number = Math.min(Math.max(args.limit ?? MAX_RESULTS, 1), MAX_RESULTS);
	const files: string[] = await walkProjectFiles({
		rootRelativePath: searchPath,
		includeAddons: searchPath.startsWith("addons/") || searchPath === "addons",
		extensions: new Set([".csproj", ".sln"])
	});
	const projectPaths: string[] = files.filter((filePath: string): boolean => filePath.endsWith(".csproj"));
	const solutionPaths: string[] = files.filter((filePath: string): boolean => filePath.endsWith(".sln"));
	const projects: Record<string, unknown>[] = [];
	const solutions: Record<string, unknown>[] = [];
	for (const projectPath of projectPaths.slice(0, limit)) {
		const content: string | null = await readSmallTextFile(projectPath);
		projects.push(content === null ? { path: projectPath, issues: ["File is not readable as small UTF-8 text."] } : parseCsproj(projectPath, content));
	}
	for (const solutionPath of solutionPaths.slice(0, limit)) {
		const content: string | null = await readSmallTextFile(solutionPath);
		solutions.push(content === null ? { path: solutionPath, issues: ["File is not readable as small UTF-8 text."] } : parseSolution(solutionPath, content));
	}
	return {
		searchPath: searchPath.length === 0 ? "." : searchPath,
		projectCount: projectPaths.length,
		solutionCount: solutionPaths.length,
		projects,
		solutions,
		truncated: projectPaths.length > limit || solutionPaths.length > limit
	};
}

function parseGodotConfigSections(content: string): ImportMetadataSectionMap {
	const sections: ImportMetadataSectionMap = {};
	let currentSection: string | null = null;
	for (const rawLine of content.replace(/\r\n?/gu, "\n").split("\n")) {
		const line: string = rawLine.trim();
		if (line.length === 0 || line.startsWith(";") || line.startsWith("#")) {
			continue;
		}
		const sectionMatch: RegExpMatchArray | null = line.match(/^\[([^\]]+)\]$/u);
		if (sectionMatch !== null) {
			currentSection = sectionMatch[1]!;
			sections[currentSection] = sections[currentSection] ?? {};
			continue;
		}
		const equalsIndex: number = line.indexOf("=");
		if (currentSection === null || equalsIndex < 0) {
			continue;
		}
		sections[currentSection]![line.slice(0, equalsIndex).trim()] = line.slice(equalsIndex + 1).trim();
	}
	return sections;
}

function parseGodotStringExpression(valueExpression: string | undefined): string {
	if (valueExpression === undefined) {
		return "";
	}
	const trimmed: string = valueExpression.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

async function getImportMetadata(resourcePath: string): Promise<Record<string, unknown>> {
	const normalizedResourcePath: string = normalizeProjectRelativeInput(resourcePath);
	if (normalizedResourcePath.length === 0) {
		throw new Error("Resource path is required.");
	}
	const importRelativePath: string = `${normalizedResourcePath}.import`;
	const importAbsolutePath: string = await resolveProjectPath(importRelativePath);
	try {
		const content: string = await fs.readFile(importAbsolutePath, "utf8");
		const sections: ImportMetadataSectionMap = parseGodotConfigSections(content);
		const remap: Record<string, string> = sections.remap ?? {};
		return {
			resourcePath: `res://${normalizedResourcePath}`,
			importConfigPath: `res://${importRelativePath}`,
			exists: true,
			importer: parseGodotStringExpression(remap.importer),
			resourceType: parseGodotStringExpression(remap.type),
			uid: parseGodotStringExpression(remap.uid),
			importedPath: parseGodotStringExpression(remap.path),
			dependencies: sections.deps ?? {},
			params: sections.params ?? {},
			sections
		};
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				resourcePath: `res://${normalizedResourcePath}`,
				importConfigPath: `res://${importRelativePath}`,
				exists: false
			};
		}
		throw error;
	}
}

function findDuplicateGlobalClasses(classes: ProjectGlobalClass[]): Array<Record<string, unknown>> {
	const byName: Map<string, ProjectGlobalClass[]> = new Map();
	for (const entry of classes) {
		const key: string = entry.className.toLowerCase();
		byName.set(key, [...byName.get(key) ?? [], entry]);
	}
	return [...byName.values()]
		.filter((entries: ProjectGlobalClass[]): boolean => entries.length > 1)
		.map((entries: ProjectGlobalClass[]): Record<string, unknown> => ({
			className: entries[0]!.className,
			scriptPaths: entries.map((entry: ProjectGlobalClass): string => entry.scriptPath)
		}));
}

async function collectImportIssues(files: string[]): Promise<Array<Record<string, unknown>>> {
	const importableFiles: string[] = files.filter((filePath: string): boolean => {
		const extension: string = path.extname(filePath).toLowerCase();
		return [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ogg", ".mp3", ".wav", ".ttf", ".otf"].includes(extension);
	});
	const issues: Array<Record<string, unknown>> = [];
	for (const filePath of importableFiles) {
		const importPath: string = `${filePath}.import`;
		if (!await pathExists(importPath)) {
			issues.push({
				resourcePath: filePath,
				issue: "missing_import_metadata"
			});
			continue;
		}
		try {
			await getImportMetadata(filePath);
		} catch (error: unknown) {
			issues.push({
				resourcePath: filePath,
				issue: "invalid_import_metadata",
				message: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return issues;
}

async function auditProjectHealth(args: {
	includeAddons?: boolean | undefined;
	limit?: number | undefined;
}): Promise<Record<string, unknown>> {
	const limit: number = Math.min(Math.max(args.limit ?? MAX_RESULTS, 1), MAX_RESULTS);
	const dependencies = await collectDependencyData(args.includeAddons);
	const globalClassesResult = await listProjectGlobalClasses({ includeAddons: args.includeAddons, limit: MAX_RESULTS });
	const globalClasses: ProjectGlobalClass[] = globalClassesResult.classes as ProjectGlobalClass[];
	const testsResult = await listProjectTests({ limit: MAX_RESULTS });
	const csharpResult = await inspectCsharpProjectSupport({ limit: MAX_RESULTS });
	const importIssues: Array<Record<string, unknown>> = await collectImportIssues(dependencies.files);
	const duplicateGlobalClasses: Array<Record<string, unknown>> = findDuplicateGlobalClasses(globalClasses);
	const issues: Array<Record<string, unknown>> = [
		...dependencies.missingReferences.map((reference: ResourceReference): Record<string, unknown> => ({ kind: "missing_resource_reference", ...reference })),
		...dependencies.cycles.map((cycle: string[]): Record<string, unknown> => ({ kind: "cyclic_resource_dependency", cycle })),
		...duplicateGlobalClasses.map((duplicate: Record<string, unknown>): Record<string, unknown> => ({ kind: "duplicate_global_class", ...duplicate })),
		...importIssues.map((issue: Record<string, unknown>): Record<string, unknown> => ({ kind: "import_metadata", ...issue }))
	];
	return {
		includeAddons: args.includeAddons === true,
		status: issues.length === 0 ? "ok" : "issues_found",
		summary: {
			analyzedFiles: dependencies.analyzedFiles.length,
			referenceCount: dependencies.references.length,
			missingResourceReferences: dependencies.missingReferences.length,
			cycleCandidates: dependencies.cycles.length,
			globalClassCount: globalClasses.length,
			duplicateGlobalClasses: duplicateGlobalClasses.length,
			discoveredTests: testsResult.count,
			csharpProjects: csharpResult.projectCount,
			csharpSolutions: csharpResult.solutionCount,
			importIssues: importIssues.length
		},
		issues: issues.slice(0, limit),
		testDiscovery: {
			count: testsResult.count,
			tests: (testsResult.tests as ProjectTestEntry[]).slice(0, limit)
		},
		csharpSupport: csharpResult,
		truncated: issues.length > limit
	};
}

export function registerProjectAnalysisTools(server: McpServer): void {
	server.registerTool(
		"analyze_project_dependencies",
		{
			title: "Analyze Godot Project Dependencies",
			description: "Read-only scan of Godot text resources for res:// dependencies, missing references, and circular dependencies.",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("Defaults to false.")
			})
		},
		async ({ includeAddons }) => asJsonTextResult(await analyzeProjectDependencies(includeAddons))
	);

	server.registerTool(
		"find_unused_resources",
		{
			title: "Find Unused Godot Resources",
			description: "Read-only best-effort unused resource scan based on res:// references in project text resources.",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("Defaults to false.")
			})
		},
		async ({ includeAddons }) => asJsonTextResult(await findUnusedResources(includeAddons))
	);

	server.registerTool(
		"find_scene_nodes",
		{
			title: "Find Godot Scene Nodes",
			description: "Read-only cross-scene node search by type, name, attached script, group, or signal.",
			inputSchema: z.object({
				scenePath: z.string().optional(),
				nodeType: z.string().optional(),
				name: z.string().optional(),
				scriptPath: z.string().optional(),
				group: z.string().optional(),
				signal: z.string().optional(),
				includeAddons: z.boolean().optional(),
				limit: z.number().int().min(1).max(MAX_RESULTS).optional()
			})
		},
		async (args) => asJsonTextResult(await findSceneNodes(args))
	);

	server.registerTool(
		"find_script_references",
		{
			title: "Find Godot Script References",
			description: "Read-only scan for all res:// references to a script path.",
			inputSchema: z.object({
				scriptPath: z.string().min(1).describe("Script path, for example res://scripts/player.gd."),
				includeAddons: z.boolean().optional()
			})
		},
		async ({ scriptPath, includeAddons }) => asJsonTextResult(await findScriptReferences(scriptPath, includeAddons))
	);

	server.registerTool(
		"list_project_global_classes",
		{
			title: "List Godot Global Classes",
			description: "Read-only scan for GDScript class_name declarations and C# [GlobalClass] classes.",
			inputSchema: z.object({
				filter: z.string().optional(),
				includeAddons: z.boolean().optional().describe("Defaults to false."),
				limit: z.number().int().min(1).max(MAX_RESULTS).optional()
			})
		},
		async (args) => asJsonTextResult(await listProjectGlobalClasses(args))
	);

	server.registerTool(
		"list_project_tests",
		{
			title: "List Godot Project Tests",
			description: "Read-only static discovery for GUT, GdUnit, and Python test files. This does not run tests.",
			inputSchema: z.object({
				searchPath: z.string().optional().describe("Project-relative or res:// path. Defaults to test/ and tests/."),
				framework: z.enum(["gut", "gdunit", "python"]).optional(),
				limit: z.number().int().min(1).max(MAX_RESULTS).optional()
			})
		},
		async (args) => asJsonTextResult(await listProjectTests(args))
	);

	server.registerTool(
		"inspect_csharp_project_support",
		{
			title: "Inspect Godot C# Project Support",
			description: "Read-only scan of .csproj and .sln files for TargetFramework, Godot SDK, package references, and project references.",
			inputSchema: z.object({
				searchPath: z.string().optional().describe("Project-relative or res:// path. Defaults to project root."),
				limit: z.number().int().min(1).max(MAX_RESULTS).optional()
			})
		},
		async (args) => asJsonTextResult(await inspectCsharpProjectSupport(args))
	);

	server.registerTool(
		"get_import_metadata",
		{
			title: "Get Godot Import Metadata",
			description: "Read-only parser for a resource's .import metadata file.",
			inputSchema: z.object({
				resourcePath: z.string().min(1).describe("Resource path, for example res://assets/player.png.")
			})
		},
		async ({ resourcePath }) => asJsonTextResult(await getImportMetadata(resourcePath))
	);

	server.registerTool(
		"audit_project_health",
		{
			title: "Audit Godot Project Health",
			description: "Read-only static health audit combining dependency, global class, test, C#, and import metadata checks.",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("Defaults to false."),
				limit: z.number().int().min(1).max(MAX_RESULTS).optional()
			})
		},
		async (args) => asJsonTextResult(await auditProjectHealth(args))
	);
}
