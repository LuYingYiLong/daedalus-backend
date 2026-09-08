import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { createSandboxEnvironment, getSandboxAvailability } from "../../../src/mcp/terminal/sandbox-runner.js";

function snapshotAcls(paths: string[]): unknown {
	const result = execFileSync(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), [
		"-NoProfile", "-NonInteractive", "-Command",
		"$ErrorActionPreference='Stop'; $result = foreach ($p in (ConvertFrom-Json $env:DAEDALUS_TEST_ACL_PATHS)) { $acl=[System.IO.File]::GetAccessControl($p); $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.IdentityReference.Value,[int]$_.FileSystemRights,$_.AccessControlType,$_.InheritanceFlags,$_.PropagationFlags,$_.IsInherited } | Sort-Object); [pscustomobject]@{ path=$p; protected=$acl.AreAccessRulesProtected; rules=$rules } }; ConvertTo-Json -InputObject @($result) -Depth 5 -Compress"
	], { encoding: "utf8", windowsHide: true, env: { ...process.env, DAEDALUS_TEST_ACL_PATHS: JSON.stringify(paths) }, timeout: 15000 });
	return JSON.parse(result);
}

test("Windows helper preserves path isolation and ACLs through overlapping runs, EOF cancellation and failed launch", { skip: process.platform !== "win32", timeout: 60000 }, async (t): Promise<void> => {
	const availability = getSandboxAvailability();
	if (!availability.available) { t.skip(availability.error); return; }
	const root = await realpath(await mkdtemp(join(tmpdir(), "daedalus-native-sandbox-")));
	const workspace = join(root, "workspace");
	const readOnly = join(root, "read-only");
	const script = join(readOnly, "probe.cjs");
	const children: ChildProcessWithoutNullStreams[] = [];
	try {
		await mkdir(workspace);
		await mkdir(readOnly);
		await writeFile(join(root, "outside.txt"), "private fixture");
		await writeFile(join(readOnly, "readable.txt"), "fixture");
		await writeFile(script, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = path.dirname(process.cwd());
function probe() {
  assert.equal(fs.readFileSync(path.join(__dirname, 'readable.txt'), 'utf8'), 'fixture');
  assert.ok(fs.realpathSync(__filename));
  for (const action of [
    () => fs.readdirSync(root),
    () => fs.readFileSync(path.join(root, 'outside.txt')),
    () => fs.writeFileSync(path.join(__dirname, 'readable.txt'), 'changed')
  ]) assert.throws(action, error => ['EACCES', 'EPERM'].includes(error.code));
  fs.writeFileSync(path.join(process.cwd(), 'writable-' + process.pid), 'ok');
  console.log('ready');
}
probe();
if (process.argv.includes('--wait')) {
  readline.createInterface({input:process.stdin}).on('line', line => {
    if (line === 'exit') process.exit(0);
    probe();
  });
  setInterval(() => {}, 1000);
}
`);
		const paths = [root, workspace, readOnly, script];
		const before = snapshotAcls(paths);
		function launch(wait: boolean, command: string = process.execPath): {
			child: ChildProcessWithoutNullStreams;
			line: () => Promise<string>;
			closed: Promise<number | null>;
		} {
			const args = ["--workspace", workspace, "--cwd", workspace, "--read-only", readOnly, "--no-network", ...(wait ? ["--cancel-on-stdin-close"] : []), "--argv", "--", command, script, ...(wait ? ["--wait"] : [])];
			const child = spawn(availability.available ? availability.helperPath! : "", args, { env: createSandboxEnvironment({}), cwd: workspace, stdio: "pipe", windowsHide: true });
			children.push(child);
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString(); });
			const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
			const closed = once(child, "close").then(([code]): number | null => code as number | null);
			return { child, closed, line: async (): Promise<string> => {
				const item = await lines.next();
				assert.equal(item.done, false, stderr);
				return item.value!;
			} };
		}
		const first = launch(true);
		assert.equal(await first.line(), "ready");
		const second = launch(true);
		assert.equal(await second.line(), "ready");
		first.child.stdin.write("exit\n");
		assert.equal(await first.closed, 0);
		second.child.stdin.write("probe\n");
		assert.equal(await second.line(), "ready");
		second.child.stdin.end();
		assert.equal(await second.closed, 1);
		assert.deepEqual(snapshotAcls(paths), before);

		// 普通一次性终端的 stdin EOF 不能被误当成取消。
		const oneShot = launch(false);
		oneShot.child.stdin.end();
		assert.equal(await oneShot.line(), "ready");
		assert.equal(await oneShot.closed, 0);
		assert.deepEqual(snapshotAcls(paths), before);

		const invalidExe = join(workspace, "invalid.exe");
		await writeFile(invalidExe, "not an executable");
		const failed = launch(false, invalidExe);
		failed.child.stdin.end();
		assert.equal(await failed.closed, 2);
		assert.deepEqual(snapshotAcls(paths), before);
	} finally {
		for (const child of children) child.stdin.end();
		await Promise.all(children.map(async (child): Promise<void> => {
			if (child.exitCode === null && child.signalCode === null) await once(child, "close");
		}));
		await rm(root, { recursive: true, force: true });
	}
});
