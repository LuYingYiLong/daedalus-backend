import assert from "node:assert/strict";
import test from "node:test";
import { releaseSharedRuntimeLease } from "../../../src/runtime/shared-runtime.js";

test("shared runtime release validates lease identifiers", (): void => {
	assert.deepEqual(releaseSharedRuntimeLease("lease-abcdefghijklmnop"), {
		ok: true,
		released: true,
		leaseId: "lease-abcdefghijklmnop"
	});
	assert.throws(
		(): void => {
			releaseSharedRuntimeLease("../not-a-lease");
		},
		/lease ID is invalid/u
	);
});
