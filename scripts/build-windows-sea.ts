import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	copyFile,
	mkdir,
	readFile,
	rm,
	stat,
	writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import {
	backendPayloadManifestV1Schema,
	backendReleaseManifestV1Schema,
	type BackendPayloadManifestV1,
	type BackendReleaseManifestV1
} from "../src/distribution/binary-manifest.js";
import { RUNTIME_ASSET_PATHS } from "../src/runtime/runtime-assets.js";

const execFileAsync = promisify(execFile);
const MINIMUM_NODE_VERSION: readonly [number, number, number] = [24, 18, 0];
const MINIMUM_NODE_VERSION_TEXT: string = MINIMUM_NODE_VERSION.join(".");
const SEA_FUSE: string = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const PROJECT_ROOT: string = resolve(import.meta.dirname, "..");
const OUTPUT_ROOT: string = resolve(PROJECT_ROOT, "dist", "sea-win32-x64");
const WORK_ROOT: string = resolve(OUTPUT_ROOT, "work");
const RELEASE_ROOT: string = resolve(OUTPUT_ROOT, "release");
const PAYLOAD_ROOT: string = resolve(WORK_ROOT, "payload");
const BUNDLE_PATH: string = resolve(WORK_ROOT, "backend.cjs");
const SEA_CONFIG_PATH: string = resolve(WORK_ROOT, "sea-config.json");
const SEA_BLOB_PATH: string = resolve(WORK_ROOT, "sea-prep.blob");
const EXECUTABLE_PATH: string = resolve(PAYLOAD_ROOT, "daedalus-backend.exe");
const PAYLOAD_MANIFEST_PATH: string = resolve(PAYLOAD_ROOT, "backend-manifest.json");
const ARCHIVE_PATH: string = resolve(RELEASE_ROOT, "daedalus-backend-win32-x64.zip");
const RELEASE_MANIFEST_PATH: string = resolve(RELEASE_ROOT, "daedalus-backend-win32-x64.json");
const CHECKSUMS_PATH: string = resolve(RELEASE_ROOT, "SHA256SUMS.txt");
const SBOM_PATH: string = resolve(RELEASE_ROOT, "daedalus-backend-win32-x64.cdx.json");

type PackageManifest = {
	version: string;
	daedalusBinary: {
		minStudioVersion: string;
		protocolVersion: number;
		minBridgeProtocolVersion: number;
		maxBridgeProtocolVersion: number;
	};
};

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
	return sha256(await readFile(path));
}

async function run(command: string, args: readonly string[], options: {
	cwd?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
} = {}): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync(command, [...args], {
		cwd: options.cwd ?? PROJECT_ROOT,
		env: options.env ?? process.env,
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr
	};
}

async function readPackageManifest(): Promise<PackageManifest> {
	return JSON.parse(await readFile(resolve(PROJECT_ROOT, "package.json"), "utf8")) as PackageManifest;
}

function parseNodeVersion(version: string): [number, number, number] | null {
	const match: RegExpMatchArray | null = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
	if (match === null) {
		return null;
	}
	return [
		Number.parseInt(match[1]!, 10),
		Number.parseInt(match[2]!, 10),
		Number.parseInt(match[3]!, 10)
	];
}

function isSupportedNodeVersion(version: string): boolean {
	const parsed: [number, number, number] | null = parseNodeVersion(version);
	if (parsed === null || parsed[0] !== MINIMUM_NODE_VERSION[0]) {
		return false;
	}
	for (let index: number = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
		if (parsed[index]! !== MINIMUM_NODE_VERSION[index]) {
			return parsed[index]! > MINIMUM_NODE_VERSION[index]!;
		}
	}
	return true;
}

async function resolveBuildId(version: string): Promise<string> {
	const githubSha: string = process.env.GITHUB_SHA?.trim() ?? "";
	if (githubSha.length >= 7) {
		return `${version}-${githubSha.slice(0, 12)}`;
	}
	try {
		const result = await run("git", ["rev-parse", "--short=12", "HEAD"]);
		const sha: string = result.stdout.trim();
		return sha.length > 0 ? `${version}-${sha}` : `${version}-local`;
	} catch {
		return `${version}-local`;
	}
}

async function assertBuildEnvironment(): Promise<void> {
	if (process.platform !== "win32" || process.arch !== "x64") {
		throw new Error(`Windows SEA must be built on win32-x64, got ${process.platform}-${process.arch}.`);
	}
	if (!isSupportedNodeVersion(process.versions.node)) {
		throw new Error(`Windows SEA requires Node ${MINIMUM_NODE_VERSION_TEXT} or newer within Node 24, got ${process.versions.node}.`);
	}
	for (const sourcePath of Object.values(RUNTIME_ASSET_PATHS)) {
		const absolutePath: string = resolve(PROJECT_ROOT, sourcePath);
		const info = await stat(absolutePath).catch((): null => null);
		if (info === null || !info.isFile()) {
			throw new Error(`Missing runtime asset: ${sourcePath}`);
		}
	}
}

async function buildBundle(manifest: PackageManifest, buildId: string): Promise<void> {
	await build({
		entryPoints: [resolve(PROJECT_ROOT, "src", "cli.ts")],
		outfile: BUNDLE_PATH,
		bundle: true,
		platform: "node",
		target: "node24",
		format: "cjs",
		packages: "bundle",
		external: ["keytar"],
		sourcemap: false,
		minify: false,
		minifySyntax: true,
		treeShaking: true,
		legalComments: "none",
		define: {
			__DAEDALUS_BACKEND_VERSION__: JSON.stringify(manifest.version),
			__DAEDALUS_BUILD_ID__: JSON.stringify(buildId),
			__DAEDALUS_BUILD_NODE_VERSION__: JSON.stringify(process.versions.node),
			__DAEDALUS_SEA_BUILD__: "true"
		}
	});
	const bundleText: string = await readFile(BUNDLE_PATH, "utf8");
	const forbiddenRuntimePatterns: readonly RegExp[] = [
		/["']--import["']\s*,\s*["']tsx["']/u,
		/process\.cwd\(\)[^\n]*["']package\.json["']/u,
		/import\(KEYTAR_MODULE_NAME\)/u,
		/["']node_modules["']\s*,\s*BACKEND_PACKAGE_NAME/u
	];
	for (const pattern of forbiddenRuntimePatterns) {
		if (pattern.test(bundleText)) {
			throw new Error(`SEA bundle still contains a development runtime path: ${String(pattern)}`);
		}
	}
}

async function generateSeaExecutable(): Promise<void> {
	const assets = Object.fromEntries(
		Object.entries(RUNTIME_ASSET_PATHS).map(([key, sourcePath]): [string, string] => [
			key,
			resolve(PROJECT_ROOT, sourcePath)
		])
	);
	await writeFile(SEA_CONFIG_PATH, `${JSON.stringify({
		main: BUNDLE_PATH,
		output: SEA_BLOB_PATH,
		disableExperimentalSEAWarning: true,
		useSnapshot: false,
		useCodeCache: false,
		execArgvExtension: "none",
		assets
	}, null, 2)}\n`, "utf8");
	await run(process.execPath, ["--experimental-sea-config", SEA_CONFIG_PATH]);
	await copyFile(process.execPath, EXECUTABLE_PATH);
	await run(process.execPath, [
		resolve(PROJECT_ROOT, "node_modules", "postject", "dist", "cli.js"),
		EXECUTABLE_PATH,
		"NODE_SEA_BLOB",
		SEA_BLOB_PATH,
		"--sentinel-fuse",
		SEA_FUSE
	]);
}

async function createArchive(): Promise<void> {
	await run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Compress-Archive -LiteralPath @($env:DAEDALUS_EXE, $env:DAEDALUS_PAYLOAD_MANIFEST) -DestinationPath $env:DAEDALUS_ARCHIVE -CompressionLevel Optimal -Force"
	], {
		env: {
			...process.env,
			DAEDALUS_EXE: EXECUTABLE_PATH,
			DAEDALUS_PAYLOAD_MANIFEST: PAYLOAD_MANIFEST_PATH,
			DAEDALUS_ARCHIVE: ARCHIVE_PATH
		}
	});
}

async function runExecutableSelfTests(payloadManifest: BackendPayloadManifestV1): Promise<void> {
	const testProfile: string = resolve(WORK_ROOT, "self-test-profile");
	await mkdir(testProfile, { recursive: true });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		USERPROFILE: testProfile,
		DAEDALUS_LOG_CONSOLE: "0"
	};
	const versionResult = await run(EXECUTABLE_PATH, ["version", "--json"], { env });
	const version = JSON.parse(versionResult.stdout) as { distribution?: unknown };
	if (version.distribution !== "sea") {
		throw new Error("Generated executable did not report the SEA distribution.");
	}
	const selfTestResult = await run(EXECUTABLE_PATH, ["self-test", "--json"], { env });
	const selfTest = JSON.parse(selfTestResult.stdout) as {
		ok?: unknown;
		build?: Record<string, unknown>;
		checks?: Array<Record<string, unknown>>;
	};
	const passedChecks: Set<unknown> = new Set(
		selfTest.checks
			?.filter((check): boolean => check.ok === true)
			.map((check): unknown => check.name)
	);
	if (
		selfTest.ok !== true
		|| selfTest.build?.version !== payloadManifest.version
		|| selfTest.build?.buildId !== payloadManifest.buildId
		|| selfTest.build?.buildNodeVersion !== payloadManifest.nodeVersion
		|| selfTest.build?.runtimeNodeVersion !== payloadManifest.nodeVersion
		|| selfTest.build?.distribution !== "sea"
		|| selfTest.build?.platform !== payloadManifest.platform
		|| selfTest.build?.arch !== payloadManifest.arch
		|| selfTest.build?.protocolVersion !== payloadManifest.protocolVersion
		|| !passedChecks.has("runtime-assets")
		|| !passedChecks.has("sqlite")
		|| !passedChecks.has("secret-store")
	) {
		throw new Error(`Generated executable self-test failed: ${selfTestResult.stdout}`);
	}
}

async function runSessionSearchIndexerSmokeTest(): Promise<void> {
	const profilePath: string = resolve(WORK_ROOT, "session-search-smoke-profile");
	await mkdir(profilePath, { recursive: true });
	const child: ChildProcessWithoutNullStreams = spawn(
		EXECUTABLE_PATH,
		["internal", "session-search-indexer"],
		{
			cwd: dirname(EXECUTABLE_PATH),
			windowsHide: true,
			env: { ...process.env, USERPROFILE: profilePath, DAEDALUS_LOG_CONSOLE: "0" },
			stdio: ["pipe", "pipe", "pipe"]
		}
	);
	let stderr: string = "";
	child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString("utf8"); });
	child.stdin.write(`${JSON.stringify({ id: "sea-search-cancel", type: "cancel", sessionId: "session-sea-smoke" })}\n`);
	child.stdin.write(`${JSON.stringify({ id: "sea-search-shutdown", type: "shutdown" })}\n`);
	const exitCode: number | null = await waitForChildExit(child, 15_000);
	if (exitCode !== 0) {
		throw new Error(`SEA session search indexer smoke test failed with ${String(exitCode)}: ${stderr}`);
	}
}

type DocumentationIndexerSmokeResponse = {
	id: string;
	type: "progress" | "completed" | "error";
	message?: string;
	summary?: {
		documentCount: number;
		chunkCount: number;
		classCount: number;
		sizeBytes: number;
	};
};

async function runDocumentationIndexerSmokeCommand(
	profilePath: string,
	command: Record<string, unknown>
): Promise<DocumentationIndexerSmokeResponse> {
	const child: ChildProcessWithoutNullStreams = spawn(
		EXECUTABLE_PATH,
		["internal", "documentation-indexer"],
		{
			cwd: dirname(EXECUTABLE_PATH),
			windowsHide: true,
			env: { ...process.env, USERPROFILE: profilePath, DAEDALUS_LOG_CONSOLE: "0" },
			stdio: ["pipe", "pipe", "pipe"]
		}
	);
	let stdout: string = "";
	let stderr: string = "";
	child.stdout.on("data", (chunk: Buffer): void => { stdout += chunk.toString("utf8"); });
	child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString("utf8"); });
	child.stdin.end(`${JSON.stringify(command)}\n`);
	const exitCode: number | null = await waitForChildExit(child, 15_000);
	if (exitCode !== 0) {
		throw new Error(`SEA documentation indexer smoke command failed with ${String(exitCode)}: ${stderr}`);
	}
	const responses: DocumentationIndexerSmokeResponse[] = stdout
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line: string): DocumentationIndexerSmokeResponse => JSON.parse(line) as DocumentationIndexerSmokeResponse);
	const response = responses.findLast((entry): boolean => entry.type === "completed" || entry.type === "error");
	if (response === undefined || response.type !== "completed") {
		throw new Error(`SEA documentation indexer returned no successful result: ${response?.message ?? stdout}`);
	}
	return response;
}

async function runDocumentationIndexerSmokeTest(): Promise<void> {
	const profilePath: string = resolve(WORK_ROOT, "documentation-indexer-smoke-profile");
	const sourcePath: string = resolve(WORK_ROOT, "documentation-indexer-smoke-source");
	const generationPath: string = resolve(WORK_ROOT, "documentation-indexer-smoke-generation");
	const indexPath: string = resolve(generationPath, "index.sqlite");
	const commitSha: string = "0123456789abcdef0123456789abcdef01234567";
	await mkdir(resolve(sourcePath, "classes"), { recursive: true });
	await mkdir(generationPath, { recursive: true });
	await writeFile(resolve(sourcePath, "conf.py"), "# SEA documentation indexer smoke\n", "utf8");
	await writeFile(resolve(sourcePath, "classes", "class_node.rst"), [
		".. _class_Node:",
		"",
		"Node",
		"====",
		"",
		"Base object for scene tree nodes.",
		""
	].join("\n"), "utf8");

	const cancelled: ChildProcessWithoutNullStreams = spawn(
		EXECUTABLE_PATH,
		["internal", "documentation-indexer"],
		{
			cwd: dirname(EXECUTABLE_PATH),
			windowsHide: true,
			env: { ...process.env, USERPROFILE: profilePath, DAEDALUS_LOG_CONSOLE: "0" },
			stdio: ["pipe", "pipe", "pipe"]
		}
	);
	cancelled.kill();
	await waitForChildExit(cancelled, 5_000);

	const buildId: string = "sea-documentation-build";
	const built = await runDocumentationIndexerSmokeCommand(profilePath, {
		id: buildId,
		type: "build",
		extractedRoot: sourcePath,
		indexPath,
		branch: "4.7",
		commitSha
	});
	if (built.summary === undefined || built.summary.chunkCount < 1) {
		throw new Error("SEA documentation indexer did not build a searchable fixture.");
	}
	const now: string = new Date().toISOString();
	await writeFile(resolve(generationPath, "manifest.json"), `${JSON.stringify({
		schemaVersion: 1,
		indexFormatVersion: 1,
		generationId: "sea-documentation-generation",
		branch: "4.7",
		commitSha,
		sourceSha256: null,
		sqliteSha256: await sha256File(indexPath),
		documentCount: built.summary.documentCount,
		chunkCount: built.summary.chunkCount,
		classCount: built.summary.classCount,
		sizeBytes: (await stat(indexPath)).size,
		builtAt: now,
		verifiedAt: now
	}, null, 2)}\n`, "utf8");
	await runDocumentationIndexerSmokeCommand(profilePath, {
		id: "sea-documentation-check",
		type: "check",
		generationDir: generationPath,
		branch: "4.7",
		commitSha
	});
}

async function reservePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveReady, reject): void => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveReady);
	});
	const address = server.address();
	const port: number = typeof address === "object" && address !== null ? address.port : 0;
	await new Promise<void>((resolveClosed, reject): void => {
		server.close((error?: Error): void => error === undefined ? resolveClosed() : reject(error));
	});
	if (port <= 0) {
		throw new Error("Could not reserve a backend smoke-test port.");
	}
	return port;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
	return new Promise((resolveExit, reject): void => {
		const timer = setTimeout((): void => {
			reject(new Error("Timed out waiting for backend process to exit."));
		}, timeoutMs);
		child.once("exit", (code: number | null): void => {
			clearTimeout(timer);
			resolveExit(code);
		});
		child.once("error", (error: Error): void => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function requestBackend(
	url: string,
	authToken: string | undefined,
	method: string
): Promise<Record<string, unknown>> {
	return new Promise((resolveResponse, reject): void => {
		const socket = new WebSocket(url, {
			headers: authToken === undefined ? undefined : { Authorization: `Bearer ${authToken}` }
		});
		const timer = setTimeout((): void => {
			socket.terminate();
			reject(new Error(`Timed out waiting for ${method}.`));
		}, 15_000);
		socket.once("open", (): void => {
			socket.send(JSON.stringify({
		protocolVersion: 3,
				type: "request",
				id: `sea-smoke-${method}`,
				method,
				params: {}
			}));
		});
		socket.once("message", (data: WebSocket.RawData): void => {
			clearTimeout(timer);
			socket.close();
			const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
			resolveResponse(parsed);
		});
		socket.once("error", (error: Error): void => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function verifyUnauthenticatedConnectionRejected(url: string): Promise<void> {
	await new Promise<void>((resolveRejected, reject): void => {
		const socket = new WebSocket(url);
		const timer = setTimeout((): void => {
			socket.terminate();
			reject(new Error("Unauthenticated WebSocket connection was not rejected."));
		}, 10_000);
		socket.once("open", (): void => {
			clearTimeout(timer);
			socket.close();
			reject(new Error("Unauthenticated WebSocket connection was accepted."));
		});
		socket.once("error", (): void => {
			clearTimeout(timer);
			resolveRejected();
		});
	});
}

async function runServerSmokeTest(): Promise<void> {
	const port: number = await reservePort();
	const authToken: string = randomBytes(32).toString("base64url");
	const connectionId: string = randomBytes(32).toString("base64url");
	const profilePath: string = resolve(WORK_ROOT, "server-smoke-profile");
	await mkdir(profilePath, { recursive: true });
	const child: ChildProcessWithoutNullStreams = spawn(EXECUTABLE_PATH, ["serve"], {
		cwd: dirname(EXECUTABLE_PATH),
		windowsHide: true,
		env: {
			...process.env,
			USERPROFILE: profilePath,
			PORT: String(port),
			DAEDALUS_BACKEND_MODE: "runtime",
			DAEDALUS_BACKEND_AUTH_TOKEN: authToken,
			DAEDALUS_BACKEND_CONNECTION_ID: connectionId,
			DAEDALUS_LOG_CONSOLE: "0"
		},
		stdio: ["pipe", "pipe", "pipe"]
	});
	let output: string = "";
	child.stdout.on("data", (chunk: Buffer): void => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer): void => {
		output += chunk.toString();
	});
	const exitPromise: Promise<number | null> = waitForChildExit(child, 45_000);
	const url: string = `ws://127.0.0.1:${port}`;
	try {
		let healthResponse: Record<string, unknown> | null = null;
		const deadline: number = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				healthResponse = await requestBackend(url, authToken, "backend.health");
				break;
			} catch {
				await new Promise((resolveWait): void => {
					setTimeout(resolveWait, 250);
				});
			}
		}
		if (healthResponse?.ok !== true) {
			throw new Error(`SEA backend health check failed. ${output}`);
		}
		await verifyUnauthenticatedConnectionRejected(url);
		const connectionResult = await run(
			EXECUTABLE_PATH,
			["connection-token", "--connection-id", connectionId, "--json"],
			{
				env: {
					...process.env,
					USERPROFILE: profilePath,
					DAEDALUS_LOG_CONSOLE: "0"
				}
			}
		);
		const connection = JSON.parse(connectionResult.stdout) as {
			ok?: unknown;
			authProtocol?: unknown;
		};
		if (
			connection.ok !== true
			|| connection.authProtocol !== `daedalus-auth.${authToken}`
		) {
			throw new Error("SEA runtime connection credential smoke test failed.");
		}
		const connectionMetadataText: string = await readFile(
			join(profilePath, ".daedalus", "backend", "connection.json"),
			"utf8"
		);
		if (connectionMetadataText.includes(authToken)) {
			throw new Error("SEA runtime connection metadata persisted the authentication token.");
		}
		const shutdownResponse = await requestBackend(url, authToken, "backend.shutdown");
		if (shutdownResponse.ok !== true) {
			throw new Error("SEA backend rejected authenticated shutdown.");
		}
		const exitCode: number | null = await exitPromise;
		if (exitCode !== 0) {
			throw new Error(`SEA backend exited with code ${String(exitCode)}. ${output}`);
		}
	} finally {
		if (child.exitCode === null) {
			child.kill();
		}
	}
}

async function runSharedRuntimeSmokeTest(expectedVersion: string): Promise<void> {
	const profilePath: string = resolve(WORK_ROOT, "shared-runtime-smoke-profile");
	await mkdir(profilePath, { recursive: true });
	const commandEnvironment: NodeJS.ProcessEnv = {
		...process.env,
		USERPROFILE: profilePath,
		DAEDALUS_LOG_CONSOLE: "0"
	};
	const acquireResult = await run(
		EXECUTABLE_PATH,
		["runtime", "acquire", "--client", "studio", "--json"],
		{ env: commandEnvironment }
	);
	const acquire = JSON.parse(acquireResult.stdout) as {
		ok?: unknown;
		url?: unknown;
		authProtocol?: unknown;
		connection?: {
			version?: unknown;
			buildId?: unknown;
		};
	};
	if (
		acquire.ok !== true
		|| typeof acquire.url !== "string"
		|| typeof acquire.authProtocol !== "string"
		|| !acquire.authProtocol.startsWith("daedalus-auth.")
		|| acquire.connection?.version !== expectedVersion
	) {
		throw new Error("SEA shared runtime acquire returned invalid connection metadata.");
	}
	const authToken: string = acquire.authProtocol.slice("daedalus-auth.".length);
	const healthResponse: Record<string, unknown> = await requestBackend(
		acquire.url,
		authToken,
		"backend.health"
	);
	if (healthResponse.ok !== true) {
		throw new Error("SEA shared runtime rejected its acquired credential.");
	}
	const statusResult = await run(
		EXECUTABLE_PATH,
		["runtime", "status", "--json"],
		{ env: commandEnvironment }
	);
	const status = JSON.parse(statusResult.stdout) as {
		ok?: unknown;
		running?: unknown;
		connection?: { buildId?: unknown };
	};
	if (
		status.ok !== true
		|| status.running !== true
		|| status.connection?.buildId !== acquire.connection?.buildId
	) {
		throw new Error("SEA shared runtime status did not report the acquired backend.");
	}
	const shutdownResponse: Record<string, unknown> = await requestBackend(
		acquire.url,
		authToken,
		"backend.shutdown"
	);
	if (shutdownResponse.ok !== true) {
		throw new Error("SEA shared runtime rejected authenticated shutdown.");
	}
	const deadline: number = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const nextStatusResult = await run(
			EXECUTABLE_PATH,
			["runtime", "status", "--json"],
			{ env: commandEnvironment }
		);
		const nextStatus = JSON.parse(nextStatusResult.stdout) as { running?: unknown };
		if (nextStatus.running === false) {
			return;
		}
		await new Promise((resolveWait): void => {
			setTimeout(resolveWait, 200);
		});
	}
	throw new Error("SEA shared runtime did not stop after authenticated shutdown.");
}

async function smokeMcpSubcommand(
	name: "terminal" | "workspace" | "godot" | "skills",
	env: Record<string, string>
): Promise<void> {
	const client = new Client({ name: `sea-smoke-${name}`, version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: EXECUTABLE_PATH,
		args: ["mcp", name],
		env: {
			...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
			...env
		}
	});
	try {
		await client.connect(transport);
		const result = await client.listTools();
		if (!Array.isArray(result.tools) || result.tools.length === 0) {
			throw new Error(`${name} MCP returned no tools.`);
		}
	} finally {
		await client.close();
	}
}

async function runMcpSmokeTests(): Promise<void> {
	const profilePath: string = resolve(WORK_ROOT, "mcp-smoke-profile");
	const workspacePath: string = resolve(WORK_ROOT, "mcp-smoke-workspace");
	await Promise.all([
		mkdir(profilePath, { recursive: true }),
		mkdir(workspacePath, { recursive: true })
	]);
	await writeFile(resolve(workspacePath, "project.godot"), "[application]\nconfig/name=\"SEA Smoke\"\n", "utf8");
	const commonEnv: Record<string, string> = {
		USERPROFILE: profilePath,
		DAEDALUS_LOG_CONSOLE: "0"
	};
	await smokeMcpSubcommand("terminal", {
		...commonEnv,
		BACKEND_DIR: PROJECT_ROOT
	});
	await smokeMcpSubcommand("workspace", {
		...commonEnv,
		WORKSPACE_ID: "sea-smoke",
		WORKSPACE_ROOT: workspacePath
	});
	await smokeMcpSubcommand("godot", {
		...commonEnv,
		GODOT_PROJECT_PATH: workspacePath
	});
	await smokeMcpSubcommand("skills", {
		...commonEnv,
		DAEDALUS_WORKSPACE_ID: "sea-smoke",
		GODOT_PROJECT_PATH: workspacePath
	});
}

async function createSbom(): Promise<void> {
	const result = process.platform === "win32"
		? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm sbom --omit=dev --sbom-format cyclonedx"])
		: await run("npm", ["sbom", "--omit=dev", "--sbom-format", "cyclonedx"]);
	await writeFile(SBOM_PATH, result.stdout, "utf8");
}

async function main(): Promise<void> {
	await assertBuildEnvironment();
	const manifest: PackageManifest = await readPackageManifest();
	const buildId: string = await resolveBuildId(manifest.version);
	const publishedAt: string = new Date().toISOString();
	await rm(OUTPUT_ROOT, { recursive: true, force: true });
	await Promise.all([
		mkdir(PAYLOAD_ROOT, { recursive: true }),
		mkdir(RELEASE_ROOT, { recursive: true })
	]);

	await buildBundle(manifest, buildId);
	await generateSeaExecutable();

	const executableInfo = await stat(EXECUTABLE_PATH);
	const payloadManifest: BackendPayloadManifestV1 = backendPayloadManifestV1Schema.parse({
		schemaVersion: 1,
		version: manifest.version,
		buildId,
		platform: "win32",
		arch: "x64",
		nodeVersion: process.versions.node,
		protocolVersion: manifest.daedalusBinary.protocolVersion,
		minBridgeProtocolVersion: manifest.daedalusBinary.minBridgeProtocolVersion,
		maxBridgeProtocolVersion: manifest.daedalusBinary.maxBridgeProtocolVersion,
		minStudioVersion: manifest.daedalusBinary.minStudioVersion,
		publishedAt,
		authenticode: process.env.DAEDALUS_AUTHENTICODE_SIGNED === "1" ? "signed" : "unsigned",
		executable: {
			fileName: "daedalus-backend.exe",
			size: executableInfo.size,
			sha256: await sha256File(EXECUTABLE_PATH)
		}
	});
	const payloadManifestText: string = `${JSON.stringify(payloadManifest, null, 2)}\n`;
	await writeFile(PAYLOAD_MANIFEST_PATH, payloadManifestText, "utf8");
	await runExecutableSelfTests(payloadManifest);
	await runSessionSearchIndexerSmokeTest();
	await runDocumentationIndexerSmokeTest();
	await runMcpSmokeTests();
	await runServerSmokeTest();
	await runSharedRuntimeSmokeTest(manifest.version);
	await createArchive();

	const archiveInfo = await stat(ARCHIVE_PATH);
	const releaseManifest: BackendReleaseManifestV1 = backendReleaseManifestV1Schema.parse({
		...payloadManifest,
		archive: {
			fileName: "daedalus-backend-win32-x64.zip",
			size: archiveInfo.size,
			sha256: await sha256File(ARCHIVE_PATH)
		},
		payloadManifestSha256: sha256(Buffer.from(payloadManifestText, "utf8"))
	});
	await writeFile(RELEASE_MANIFEST_PATH, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
	await createSbom();
	await writeFile(CHECKSUMS_PATH, [
		`${await sha256File(ARCHIVE_PATH)}  ${dirname(ARCHIVE_PATH) === RELEASE_ROOT ? "daedalus-backend-win32-x64.zip" : ARCHIVE_PATH}`,
		`${await sha256File(RELEASE_MANIFEST_PATH)}  daedalus-backend-win32-x64.json`,
		`${await sha256File(SBOM_PATH)}  daedalus-backend-win32-x64.cdx.json`,
		""
	].join("\n"), "utf8");

	process.stdout.write(`${JSON.stringify({
		ok: true,
		outputDirectory: RELEASE_ROOT,
		executable: EXECUTABLE_PATH,
		archive: ARCHIVE_PATH,
		manifest: RELEASE_MANIFEST_PATH
	}, null, 2)}\n`);
}

main().catch((error: unknown): void => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
