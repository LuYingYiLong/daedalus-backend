import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

type SmokeEvent = {
	kind: string;
	arguments?: string[];
	windowStyle?: string;
	userProfile?: string;
	appData?: string;
	port?: string;
	url?: string;
};

type SmokeOptions = {
	deriveBridgeDir?: boolean;
	missingFile?: string;
	wrongBridgeDir?: boolean;
	godotError?: boolean;
	godotExitCode?: number;
	backendExited?: boolean;
};

const projectFiles: string[] = [
	"project.godot",
	"addons/daedalus_bridge/plugin.cfg",
	"addons/daedalus_bridge/daedalus_bridge.gd",
	"addons/daedalus_bridge/scripts/bridge_runtime.gd",
	"addons/daedalus_bridge/scripts/editor_context.gd",
	"addons/daedalus_bridge/scripts/nested/extra.gd"
];

async function runSmoke(options: SmokeOptions = {}): Promise<{ status: number | null; output: string; events: SmokeEvent[] }> {
	// PowerShell 会展开 Windows 短路径；统一 fixture 根目录再比较隔离边界
	const root: string = await realpath(await mkdtemp(path.join(tmpdir(), "daedalus-smoke-script-")));
	const projectRoot: string = path.join(root, "Bridge project");
	const eventsPath: string = path.join(root, "events.jsonl");
	try {
		for (const file of projectFiles.filter((file: string): boolean => file !== options.missingFile)) {
			const filePath: string = path.join(projectRoot, file);
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, "# fixture\n");
		}
		const smokeTemp: string = path.join(root, "temp");
		await mkdir(smokeTemp);
		const result = spawnSync("pwsh", ["-NoProfile", "-File", "tests/fixtures/beta-smoke/driver.ps1"], {
			cwd: process.cwd(), encoding: "utf8", timeout: 20_000, windowsHide: true,
			env: {
				...process.env,
				TEMP: smokeTemp, TMP: smokeTemp,
				USERPROFILE: root, APPDATA: root, PORT: "39387", WS_URL: "ws://prior.invalid",
				GODOT_PROJECT_PATH: projectRoot,
				GODOT_EXECUTABLE_PATH: path.resolve("tests/fixtures/beta-smoke/godot.ps1"),
				DAEDALUS_BRIDGE_DIR: options.deriveBridgeDir ? "" : path.join(projectRoot, "addons", options.wrongBridgeDir ? "godot_daedalus" : "daedalus_bridge"),
				SMOKE_SCRIPT_PATH: path.resolve("scripts/beta-smoke.ps1"),
				SMOKE_EVENTS_PATH: eventsPath,
				SMOKE_GODOT_ERROR: options.godotError ? "1" : "0",
				SMOKE_GODOT_EXIT_CODE: String(options.godotExitCode ?? 0),
				SMOKE_BACKEND_EXITED: options.backendExited ? "1" : "0"
			}
		});
		assert.ifError(result.error);
		const events: SmokeEvent[] = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).map((line: string): SmokeEvent => JSON.parse(line) as SmokeEvent);
		assert.deepEqual(events.at(-1), { kind: "restored", userProfile: root, appData: root, port: "39387", url: "ws://prior.invalid" });
		const started: SmokeEvent | undefined = events.find((event: SmokeEvent): boolean => event.kind === "start");
		if (started) {
			assert.equal(started.windowStyle, "Hidden");
			assert.ok(started.userProfile?.startsWith(smokeTemp + path.sep), "smoke must not use the real user profile");
		}
		for (const event of events.filter((event: SmokeEvent): boolean => event.kind === "godot")) {
			assert.ok(event.appData?.startsWith(smokeTemp + path.sep), "Godot must not use the real editor settings or logs");
		}
		return { status: result.status, output: result.stdout + result.stderr, events };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

for (const deriveBridgeDir of [false, true]) {
	test(`Beta smoke checks every current Bridge script (derive directory: ${deriveBridgeDir})`, { skip: process.platform !== "win32" }, async (): Promise<void> => {
		const result = await runSmoke({ deriveBridgeDir });
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /Beta smoke passed/);
		const calls: SmokeEvent[] = result.events.filter((event: SmokeEvent): boolean => event.kind === "godot");
		assert.deepEqual(calls.map((call: SmokeEvent): string | undefined => call.arguments?.at(-1)).sort(), projectFiles.filter((file: string): boolean => file.endsWith(".gd")).map((file: string): string => `res://${file}`).sort());
		for (const call of calls) {
			assert.equal(call.arguments?.[0], "--headless");
			assert.equal(call.arguments?.[1], "--path");
			assert.equal(call.arguments?.[3], "--check-only");
			assert.equal(call.arguments?.[4], "--script");
		}
		assert.equal(result.events.find((event: SmokeEvent): boolean => event.kind === "ping")?.url, "ws://127.0.0.1:39387");
		assert.equal(result.events.filter((event: SmokeEvent): boolean => event.kind === "stop").length, 1);
	});
}

test("Beta smoke rejects missing or legacy Bridge layouts before starting a backend", { skip: process.platform !== "win32" }, async (): Promise<void> => {
	for (const options of [{ missingFile: "addons/daedalus_bridge/scripts/bridge_runtime.gd" }, { wrongBridgeDir: true }]) {
		const result = await runSmoke(options);
		assert.equal(result.status, 1, result.output);
		assert.doesNotMatch(result.output, /Beta smoke passed/);
		assert.equal(result.events.some((event: SmokeEvent): boolean => event.kind === "start"), false);
	}
});

test("Beta smoke fails on Godot parse errors or nonzero exits and stops its backend", { skip: process.platform !== "win32" }, async (): Promise<void> => {
	for (const options of [{ godotError: true }, { godotExitCode: 7 }]) {
		const result = await runSmoke(options);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /emitted Godot errors|failed with exit code 7/);
		assert.doesNotMatch(result.output, /Beta smoke passed/);
		assert.equal(result.events.filter((event: SmokeEvent): boolean => event.kind === "godot").length, 1);
		assert.equal(result.events.filter((event: SmokeEvent): boolean => event.kind === "stop").length, 1);
	}
});

test("Beta smoke rejects an exited backend before probing an unrelated listener", { skip: process.platform !== "win32" }, async (): Promise<void> => {
	const result = await runSmoke({ backendExited: true });
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /Backend exited before becoming healthy/);
	assert.equal(result.events.some((event: SmokeEvent): boolean => event.kind === "ping" || event.kind === "godot"), false);
});
