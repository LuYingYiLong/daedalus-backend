import { readFile } from "node:fs/promises";
import { getProviderCustomizationsPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type { ProviderId } from "../protocol/types.js";

export type CustomProviderType = "openai" | "openai-responses" | "anthropic";
export type ModelCustomizationSource = "custom" | "override";

export type EditableModelCapabilities = {
	vision: boolean;
	webSearch: boolean;
	reasoning: boolean;
	tools: boolean;
};

export type CustomProviderRecord = {
	displayName: string;
	providerType: CustomProviderType;
	defaultModel: string | null;
	createdAt: string;
	updatedAt: string;
};

export type ModelCustomizationRecord = {
	source: ModelCustomizationSource;
	displayName: string;
	capabilities: EditableModelCapabilities;
	updatedAt: string;
};

export type ProviderCustomizations = {
	schemaVersion: 1;
	providers: Record<ProviderId, CustomProviderRecord>;
	models: Record<ProviderId, Record<string, ModelCustomizationRecord>>;
};

const EMPTY_CAPABILITIES: EditableModelCapabilities = {
	vision: false,
	webSearch: false,
	reasoning: false,
	tools: false
};

let snapshot: ProviderCustomizations = createEmptyProviderCustomizations();
let initializedPath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function createEmptyProviderCustomizations(): ProviderCustomizations {
	return {
		schemaVersion: 1,
		providers: {},
		models: {}
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderId(value: string): boolean {
	return /^[a-z][a-z0-9._-]{0,79}$/u.test(value);
}

function isCustomProviderType(value: unknown): value is CustomProviderType {
	return value === "openai" || value === "openai-responses" || value === "anthropic";
}

function readTrimmedString(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed: string = value.trim();
	return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function normalizeCapabilities(value: unknown): EditableModelCapabilities {
	if (!isRecord(value)) {
		return { ...EMPTY_CAPABILITIES };
	}
	return {
		vision: value.vision === true,
		webSearch: value.webSearch === true,
		reasoning: value.reasoning === true,
		tools: value.tools === true
	};
}

function normalizeProviderRecord(value: unknown): CustomProviderRecord | null {
	if (!isRecord(value)) {
		return null;
	}
	const displayName: string | null = readTrimmedString(value.displayName, 80);
	const createdAt: string | null = readTrimmedString(value.createdAt, 80);
	const updatedAt: string | null = readTrimmedString(value.updatedAt, 80);
	if (
		displayName === null
		|| createdAt === null
		|| updatedAt === null
		|| !isCustomProviderType(value.providerType)
	) {
		return null;
	}
	const defaultModel: string | null = value.defaultModel === null
		? null
		: readTrimmedString(value.defaultModel, 200);
	return {
		displayName,
		providerType: value.providerType,
		defaultModel,
		createdAt,
		updatedAt
	};
}

function normalizeModelRecord(value: unknown): ModelCustomizationRecord | null {
	if (!isRecord(value)) {
		return null;
	}
	const displayName: string | null = readTrimmedString(value.displayName, 120);
	const updatedAt: string | null = readTrimmedString(value.updatedAt, 80);
	if (
		displayName === null
		|| updatedAt === null
		|| (value.source !== "custom" && value.source !== "override")
	) {
		return null;
	}
	return {
		source: value.source,
		displayName,
		capabilities: normalizeCapabilities(value.capabilities),
		updatedAt
	};
}

function normalizeProviderCustomizations(value: unknown): ProviderCustomizations {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		return createEmptyProviderCustomizations();
	}

	const normalized: ProviderCustomizations = createEmptyProviderCustomizations();
	if (isRecord(value.providers)) {
		for (const [providerId, providerValue] of Object.entries(value.providers)) {
			if (!isProviderId(providerId)) {
				continue;
			}
			const provider: CustomProviderRecord | null = normalizeProviderRecord(providerValue);
			if (provider !== null) {
				normalized.providers[providerId] = provider;
			}
		}
	}
	if (isRecord(value.models)) {
		for (const [providerId, modelsValue] of Object.entries(value.models)) {
			if (!isProviderId(providerId) || !isRecord(modelsValue)) {
				continue;
			}
			const models: Record<string, ModelCustomizationRecord> = {};
			for (const [modelId, modelValue] of Object.entries(modelsValue)) {
				const normalizedModelId: string | null = readTrimmedString(modelId, 200);
				const model: ModelCustomizationRecord | null = normalizeModelRecord(modelValue);
				if (normalizedModelId !== null && model !== null) {
					models[normalizedModelId] = model;
				}
			}
			if (Object.keys(models).length > 0) {
				normalized.models[providerId] = models;
			}
		}
	}
	return normalized;
}

function cloneSnapshot(value: ProviderCustomizations): ProviderCustomizations {
	return structuredClone(value);
}

async function readSnapshot(filePath: string): Promise<ProviderCustomizations> {
	try {
		return normalizeProviderCustomizations(JSON.parse(await readFile(filePath, "utf8")) as unknown);
	} catch {
		return createEmptyProviderCustomizations();
	}
}

export async function initializeProviderCustomizations(force: boolean = false): Promise<void> {
	const filePath: string = getProviderCustomizationsPath();
	if (!force && initializedPath === filePath) {
		return;
	}
	snapshot = await readSnapshot(filePath);
	initializedPath = filePath;
	writeQueue = Promise.resolve();
}

export function getProviderCustomizationsSnapshot(): ProviderCustomizations {
	return snapshot;
}

export function getCustomProviderRecord(provider: ProviderId): CustomProviderRecord | undefined {
	return snapshot.providers[provider];
}

export function getModelCustomizationRecords(provider: ProviderId): Record<string, ModelCustomizationRecord> {
	return snapshot.models[provider] ?? {};
}

export async function updateProviderCustomizations(
	mutate: (draft: ProviderCustomizations) => void
): Promise<ProviderCustomizations> {
	await initializeProviderCustomizations();
	const operation: Promise<void> = writeQueue.then(async (): Promise<void> => {
		const draft: ProviderCustomizations = cloneSnapshot(snapshot);
		mutate(draft);
		await writeJsonFileAtomic(getProviderCustomizationsPath(), draft);
		snapshot = draft;
	});
	writeQueue = operation.catch((): void => undefined);
	await operation;
	return cloneSnapshot(snapshot);
}
