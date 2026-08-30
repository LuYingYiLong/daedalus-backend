import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDaedalusPath } from "../../app-paths.js";
import { writeJsonFileAtomic } from "../../json-file-store.js";

const MAX_STATE_BYTES = 256 * 1024;
const statePath = (): string => join(getDaedalusPath("plugins.root"), "p2-state.json");
type StateDocument = { schemaVersion: 1; panels: Record<string, Record<string, unknown>>; settings: Record<string, Record<string, unknown>> };

async function readState(): Promise<StateDocument> {
	try {
		const parsed: unknown = JSON.parse(await readFile(statePath(), "utf8"));
		if (parsed !== null && typeof parsed === "object") {
			const value = parsed as Partial<StateDocument>;
			if (value.panels !== undefined && value.settings !== undefined) return { schemaVersion: 1, panels: value.panels, settings: value.settings };
		}
	} catch {
		// 损坏状态按空配置启动
	}
	return { schemaVersion: 1, panels: {}, settings: {} };
}

function boundedState(state: Record<string, unknown>): Record<string, unknown> {
	const entries = Object.entries(state).slice(0, 128);
		const result: Record<string, unknown> = {};
	for (const [key, value] of entries) result[key.slice(0, 160)] = value;
	let encoded = JSON.stringify(result);
	while (Buffer.byteLength(encoded, "utf8") > MAX_STATE_BYTES && Object.keys(result).length > 0) {
		delete result[Object.keys(result).at(-1)!];
		encoded = JSON.stringify(result);
	}
	return result;
}

export async function getPluginUiState(kind: "panel" | "settings", key: string): Promise<Record<string, unknown>> {
	const state = await readState();
	return { ...(kind === "panel" ? state.panels[key] : state.settings[key]) };
}

export async function updatePluginUiState(kind: "panel" | "settings", key: string, value: Record<string, unknown>): Promise<{ saved: true }> {
	const state = await readState();
	if (kind === "panel") state.panels[key] = boundedState(value);
	else state.settings[key] = boundedState(value);
	await writeJsonFileAtomic(statePath(), state);
	return { saved: true };
}
