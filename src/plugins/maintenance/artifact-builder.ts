import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getDaedalusPath } from "../../app-paths.js";
import { writeJsonFileAtomic } from "../../json-file-store.js";
import { analyzePluginDirectory } from "../manifest.js";
import type { PluginReleaseArtifact } from "./maintenance-types.js";

function npmCommand(): string { return process.platform === "win32" ? "npm.cmd" : "npm"; }

function runNpm(args: readonly string[], cwd: string): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		const child = spawn(npmCommand(), [...args], { cwd, shell: false, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer): void => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-256_000); });
		child.stderr.on("data", (chunk: Buffer): void => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64_000); });
		child.once("error", reject);
		child.once("close", (code: number | null): void => code === 0 ? resolveOutput(stdout) : reject(Object.assign(new Error(stderr.trim() || "npm pack failed."), { code: "plugin_pack_failed" })));
	});
}

export async function buildPluginArtifact(input: { sourceRoot: string; packageName: string; version: string; fingerprint: string; changelogHash: string; testRunId?: string }): Promise<PluginReleaseArtifact> {
	const sourceRoot = resolve(input.sourceRoot);
	await analyzePluginDirectory(sourceRoot);
	const destination = join(getDaedalusPath("plugins.releases"), input.packageName.replace(/[^a-zA-Z0-9._-]/gu, "_"), input.version);
	await mkdir(destination, { recursive: true });
	const existing = await readdir(destination);
	if (existing.some((entry): boolean => entry.endsWith(".tgz"))) throw Object.assign(new Error("A release artifact for this package version already exists."), { code: "plugin_release_exists" });
	const output = await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", destination, sourceRoot], sourceRoot);
	const parsed: unknown = JSON.parse(output);
	const filename = Array.isArray(parsed) && typeof parsed[0] === "object" && parsed[0] !== null && typeof (parsed[0] as { filename?: unknown }).filename === "string" ? (parsed[0] as { filename: string }).filename : undefined;
	if (filename === undefined) throw Object.assign(new Error("npm pack did not return an artifact filename."), { code: "plugin_pack_invalid" });
	const artifactPath = resolve(destination, basename(filename));
	const bytes = await readFile(artifactPath);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	await writeReleaseManifest(destination, { packageName: input.packageName, version: input.version, fingerprint: input.fingerprint, changelogHash: input.changelogHash, testRunId: input.testRunId ?? null, sha256, byteSize: bytes.byteLength, createdAt: new Date().toISOString() });
	return { path: artifactPath, displayPath: `[daedalus]/plugins/releases/${input.packageName}/${input.version}/${basename(filename)}`, sha256, byteSize: bytes.byteLength };
}

async function writeReleaseManifest(destination: string, value: Record<string, unknown>): Promise<void> {
	await writeJsonFileAtomic(join(destination, "release-manifest.json"), value);
}
