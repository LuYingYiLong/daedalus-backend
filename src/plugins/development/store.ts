import { readFile } from "node:fs/promises";
import { getDaedalusPath } from "../../app-paths.js";
import { writeJsonFileAtomic } from "../../json-file-store.js";
import type { PluginDevelopmentRecord } from "./types.js";

type DevelopmentStore = {
	schemaVersion: 1;
	records: PluginDevelopmentRecord[];
};

const EMPTY_STORE: DevelopmentStore = { schemaVersion: 1, records: [] };
let writeQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalize(value: unknown): DevelopmentStore {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.records)) return structuredClone(EMPTY_STORE);
	return {
		schemaVersion: 1,
		records: value.records.filter((record): record is PluginDevelopmentRecord =>
			isRecord(record)
			&& typeof record.slug === "string"
			&& typeof record.rootPath === "string"
			&& typeof record.packageName === "string"
			&& (record.scope === "workspace" || record.scope === "personal")
			&& typeof record.revision === "string"
			&& typeof record.updatedAt === "string"
			&& typeof record.lastSessionId === "string"
		)
	};
}

export async function readPluginDevelopmentRecords(): Promise<PluginDevelopmentRecord[]> {
	try {
		return normalize(JSON.parse(await readFile(getDaedalusPath("plugins.developmentRecords"), "utf8"))).records;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function updatePluginDevelopmentRecords(
	mutator: (records: PluginDevelopmentRecord[]) => PluginDevelopmentRecord[]
): Promise<PluginDevelopmentRecord[]> {
	let result: PluginDevelopmentRecord[] = [];
	const operation: Promise<void> = writeQueue.then(async (): Promise<void> => {
		result = mutator(await readPluginDevelopmentRecords());
		await writeJsonFileAtomic(getDaedalusPath("plugins.developmentRecords"), {
			schemaVersion: 1,
			records: result
		} satisfies DevelopmentStore);
	});
	writeQueue = operation.catch((): void => undefined);
	await operation;
	return result;
}

export async function findPluginDevelopmentRecord(rootPath: string): Promise<PluginDevelopmentRecord | undefined> {
	return (await readPluginDevelopmentRecords()).find((record): boolean => record.rootPath === rootPath);
}
