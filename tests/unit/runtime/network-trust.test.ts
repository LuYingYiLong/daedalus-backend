import assert from "node:assert/strict";
import test from "node:test";
import {
	configureSystemCertificateTrust,
	mergeCertificateAuthorities
} from "../../../src/runtime/network-trust.js";

test("network trust keeps bundled roots and adds unique system roots", (): void => {
	assert.deepEqual(
		mergeCertificateAuthorities(["bundled-a", "shared"], ["system-a", "shared"]),
		["bundled-a", "shared", "system-a"]
	);
});

test("network trust configures the merged CA list without disabling verification", (): void => {
	let configuredCertificates: readonly string[] = [];
	const result = configureSystemCertificateTrust({
		getCACertificates(type): string[] {
			return type === "default" ? ["bundled"] : ["system"];
		},
		setDefaultCACertificates(certificates): void {
			configuredCertificates = certificates;
		}
	});

	assert.equal(result.configured, true);
	assert.equal(result.defaultCertificateCount, 1);
	assert.equal(result.systemCertificateCount, 1);
	assert.equal(result.totalCertificateCount, 2);
	assert.equal(result.error, null);
	assert.deepEqual(configuredCertificates, ["bundled", "system"]);
});

test("network trust reports configuration errors without crashing the backend", (): void => {
	const result = configureSystemCertificateTrust({
		getCACertificates(): string[] {
			throw new Error("system store unavailable");
		},
		setDefaultCACertificates(): void {}
	});

	assert.equal(result.configured, false);
	assert.equal(result.error, "system store unavailable");
});
