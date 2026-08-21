import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { encodeHarnessRequest, parseHarnessEvent } from "../../../src/plugins/harness/bridge-protocol.js";
import { readHarnessRuntimeConfig, updateHarnessRuntimeConfig } from "../../../src/plugins/harness/config-store.js";
import { detectHarnessInstallation } from "../../../src/plugins/harness/installation.js";
import { createSanitizedHarnessPatch, parseHarnessBundlePatch } from "../../../src/plugins/harness/patch-parser.js";
import { invokeHarness, startHarnessSidecar, stopHarnessSidecar } from "../../../src/plugins/harness/runner.js";
import { getPluginToolEntries } from "../../../src/plugins/runtime/registries.js";
import type { HarnessInstallation, PluginRecord } from "../../../src/plugins/types.js";

test("Harness patch preview bounds rows and reports dynamic and skipped entries", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-harness-patch-"));
	await writeFile(join(root, "cordis.patch.yml"), [
		"- insert:",
		"    - id: valid",
		"      name: example-plugin",
		"      config:",
		"        value: !!js ctx.value",
		"    - id: missing-name",
		"- unknown:",
		"    - id: ignored",
		"      name: ignored-plugin",
		""
	].join("\n"), "utf8");
	try {
		const summary = await parseHarnessBundlePatch(root, "./cordis.patch.yml");
		assert.deepEqual(summary.operations, ["insert"]);
		assert.equal(summary.totalRows, 2);
		assert.equal(summary.bridgeableRows, 1);
		assert.equal(summary.skippedRows[0]?.id, "missing-name");
		assert.match(summary.dangerousConstructs.join("\n"), /!!js/u);
		assert.match(summary.warnings.join("\n"), /unknown/u);
		const sanitized = await createSanitizedHarnessPatch(root, "./cordis.patch.yml", summary);
		assert.match(sanitized, /id: valid/u);
		assert.doesNotMatch(sanitized, /missing-name|unknown|ignored-plugin/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Harness patch preview rejects package path escape", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-harness-escape-"));
	try {
		await assert.rejects(() => parseHarnessBundlePatch(root, "../outside.yml"), /package-relative|escapes/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Harness bridge uses bounded newline JSON-RPC frames", (): void => {
	const frame = encodeHarnessRequest({ jsonrpc: "2.0", id: "health", method: "health", params: {} });
	assert.equal(frame.endsWith("\n"), true);
	const parsed = parseHarnessEvent(JSON.stringify({ jsonrpc: "2.0", id: "health", result: { ready: true } }));
	assert.equal("id" in parsed ? parsed.id : undefined, "health");
	assert.throws(() => parseHarnessEvent(JSON.stringify({ type: "ready" })), /JSON-RPC/u);
});

test("Harness config uses revision checks and never enables networking", async (): Promise<void> => {
	const originalProfile: string | undefined = process.env.USERPROFILE;
	const profileRoot: string = await mkdtemp(join(tmpdir(), "daedalus-harness-config-"));
	try {
		process.env.USERPROFILE = profileRoot;
		const initial = await readHarnessRuntimeConfig();
		const updated = await updateHarnessRuntimeConfig({ enabled: true, executablePath: join(profileRoot, "dsh.cmd"), sourceRoot: null, launchMode: "installed" }, initial.revision);
		assert.equal(updated.config.enabled, true);
		assert.equal(updated.config.network, "disabled");
		await assert.rejects(() => updateHarnessRuntimeConfig({ enabled: false, executablePath: null, sourceRoot: null, launchMode: "installed" }, initial.revision), /changed externally/u);
		const detection = await detectHarnessInstallation(updated.config);
		assert.equal(detection.status, "failed");
	} finally {
		if (originalProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalProfile;
		await rm(profileRoot, { recursive: true, force: true });
	}
});

test("fake Harness Sidecar performs the versioned handshake and publishes isolated tools", async (t): Promise<void> => {
	const originalProfile: string | undefined = process.env.USERPROFILE;
	const profileRoot: string = await mkdtemp(join(tmpdir(), "daedalus-harness-sidecar-home-"));
	const packageRoot: string = await mkdtemp(join(tmpdir(), "daedalus-harness-sidecar-plugin-"));
	const fakeHarnessRoot = fileURLToPath(new URL("../../fixtures/harness-sidecar", import.meta.url));
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-harness-bundle", version: "1.0.0", type: "module" }), "utf8");
	await writeFile(join(packageRoot, "index.js"), "export function apply() {}\n", "utf8");
	await writeFile(join(packageRoot, "cordis.patch.yml"), "- insert:\n    - id: fixture\n      name: fixture-harness-bundle\n", "utf8");
	const record: PluginRecord = {
		id: "fixture-harness-bundle@1.0.0",
		packageName: "fixture-harness-bundle",
		version: "1.0.0",
		source: { type: "local", path: packageRoot },
		packageRoot,
		contentHash: "content",
		manifestHash: "manifest",
		fingerprint: "fingerprint",
		compatibility: { daedalus: "unknown", harnessBundle: true, harnessClient: false, patchPath: "./cordis.patch.yml", patchExists: true, entryPaths: ["index.js"], unsupportedFeatures: [], warnings: [], classification: "harness-bundle" },
		trust: "trusted",
		enabled: true,
		installedAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString()
	};
	const installation: HarnessInstallation = {
		status: "detected",
		launchMode: "source",
		version: "0.0.1",
		command: process.execPath,
		args: [join(fakeHarnessRoot, "apps", "cli", "lib", "bin.js")],
		readOnlyPaths: [fakeHarnessRoot],
		bridgeProtocolVersion: 1,
		bridgeCompatible: true,
		dependenciesReady: true
	};
	try {
		process.env.USERPROFILE = profileRoot;
		let handle;
		try {
			handle = await startHarnessSidecar(record, { pluginId: record.id, sessionId: "fixture-session", workspaceRoot: packageRoot, capabilities: ["tools", "skills", "hooks", "mcp"] }, installation, { onSnapshot: (): void => undefined, onClosed: (): void => undefined });
		} catch (error: unknown) {
			if ((error as { code?: unknown }).code === "plugin_harness_sandbox_unavailable") { t.skip("OS sandbox is unavailable in this test environment."); return; }
			throw error;
		}
		assert.equal(getPluginToolEntries().some((tool): boolean => tool.pluginId === record.id && tool.namespace === "harness"), true);
		assert.deepEqual(await invokeHarness(handle, "tool", "fixture_echo", { value: "ready" }), { echoed: "ready" });
		await stopHarnessSidecar(handle);
	} finally {
		if (originalProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalProfile;
		await rm(profileRoot, { recursive: true, force: true });
		await rm(packageRoot, { recursive: true, force: true });
	}
});
