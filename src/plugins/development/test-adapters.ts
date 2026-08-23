import type { PluginDevelopmentTestCase } from "./types.js";

export type DeterministicAdapterResult = { ok: true; capability: string; target: string; external: true; value: Record<string, unknown> };

export function runDeterministicAdapter(test: PluginDevelopmentTestCase): DeterministicAdapterResult {
	const values: Record<string, Record<string, unknown>> = {
		browser: { url: "https://example.test/", title: "Daedalus test page", visibleText: "Deterministic browser fixture" },
		panel: { state: {}, action: "validated" },
		settings: { state: {}, action: "validated" },
		timeline_part: { persisted: false, sink: "isolated-test" },
		language_service: { diagnostics: [], capabilities: ["diagnostics", "hover", "completion"] },
		event: { topic: test.target, cursor: "isolated-test-cursor", acknowledged: true }
	};
	const value: Record<string, unknown> = values[test.capability] ?? { registered: true };
	return { ok: true, capability: test.capability, target: test.target, external: true, value };
}
