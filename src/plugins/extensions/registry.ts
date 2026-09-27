import { getPluginCatalog, pluginFingerprint } from "../manager.js";
import type { PluginRecord } from "../types.js";
import type {
	PluginCommandDefinition,
	PluginBrowserDefinition,
	PluginEventDeclaration,
	PluginLanguageServiceDefinition,
	PluginPanelDefinition,
	PluginP2Manifest,
	PluginSettingsDefinition,
	PluginTimelinePartDefinition
} from "./protocol.js";
import { PLUGIN_P2_API_VERSION } from "./protocol.js";

export type RegisteredPluginCommand = PluginCommandDefinition & { pluginId: string };
export type RegisteredPluginPanel = PluginPanelDefinition & { pluginId: string };
export type RegisteredPluginSettings = PluginSettingsDefinition & { pluginId: string };
export type RegisteredPluginTimelinePart = PluginTimelinePartDefinition & { pluginId: string };
export type RegisteredPluginBrowser = PluginBrowserDefinition & { pluginId: string };

export type PluginP2RegistrySnapshot = {
	apiVersion: typeof PLUGIN_P2_API_VERSION;
	commands: RegisteredPluginCommand[];
	panels: RegisteredPluginPanel[];
	settings: RegisteredPluginSettings[];
	timelineParts: RegisteredPluginTimelinePart[];
	browser: RegisteredPluginBrowser[];
	languageServices: Array<PluginLanguageServiceDefinition & { pluginId: string }>;
	events: Array<PluginEventDeclaration & { pluginId: string }>;
	warnings: string[];
};

function isEligible(record: PluginRecord): boolean {
	return record.trust === "trusted"
		&& record.enabled
		&& record.p2 !== undefined
		&& record.runtime?.status !== "quarantined"
		&& record.isolation?.status !== "quarantined"
		&& pluginFingerprint(record) === record.fingerprint;
}

function supports(manifest: PluginP2Manifest, capability: string): boolean {
	const version = manifest.capabilities[capability as keyof PluginP2Manifest["capabilities"]];
	return version === undefined || version === 1;
}

export async function buildPluginP2Registry(): Promise<PluginP2RegistrySnapshot> {
	const snapshot: PluginP2RegistrySnapshot = {
		apiVersion: PLUGIN_P2_API_VERSION,
		commands: [],
		panels: [],
		settings: [],
		timelineParts: [],
		browser: [],
		languageServices: [],
		events: [],
		warnings: []
	};
	const seenCommands = new Set<string>();
	const seenPanels = new Set<string>();
	const seenSettings = new Set<string>();
	const seenTimeline = new Set<string>();
	const seenLanguages = new Set<string>();
	const seenEvents = new Set<string>();
	const catalog = await getPluginCatalog();
	for (const record of catalog.plugins.filter(isEligible)) {
		const manifest: PluginP2Manifest = record.p2!;
		for (const capability of Object.keys(manifest.capabilities)) {
			if (!supports(manifest, capability)) snapshot.warnings.push(`Plugin ${record.id} declares unsupported P2 capability version for ${capability}.`);
		}
		for (const command of supports(manifest, "commands") ? (manifest.declarations.commands ?? []) : []) {
			const id = `plugin:${record.id}:${command.id}`;
			if (seenCommands.has(id) || snapshot.commands.some((candidate) => candidate.command === command.command)) {
				snapshot.warnings.push(`Plugin command conflict: ${command.command}`);
				continue;
			}
			seenCommands.add(id);
			snapshot.commands.push({ ...command, id, command: command.command, pluginId: record.id });
		}
		for (const panel of supports(manifest, "panels") ? (manifest.declarations.panels ?? []) : []) {
			const id = `plugin:${record.id}:${panel.panelId}`;
			if (seenPanels.has(id)) { snapshot.warnings.push(`Plugin panel conflict: ${id}`); continue; }
			seenPanels.add(id);
			snapshot.panels.push({ ...panel, panelId: id, pluginId: record.id });
		}
		for (const settings of supports(manifest, "settings") ? (manifest.declarations.settings ?? []) : []) {
			const id = `plugin:${record.id}:${settings.settingsId}`;
			if (seenSettings.has(id)) { snapshot.warnings.push(`Plugin settings conflict: ${id}`); continue; }
			seenSettings.add(id);
			snapshot.settings.push({ ...settings, settingsId: id, pluginId: record.id });
		}
		for (const part of supports(manifest, "timelineParts") ? (manifest.declarations.timelineParts ?? []) : []) {
			const id = `plugin:${record.id}:${part.partType}`;
			if (seenTimeline.has(id)) { snapshot.warnings.push(`Plugin timeline part conflict: ${id}`); continue; }
			seenTimeline.add(id);
			snapshot.timelineParts.push({ ...part, partType: id, pluginId: record.id });
		}
		if (supports(manifest, "browser") && manifest.declarations.browser !== undefined) snapshot.browser.push({ ...manifest.declarations.browser, pluginId: record.id });
		for (const language of supports(manifest, "languageServices") ? (manifest.declarations.languageServices ?? []) : []) {
			const id = `plugin:${record.id}:${language.id}`;
			if (seenLanguages.has(id)) { snapshot.warnings.push(`Plugin language service conflict: ${id}`); continue; }
			seenLanguages.add(id);
			snapshot.languageServices.push({ ...language, id, pluginId: record.id });
		}
		for (const event of supports(manifest, "events") ? (manifest.declarations.events ?? []) : []) {
			const topic = `plugin:${record.id}:${event.topic}`;
			if (seenEvents.has(topic)) { snapshot.warnings.push(`Plugin event declaration conflict: ${topic}`); continue; }
			seenEvents.add(topic);
			snapshot.events.push({ ...event, topic, pluginId: record.id });
		}
	}
	return snapshot;
}

export async function getPluginP2Snapshot(): Promise<PluginP2RegistrySnapshot> {
	return await buildPluginP2Registry();
}

export async function getPluginCommand(command: string): Promise<RegisteredPluginCommand | undefined> {
	return (await buildPluginP2Registry()).commands.find((candidate) => candidate.command === command || candidate.id === command);
}
