import { cp, mkdir, copyFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

export async function packageFlowImageRuntime(projectRoot: string, payloadRoot: string): Promise<void> {
	const root = join(payloadRoot, "media");
	await mkdir(join(root, "node_modules"), { recursive: true });
	await copyFile(process.execPath, join(root, process.platform === "win32" ? "node.exe" : "node"));
	await copyFile(join(projectRoot, "src/media/image-worker.cjs"), join(root, "image-worker.cjs"));
	const seen = new Set<string>();
	const copy = async (name: string, optional = false): Promise<void> => {
		if (seen.has(name)) return;
		const source = join(projectRoot, "node_modules", name);
		try { await access(source); } catch (error) { if (optional) return; throw error; }
		seen.add(name);
		const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
		await cp(source, join(root, "node_modules", name), { recursive: true, dereference: true });
		for (const dependency of Object.keys(manifest.dependencies ?? {})) await copy(dependency);
		for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) await copy(dependency, true);
	};
	await copy("sharp");
	const require = createRequire(join(root, "package.json"));
	const sharp = require("sharp") as typeof import("sharp").default;
	const input = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
	await new Promise<void>((resolve, reject) => {
		const worker = spawn(join(root, process.platform === "win32" ? "node.exe" : "node"), ["--permission", "--allow-addons", `--allow-fs-read=${root}`, join(root, "image-worker.cjs")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced", env: { ...process.env, NODE_OPTIONS: "" } });
		let settled = false, diagnostic = "";
		const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); worker.kill(); error ? reject(error) : resolve(); };
		const timer = setTimeout(() => finish(new Error("Packaged image worker timed out")), 15000);
		worker.stderr?.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-4000); });
		worker.on("error", finish);
		worker.on("exit", code => finish(new Error(`Packaged image worker exited (${code}): ${diagnostic}`)));
		worker.on("message", (value: unknown) => {
			const result = value as { ok: boolean; width: number; height: number; bytes: unknown; error?: string };
			finish(result.ok && result.width === 4 && result.height === 3 && Buffer.isBuffer(result.bytes) ? undefined : new Error(result.error ?? "Invalid packaged image result"));
		});
		worker.send({ bytes: input, operation: { kind: "resize", width: 4, height: 3, fit: "fill", background: "#00000000" } });
	});
}
