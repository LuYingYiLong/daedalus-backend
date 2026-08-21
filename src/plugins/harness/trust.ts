import { createHash } from "node:crypto";
import type { HarnessInstallation, HarnessRuntimeConfig, PluginRecord } from "../types.js";
import { HARNESS_BRIDGE_PROTOCOL_VERSION } from "./limits.js";

export function createHarnessRuntimeFingerprint(record: PluginRecord, config: HarnessRuntimeConfig, installation: HarnessInstallation): string {
	return createHash("sha256").update(JSON.stringify({
		plugin: {
			source: record.source,
			contentHash: record.contentHash,
			manifestHash: record.manifestHash,
			dependencyLockHash: record.dependencyLockHash ?? null,
			patch: record.harnessBundle ?? null
		},
		harness: {
			launchMode: config.launchMode,
			executablePath: config.executablePath,
			sourceRoot: config.sourceRoot,
			version: installation.version ?? null
		},
		bridgeProtocolVersion: HARNESS_BRIDGE_PROTOCOL_VERSION,
		generatedProfile: { name: "daedalus-harness-sidecar-profile", bundles: [] }
	})).digest("hex");
}
