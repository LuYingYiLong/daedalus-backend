import assert from "node:assert/strict";
import test from "node:test";
import { pluginP2ManifestSchema, summarizePluginP2Manifest } from "../../../src/plugins/extensions/protocol.js";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("P2 manifest keeps capability declarations bounded and summarizes all extension families", (): void => {
	const parsed = pluginP2ManifestSchema.safeParse({
		apiVersion: 2,
		capabilities: { commands: 1, panels: 1, browser: 1 },
		declarations: {
			commands: [{ id: "hello", command: "/hello", description: "Hello", handler: "hello" }],
			panels: [{ panelId: "panel", title: "Panel", locations: ["side"], view: [{ type: "Text", text: "safe" }] }],
			settings: [{ settingsId: "settings", title: "Settings", view: [] }],
			timelineParts: [{ partType: "status" }],
			browser: { actions: ["observe"], handler: "browser" },
			languageServices: [{ id: "lang", languageIds: ["fixture"], extensions: [".fixture"], command: "fixture-lsp", capabilities: ["diagnostics"] }],
			events: [{ topic: "updates", publish: true }]
		}
	});
	assert.equal(parsed.success, true);
	if (!parsed.success) return;
	const summary = summarizePluginP2Manifest(parsed.data);
	assert.deepEqual(summary && {
		commands: summary.commands,
		panels: summary.panels,
		settings: summary.settings,
		timelineParts: summary.timelineParts,
		browser: summary.browser,
		languageServices: summary.languageServices,
		events: summary.events
	}, { commands: 1, panels: 1, settings: 1, timelineParts: 1, browser: true, languageServices: 1, events: 1 });
});

test("P2 RPC requests require plugin identity for browser control and strict panel state", (): void => {
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "browser", method: "plugin.browser.invoke", params: { pluginId: "plugin-a", action: "observe" } }).success, true);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "browser-bad", method: "plugin.browser.invoke", params: { action: "observe" } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "panel", method: "plugin.ui.panel.state.update", params: { panelId: "plugin-a:panel", state: {} } }).success, true);
	assert.equal(pluginP2ManifestSchema.safeParse({ apiVersion: 2, capabilities: { panels: 1 }, declarations: { panels: [{ panelId: "bad", title: "Bad", locations: ["side"], view: [{ type: "RawHtml", html: "<script>" }] }] } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "panel-get", method: "plugin.ui.panel.state.get", params: { panelId: "plugin-a:panel:instance" } }).success, true);
	assert.equal(pluginP2ManifestSchema.safeParse({ apiVersion: 1, capabilities: { panels: 1 }, declarations: { panels: [] } }).success, false);
	assert.equal(clientRequestSchema.safeParse({ type: "request", id: "context", method: "plugin.context-provider.list", params: {} }).success, false);
});
