import assert from "node:assert/strict";
import test from "node:test";
import { isVersionUpgrade } from "../../../src/plugins/maintenance/update-preflight.js";

test("plugin maintenance accepts only increasing semver releases", (): void => {
	assert.equal(isVersionUpgrade("1.0.0", "1.0.1"), true);
	assert.equal(isVersionUpgrade("1.0.0", "1.1.0"), true);
	assert.equal(isVersionUpgrade("1.0.0-beta.1", "1.0.0"), true);
	assert.equal(isVersionUpgrade("1.0.0", "1.0.0"), false);
	assert.equal(isVersionUpgrade("1.1.0", "1.0.0"), false);
	assert.equal(isVersionUpgrade("1.0.0", "latest"), false);
});
