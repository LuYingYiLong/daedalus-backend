import { getHookTrustConfigPath } from "../app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../json-file-store.js";

type HookTrustStatus = "trusted" | "disabled";

type HookTrustRecord = {
	status: HookTrustStatus;
	updatedAt: string;
};

type HookTrustStore = {
	schemaVersion: 1;
	entries: Record<string, HookTrustRecord>;
};

const EMPTY_STORE: HookTrustStore = { schemaVersion: 1, entries: {} };

function normalizeStore(value: unknown): HookTrustStore {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return structuredClone(EMPTY_STORE);
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || record.entries === null || typeof record.entries !== "object" || Array.isArray(record.entries)) {
		return structuredClone(EMPTY_STORE);
	}
	const entries: Record<string, HookTrustRecord> = {};
	for (const [fingerprint, raw] of Object.entries(record.entries as Record<string, unknown>)) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		if ((entry.status !== "trusted" && entry.status !== "disabled") || typeof entry.updatedAt !== "string") continue;
		entries[fingerprint] = { status: entry.status, updatedAt: entry.updatedAt };
	}
	return { schemaVersion: 1, entries };
}

async function readStore(): Promise<HookTrustStore> {
	return normalizeStore(await readJsonFile<unknown>(getHookTrustConfigPath()));
}

export async function getHookTrustStatus(fingerprint: string): Promise<HookTrustStatus | "review_required"> {
	return (await readStore()).entries[fingerprint]?.status ?? "review_required";
}

export async function getHookTrustStatuses(fingerprints: readonly string[]): Promise<Map<string, HookTrustStatus | "review_required">> {
	const entries: HookTrustStore["entries"] = (await readStore()).entries;
	return new Map(fingerprints.map((fingerprint: string): [string, HookTrustStatus | "review_required"] => [
		fingerprint,
		entries[fingerprint]?.status ?? "review_required"
	]));
}

export async function updateHookTrust(fingerprint: string, status: HookTrustStatus): Promise<void> {
	const store: HookTrustStore = await readStore();
	store.entries[fingerprint] = { status, updatedAt: new Date().toISOString() };
	if (Object.keys(store.entries).length > 5000) {
		const retained = Object.entries(store.entries)
			.sort((left, right): number => right[1].updatedAt.localeCompare(left[1].updatedAt))
			.slice(0, 4000);
		store.entries = Object.fromEntries(retained);
	}
	await writeJsonFileAtomic(getHookTrustConfigPath(), store);
}
