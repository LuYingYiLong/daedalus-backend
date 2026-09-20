import { packageFlowImageRuntime } from "./package-flow-image-runtime.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
        backendPayloadManifestV1Schema,
        backendReleaseManifestV1Schema,
        type BackendPayloadManifestV1,
        type BackendReleaseManifestV1
} from "../src/distribution/binary-manifest.js";
import { RUNTIME_ASSET_PATHS } from "../src/runtime/runtime-assets.js";

const execFileAsync = promisify(execFile);
const MINIMUM_NODE_VERSION: readonly [number, number, number] = [24, 18, 0];
const SEA_FUSE: string = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const PROJECT_ROOT: string = resolve(import.meta.dirname, "..");
const OUTPUT_ROOT: string = resolve(PROJECT_ROOT, "dist", "sea-linux-x64");
const WORK_ROOT: string = resolve(OUTPUT_ROOT, "work");
const RELEASE_ROOT: string = resolve(OUTPUT_ROOT, "release");
const PAYLOAD_ROOT: string = resolve(WORK_ROOT, "payload");
const BUNDLE_PATH: string = resolve(WORK_ROOT, "backend.cjs");
const SEA_CONFIG_PATH: string = resolve(WORK_ROOT, "sea-config.json");
const SEA_BLOB_PATH: string = resolve(WORK_ROOT, "sea-prep.blob");
const EXECUTABLE_PATH: string = resolve(PAYLOAD_ROOT, "daedalus-backend");
const PAYLOAD_MANIFEST_PATH: string = resolve(PAYLOAD_ROOT, "backend-manifest.json");
const ARCHIVE_PATH: string = resolve(RELEASE_ROOT, "daedalus-backend-linux-x64.zip");
const RELEASE_MANIFEST_PATH: string = resolve(RELEASE_ROOT, "daedalus-backend-linux-x64.json");
const CHECKSUMS_PATH: string = resolve(RELEASE_ROOT, "SHA256SUMS.txt");
const SBOM_PATH: string = resolve(RELEASE_ROOT, "daedalus-backend-linux-x64.cdx.json");

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

async function sha256File(filePath: string): Promise<string> {
        return sha256(await readFile(filePath));
}

async function run(
        command: string,
        args: readonly string[],
        options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
        const result = await execFileAsync(command, [...args], {
                cwd: options.cwd ?? PROJECT_ROOT,
                env: options.env ?? process.env,
                maxBuffer: 32 * 1024 * 1024
        });
        return {
                stdout: result.stdout,
                stderr: result.stderr
        };
}

function parseNodeVersion(version: string): [number, number, number] | null {
        const match: RegExpMatchArray | null = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
        return match === null
                ? null
                : [
                        Number.parseInt(match[1]!, 10),
                        Number.parseInt(match[2]!, 10),
                        Number.parseInt(match[3]!, 10)
                ];
}

function assertSupportedNodeVersion(): void {
        const parsed: [number, number, number] | null = parseNodeVersion(process.versions.node);
        if (parsed === null || parsed[0] !== MINIMUM_NODE_VERSION[0]) {
                throw new Error(`Linux SEA requires Node ${MINIMUM_NODE_VERSION.join(".")} or newer within Node 24, got ${process.versions.node}.`);
        }
        for (let index: number = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
                if (parsed[index]! !== MINIMUM_NODE_VERSION[index]!) {
                        if (parsed[index]! < MINIMUM_NODE_VERSION[index]!) {
                                throw new Error(`Linux SEA requires Node ${MINIMUM_NODE_VERSION.join(".")} or newer, got ${process.versions.node}.`);
                        }
                        break;
                }
        }
}

async function assertBuildEnvironment(): Promise<void> {
        if (process.platform !== "linux" || process.arch !== "x64") {
                throw new Error(`Linux SEA must be built on linux-x64, got ${process.platform}-${process.arch}.`);
        }
        assertSupportedNodeVersion();
        for (const sourcePath of Object.values(RUNTIME_ASSET_PATHS)) {
                const absolutePath: string = resolve(PROJECT_ROOT, sourcePath);
                const info = await stat(absolutePath).catch((): null => null);
                if (info === null || !info.isFile()) {
                        throw new Error(`Missing runtime asset: ${sourcePath}`);
                }
        }
}

async function readPackageManifest(): Promise<PackageManifest> {
        return JSON.parse(await readFile(resolve(PROJECT_ROOT, "package.json"), "utf8")) as PackageManifest;
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
        for (const pattern of [
                /["']--import["']\s*,\s*["']tsx["']/u,
                /process\.cwd\(\)[^\n]*["']package\.json["']/u,
                /import\(KEYTAR_MODULE_NAME\)/u,
                /["']node_modules["']\s*,\s*BACKEND_PACKAGE_NAME/u
        ]) {
                if (pattern.test(bundleText)) {
                        throw new Error(`SEA bundle contains a development runtime path: ${String(pattern)}`);
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
        await writeFile(
                SEA_CONFIG_PATH,
                `${JSON.stringify({
                        main: BUNDLE_PATH,
                        output: SEA_BLOB_PATH,
                        disableExperimentalSEAWarning: true,
                        useSnapshot: false,
                        useCodeCache: false,
                        execArgvExtension: "none",
                        assets
                }, null, 2)}\n`,
                "utf8"
        );
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
        await chmod(EXECUTABLE_PATH, 0o755);
}

function parseLastJsonObject(text: string): Record<string, unknown> {
        const lines: string[] = text.split(/\r?\n/u).map((line: string): string => line.trim()).filter(Boolean);
        for (let index: number = lines.length - 1; index >= 0; index -= 1) {
                try {
                        const value: unknown = JSON.parse(lines[index]!);
                        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                                return value as Record<string, unknown>;
                        }
                } catch {
                        // Continue looking for the structured CLI response.
                }
        }
        throw new Error("Backend command did not return a JSON result.");
}

async function runExecutableSelfTests(manifest: BackendPayloadManifestV1): Promise<void> {
        const profilePath: string = resolve(WORK_ROOT, "self-test-profile");
        await mkdir(profilePath, { recursive: true });
        const env: NodeJS.ProcessEnv = {
                ...process.env,
                USERPROFILE: profilePath,
                DAEDALUS_LOG_CONSOLE: "0"
        };
        const versionResult = await run(EXECUTABLE_PATH, ["version", "--json"], { env });
        const version = parseLastJsonObject(versionResult.stdout);
        if (version.distribution !== "sea" || version.platform !== manifest.platform || version.arch !== manifest.arch) {
                throw new Error("Generated Linux backend did not report the expected SEA identity.");
        }
        const selfTestResult = await run(EXECUTABLE_PATH, ["self-test", "--json"], { env });
        const selfTest = parseLastJsonObject(selfTestResult.stdout);
        const build = typeof selfTest.build === "object" && selfTest.build !== null
                ? selfTest.build as Record<string, unknown>
                : {};
        if (
                selfTest.ok !== true
                || build.version !== manifest.version
                || build.buildId !== manifest.buildId
                || build.distribution !== "sea"
                || build.platform !== manifest.platform
                || build.arch !== manifest.arch
                || build.protocolVersion !== manifest.protocolVersion
        ) {
                throw new Error(`Generated Linux backend self-test failed: ${selfTestResult.stdout}`);
        }
}

async function createArchive(): Promise<void> {
        await run("zip", ["-r", "-9", ARCHIVE_PATH, "daedalus-backend", "backend-manifest.json", "media"], {
                cwd: PAYLOAD_ROOT
        });
}

async function createSbom(): Promise<void> {
        const result = await run("npm", ["sbom", "--omit=dev", "--sbom-format", "cyclonedx"]);
        await writeFile(SBOM_PATH, result.stdout, "utf8");
}

async function main(): Promise<void> {
        await assertBuildEnvironment();
        const packageManifest: PackageManifest = await readPackageManifest();
        const buildId: string = await resolveBuildId(packageManifest.version);
        const publishedAt: string = new Date().toISOString();
        await rm(OUTPUT_ROOT, { recursive: true, force: true });
        await Promise.all([
                mkdir(PAYLOAD_ROOT, { recursive: true }),
                mkdir(RELEASE_ROOT, { recursive: true })
        ]);

        await buildBundle(packageManifest, buildId);
        await generateSeaExecutable();
	await packageFlowImageRuntime(PROJECT_ROOT, PAYLOAD_ROOT);
        const executableInfo = await stat(EXECUTABLE_PATH);
        const payloadManifest: BackendPayloadManifestV1 = backendPayloadManifestV1Schema.parse({
                schemaVersion: 1,
                version: packageManifest.version,
                buildId,
                platform: "linux",
                arch: "x64",
                nodeVersion: process.versions.node,
                protocolVersion: packageManifest.daedalusBinary.protocolVersion,
                minBridgeProtocolVersion: packageManifest.daedalusBinary.minBridgeProtocolVersion,
                maxBridgeProtocolVersion: packageManifest.daedalusBinary.maxBridgeProtocolVersion,
                minStudioVersion: packageManifest.daedalusBinary.minStudioVersion,
                publishedAt,
                authenticode: "unsigned",
                executable: {
                        fileName: "daedalus-backend",
                        size: executableInfo.size,
                        sha256: await sha256File(EXECUTABLE_PATH)
                },
                sandboxHelper: null
        });
        await writeFile(PAYLOAD_MANIFEST_PATH, `${JSON.stringify(payloadManifest, null, 2)}\n`, "utf8");
        await runExecutableSelfTests(payloadManifest);
        await createArchive();

        const archiveInfo = await stat(ARCHIVE_PATH);
        const releaseManifest: BackendReleaseManifestV1 = backendReleaseManifestV1Schema.parse({
                ...payloadManifest,
                archive: {
                        fileName: "daedalus-backend-linux-x64.zip",
                        size: archiveInfo.size,
                        sha256: await sha256File(ARCHIVE_PATH)
                },
                payloadManifestSha256: await sha256File(PAYLOAD_MANIFEST_PATH)
        });
        await writeFile(RELEASE_MANIFEST_PATH, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
        await createSbom();
        await writeFile(
                CHECKSUMS_PATH,
                [
                        `${await sha256File(ARCHIVE_PATH)}  daedalus-backend-linux-x64.zip`,
                        `${await sha256File(RELEASE_MANIFEST_PATH)}  daedalus-backend-linux-x64.json`,
                        `${await sha256File(SBOM_PATH)}  daedalus-backend-linux-x64.cdx.json`,
                        ""
                ].join("\n"),
                "utf8"
        );
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
