import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("plugin RPC requests accept pinned npm and Git sources", (): void => {
	const npmRequest = clientRequestSchema.safeParse({
		type: "request",
		id: "plugin-1",
		method: "plugin.install",
		params: { source: { type: "npm", packageName: "dsh-example-plugin", version: "1.2.3" } }
	});
	assert.equal(npmRequest.success, true);
	const gitRequest = clientRequestSchema.safeParse({
		type: "request",
		id: "plugin-2",
		method: "plugin.scan",
		params: { source: { type: "git", url: "https://github.com/example/plugin.git", commit: "0123456789abcdef0123456789abcdef01234567" } }
	});
	assert.equal(gitRequest.success, true);
});

test("plugin RPC requests reject unpinned package sources", (): void => {
	const result = clientRequestSchema.safeParse({
		type: "request",
		id: "plugin-3",
		method: "plugin.install",
		params: { source: { type: "npm", packageName: "example-plugin", version: "^1.2.3" } }
	});
	assert.equal(result.success, false);
});

test("plugin creator whole-package review uses strict revision-bound requests", (): void => {
	const trust = clientRequestSchema.safeParse({
		type: "request",
		id: "plugin-review-trust",
		method: "plugin.trust.update",
		params: {
			pluginId: "plugin-generated",
			fingerprint: "a".repeat(64),
			status: "trusted",
			reviewId: "plugin-review-1"
		}
	});
	assert.equal(trust.success, true);
	const deferred = clientRequestSchema.safeParse({
		type: "request",
		id: "plugin-review-defer",
		method: "plugin.review.resolve",
		params: {
			pluginId: "plugin-generated",
			fingerprint: "a".repeat(64),
			reviewId: "plugin-review-1",
			status: "deferred"
		}
	});
	assert.equal(deferred.success, true);
});

test("Harness runtime RPC requests require revisioned configuration and package-relative previews", (): void => {
	const update = clientRequestSchema.safeParse({
		type: "request",
		id: "harness-update",
		method: "plugin.harness.config.update",
		params: {
			expectedRevision: "a".repeat(64),
			enabled: true,
			executablePath: "C:\\Tools\\dsh.cmd",
			sourceRoot: null,
			launchMode: "installed"
		}
	});
	assert.equal(update.success, true);
	const draftDetect = clientRequestSchema.safeParse({
		type: "request",
		id: "harness-detect-draft",
		method: "plugin.harness.detect",
		params: {
			draft: {
				enabled: false,
				executablePath: null,
				sourceRoot: "C:\\Users\\example\\deepseek-harness",
				launchMode: "source"
			}
		}
	});
	assert.equal(draftDetect.success, true);
	const preview = clientRequestSchema.safeParse({ type: "request", id: "harness-preview", method: "plugin.harness.preview", params: { pluginId: "plugin-1" } });
	assert.equal(preview.success, true);
	const invalid = clientRequestSchema.safeParse({ type: "request", id: "harness-update-bad", method: "plugin.harness.config.update", params: { expectedRevision: "latest", config: { enabled: true, launchMode: "installed" } } });
	assert.equal(invalid.success, false);
});

test("plugin maintenance requests require revision-bound changelog and release confirmation", (): void => {
	const revision = "b".repeat(64);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "changelog", method: "plugin.changelog.apply", params: { draftId: "draft-1", expectedRevision: revision, accepted: true } }).success, true);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "changelog-stale", method: "plugin.changelog.apply", params: { draftId: "draft-1", accepted: true } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "release", method: "plugin.release.confirm", params: { draftId: "draft-1", expectedRevision: revision } }).success, true);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "publish", method: "plugin.publish.confirm", params: { artifactPath: "[daedalus]/artifact.tgz", registry: "https://registry.npmjs.org/" } }).success, true);
});
