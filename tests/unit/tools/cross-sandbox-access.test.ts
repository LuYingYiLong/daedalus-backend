import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	createCrossSandboxFingerprint,
	resolveCrossSandboxAccess,
} from "../../../src/tools/cross-sandbox-access.js";

test("cross-sandbox access canonicalizes declared targets and binds the execution boundary", async (): Promise<void> => {
	const root: string = await mkdtemp(path.join(tmpdir(), "daedalus-cross-sandbox-"));
	try {
		const externalRoot: string = path.join(root, "external");
		await mkdir(externalRoot);
		const args: Record<string, unknown> = {
			commandLine: "tool --version",
			externalAccess: {
				targets: [
					{ path: externalRoot, mode: "read" },
					{ path: externalRoot, mode: "execute" },
				],
				reason: "Run an installed verifier.",
			},
		};
		const sandboxed = resolveCrossSandboxAccess({
			toolName: "mcp_terminal_run_command",
			args,
			sandboxAvailable: true,
		});
		assert.equal(sandboxed.ok, true);
		if (!sandboxed.ok) return;
		assert.equal(sandboxed.scope?.boundary, "sandbox_external_read");
		assert.deepEqual(sandboxed.scope?.targets.map((target) => target.mode), ["execute"]);

		const unsandboxed = resolveCrossSandboxAccess({
			toolName: "mcp_terminal_run_command",
			args,
			sandboxAvailable: false,
		});
		assert.equal(unsandboxed.ok, true);
		if (!unsandboxed.ok) return;
		assert.equal(unsandboxed.scope?.boundary, "approved_unsandboxed");
		assert.notEqual(unsandboxed.scope?.fingerprint, sandboxed.scope?.fingerprint);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cross-sandbox access rejects relative and missing targets", (): void => {
	for (const targetPath of ["relative/tool.exe", path.join(tmpdir(), "missing-daedalus-tool.exe")]) {
		const result = resolveCrossSandboxAccess({
			toolName: "mcp_terminal_run_command",
			args: {
				commandLine: "tool --version",
				externalAccess: {
					targets: [{ path: targetPath, mode: "execute" }],
					reason: "Run an installed verifier.",
				},
			},
			sandboxAvailable: true,
		});
		assert.equal(result.ok, false);
	}
});

test("credential directories are marked for mandatory user review", async (): Promise<void> => {
	const root: string = await mkdtemp(path.join(tmpdir(), "daedalus-sensitive-access-"));
	try {
		const sensitiveRoot: string = path.join(root, ".ssh");
		await mkdir(sensitiveRoot);
		const result = resolveCrossSandboxAccess({
			toolName: "mcp_terminal_run_command",
			args: {
				commandLine: "tool --version",
				externalAccess: {
					targets: [{ path: sensitiveRoot, mode: "read" }],
					reason: "Inspect configuration.",
				},
			},
			sandboxAvailable: true,
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.scope?.sensitiveTarget, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cross-sandbox fingerprints bind tool, args, workspace, target, network and boundary", (): void => {
	const target = { path: path.resolve(tmpdir()), mode: "read" as const };
	const base = {
		toolName: "mcp_terminal_run_command",
		args: { commandLine: "node --version" },
		workspaceId: "workspace-a",
		boundary: "sandbox_external_read" as const,
		targets: [target],
		networkAccess: false,
	};
	const fingerprint: string = createCrossSandboxFingerprint(base);
	for (const changed of [
		{ ...base, toolName: "mcp_terminal_run_safe_preset" },
		{ ...base, args: { commandLine: "npm --version" } },
		{ ...base, workspaceId: "workspace-b" },
		{ ...base, targets: [{ ...target, mode: "execute" as const }] },
		{ ...base, networkAccess: true },
		{ ...base, boundary: "approved_unsandboxed" as const },
	]) {
		assert.notEqual(createCrossSandboxFingerprint(changed), fingerprint);
	}
});

test("sandboxed network access creates a reviewed scope without an external path", (): void => {
	const result = resolveCrossSandboxAccess({
		toolName: "mcp_terminal_run_command",
		args: { commandLine: "curl -o artifact.zip https://example.invalid/artifact.zip" },
		sandboxAvailable: true,
		networkAccess: true,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.scope?.boundary, "sandbox_external_read");
	assert.equal(result.scope?.networkAccess, true);
	assert.deepEqual(result.scope?.targets, []);
});
