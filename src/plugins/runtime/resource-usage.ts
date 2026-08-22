import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

export async function readChildRssBytes(child: ChildProcess): Promise<number | undefined> {
	const pid = child.pid;
	if (pid === undefined || pid <= 0) return undefined;
	if (process.platform !== "win32") {
		try {
			const status = await readFile(`/proc/${pid}/status`, "utf8");
			const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
			return match === null ? undefined : Number(match[1]) * 1024;
		} catch {
			return undefined;
		}
	}
	return await new Promise<number | undefined>((resolve): void => {
		const task = spawn("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false });
		let output = "";
		const timer = setTimeout((): void => { task.kill(); resolve(undefined); }, 1500);
		task.stdout?.setEncoding("utf8");
		task.stdout?.on("data", (chunk: string): void => { output += chunk; });
		task.once("error", (): void => { clearTimeout(timer); resolve(undefined); });
		task.once("close", (): void => {
			clearTimeout(timer);
			const match = /,"([\d,]+) K"\s*$/mu.exec(output.trim());
			resolve(match === null ? undefined : Number(match[1]!.replace(/,/gu, "")) * 1024);
		});
	});
}
