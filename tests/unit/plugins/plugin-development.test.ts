import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { PluginDevelopmentReviewRuntime } from "../../../src/plugins/development/review-runtime.js";
import { applyPluginDevelopmentSnapshot, preparePluginDevelopmentSnapshot } from "../../../src/plugins/development/snapshot.js";
import { validatePluginDevelopmentSnapshot } from "../../../src/plugins/development/validation.js";
import type { PluginRecord } from "../../../src/plugins/types.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

function validFiles(): Array<{ path: string; content: string }> {
	return [
		{
			path: "package.json",
			content: JSON.stringify({
				name: "daedalus-generated-fixture",
				version: "1.0.0",
				type: "module",
				description: "Generated fixture",
				daedalus: { plugin: { apiVersion: 1, entry: "./index.js", capabilities: ["tools"] } }
			})
		},
		{
			path: "index.js",
			content: "export function register(api) { api.tools.register({ name: 'echo', title: 'Echo', description: 'Echo text', inputSchema: { type: 'object' }, risk: 'read', global: true }, (args) => ({ echo: args.text ?? '' })); }\n"
		},
		{ path: "README.md", content: "# Generated fixture\n" },
		{ path: "CHANGELOG.md", content: "# Changelog\n\n## 1.0.0\n\n- Initial release.\n" },
		{
			path: "tests/daedalus.plugin-tests.json",
			content: JSON.stringify({ version: 1, cases: [{ id: "echo", capability: "tool", target: "echo", input: { text: "hello" }, expect: { contains: "hello" } }] })
		}
	];
}

test("plugin creator validates the required Native v1 project snapshot", async (): Promise<void> => {
	const result = await validatePluginDevelopmentSnapshot(validFiles());
	assert.deepEqual(result.diagnostics.filter((item): boolean => item.severity === "error"), []);
	assert.equal(result.capabilitySummary.tools, 1);
});

test("plugin creator rejects credentials, network APIs, dependencies, and missing tests", async (): Promise<void> => {
	const files = validFiles().filter((file): boolean => file.path !== "tests/daedalus.plugin-tests.json");
	files[0]!.content = JSON.stringify({
		name: "unsafe-plugin",
		version: "1.0.0",
		type: "module",
		dependencies: { unsafe: "1.0.0" },
		daedalus: { plugin: { apiVersion: 1, entry: "./index.js", capabilities: ["tools"] } }
	});
	files[1]!.content = "const token = 'sk-abcdefghijklmnop'; export function register() { return fetch('https://example.com'); }\n";
	const result = await validatePluginDevelopmentSnapshot(files);
	const codes = new Set(result.diagnostics.map((item): string => item.code));
	assert.equal(codes.has("plugin_required_file_missing"), true);
	assert.equal(codes.has("plugin_secret_detected"), true);
	assert.equal(codes.has("plugin_forbidden_runtime_api"), true);
	assert.equal(codes.has("plugin_dependencies_not_supported"), true);
});

test("plugin creator never applies a proposal with blocking diagnostics", async (): Promise<void> => {
	const previousProfile = process.env.USERPROFILE;
	const root = await mkdtemp(join(tmpdir(), "daedalus-plugin-creator-invalid-"));
	process.env.USERPROFILE = root;
	try {
		const files = validFiles();
		files[1]!.content = "export function register() { return fetch('https://example.com'); }\n";
		const proposal = await preparePluginDevelopmentSnapshot({ slug: "invalid-fixture", scope: "personal", files }, "session-invalid-plugin");
		assert.equal(proposal.diagnostics.some((item): boolean => item.severity === "error"), true);
		await assert.rejects(
			(): Promise<unknown> => applyPluginDevelopmentSnapshot(proposal.proposalToken, "session-invalid-plugin"),
			(error: unknown): boolean => (error as { code?: string }).code === "plugin_dev_validation_required"
		);
	} finally {
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		await rm(root, { recursive: true, force: true });
	}
});

test("plugin creator applies one-shot proposals to a managed workspace directory", async (): Promise<void> => {
	const previousProfile = process.env.USERPROFILE;
	const root = await mkdtemp(join(tmpdir(), "daedalus-plugin-creator-"));
	process.env.USERPROFILE = root;
	const workspace: WorkspaceConfig = {
		id: "plugin-dev-workspace",
		name: "Plugin development",
		kind: "godot",
		rootPath: root,
		icon: 0,
		color: 0,
		primarySourceFolderId: "source",
		sourceFolders: [{ id: "source", path: root, capabilities: { git: false, godot: false } }]
	};
	try {
		const proposal = await preparePluginDevelopmentSnapshot({ slug: "generated-fixture", scope: "workspace", files: validFiles() }, "session-plugin-dev", workspace);
		assert.equal(proposal.diagnostics.some((item): boolean => item.severity === "error"), false);
		const record = await applyPluginDevelopmentSnapshot(proposal.proposalToken, "session-plugin-dev");
		assert.equal(record.revision, proposal.proposedRevision);
		assert.equal(JSON.parse(await readFile(join(root, "plugins", "generated-fixture", "package.json"), "utf8")).name, "daedalus-generated-fixture");
		await assert.rejects((): Promise<unknown> => applyPluginDevelopmentSnapshot(proposal.proposalToken, "session-plugin-dev"), /missing, expired, or belongs/u);
	} finally {
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		await rm(root, { recursive: true, force: true });
	}
});

test("plugin creator whole-package review is bound to the installed fingerprint", async (): Promise<void> => {
	const runtime = new PluginDevelopmentReviewRuntime();
	const messages: unknown[] = [];
	const socket = {
		readyState: 1,
		send: (value: string): void => {
			messages.push(JSON.parse(value));
		}
	} as unknown as WebSocket;
	const plugin = {
		id: "plugin-generated-fixture",
		packageName: "daedalus-generated-fixture",
		version: "1.0.0",
		fingerprint: "a".repeat(64)
	} as PluginRecord;
	const pending = runtime.request(socket, "session-plugin-dev", plugin, "b".repeat(64), 1);
	const reviewId = (messages[0] as { data: { reviewId: string } }).data.reviewId;
	assert.throws(
		(): void => runtime.assertPending(reviewId, plugin.id, "c".repeat(64)),
		(error: unknown): boolean => (error as { code?: string }).code === "plugin_review_mismatch"
	);
	runtime.claim(reviewId, plugin.id, plugin.fingerprint);
	assert.throws(
		(): void => runtime.claim(reviewId, plugin.id, plugin.fingerprint),
		(error: unknown): boolean => (error as { code?: string }).code === "plugin_review_resolving"
	);
	runtime.resolve(reviewId, plugin.id, plugin.fingerprint, "trusted");
	assert.deepEqual(await pending, { reviewId, status: "trusted" });
	assert.equal((messages[1] as { event: string }).event, "plugin.review.resolved");
});
