import { readFile } from "node:fs/promises";
import { getProviderCustomizationsPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type { ProviderId } from "../protocol/types.js";
import type {
	BaseReasoningEffort,
	ProviderModelCapabilityOverrides,
	ProviderModelCustomizationInfo,
	ProviderReasoningEffortOption
} from "./provider-types.js";

export type CustomProviderType = "openai" | "openai-responses" | "anthropic";
export type ModelCustomizationSource = "custom" | "override";

export type EditableModelCapabilities = ProviderModelCapabilityOverrides;

export type CustomProviderRecord = {
	displayName: string;
	providerType: CustomProviderType;
	defaultModel: string | null;
	createdAt: string;
	updatedAt: string;
};

export type ModelCustomizationRecord = ProviderModelCustomizationInfo;

export type ProviderCustomizations = {
	schemaVersion: 4;
	providers: Record<ProviderId, CustomProviderRecord>;
	models: Record<ProviderId, Record<string, ModelCustomizationRecord>>;
	excludedModelIds: Record<ProviderId, string[]>;
};

const EDITABLE_CAPABILITY_KEYS = [
	"imageInput",
	"videoInput",
	"reasoning",
	"tools",
	"webSearch",
	"imageGeneration",
	"imageEdit"
] as const;

let snapshot: ProviderCustomizations = createEmptyProviderCustomizations();
let initializedPath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function createEmptyProviderCustomizations(): ProviderCustomizations {
	return {
		schemaVersion: 4,
		providers: {},
		models: {},
		excludedModelIds: {}
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
		return {};
	}
	const capabilities: EditableModelCapabilities = {};
	for (const key of EDITABLE_CAPABILITY_KEYS) {
		if (typeof value[key] === "boolean") {
			capabilities[key] = value[key];
		}
	}
	return capabilities;
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

function readPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function normalizeReasoningEfforts(value: unknown): ProviderReasoningEffortOption[] | null {
	if (!Array.isArray(value) || value.length > 16) {
		return null;
	}
	const efforts: ProviderReasoningEffortOption[] = [];
	const ids: Set<string> = new Set();
	let defaultSeen: boolean = false;
	for (const item of value) {
		if (!isRecord(item)) {
			return null;
		}
		const id: string | null = readTrimmedString(item.id, 32);
		const fallback: unknown = item.fallback;
		if (
			id === null
			|| ids.has(id)
			|| (fallback !== "low" && fallback !== "medium" && fallback !== "high" && fallback !== "max")
			|| (item.default !== undefined && typeof item.default !== "boolean")
			|| (item.default === true && defaultSeen)
		) {
			return null;
		}
		ids.add(id);
		defaultSeen ||= item.default === true;
		efforts.push({
			id,
			fallback: fallback as BaseReasoningEffort,
			...(item.default === true ? { default: true } : {})
		});
	}
	return efforts;
}

function normalizeModelRecord(value: unknown): ModelCustomizationRecord | null {
	if (!isRecord(value)) {
		return null;
	}
	const displayName: string | null = value.displayName === undefined
		? null
		: readTrimmedString(value.displayName, 120);
	const updatedAt: string | null = readTrimmedString(value.updatedAt, 80);
	if (
		updatedAt === null
		|| (value.source !== "custom" && value.source !== "override")
	) {
		return null;
	}
	const contextWindowTokens: number | undefined = readPositiveInteger(value.contextWindowTokens);
	const maxOutputTokens: number | undefined = readPositiveInteger(value.maxOutputTokens);
	const reasoningEfforts: ProviderReasoningEffortOption[] | undefined | null = value.reasoningEfforts === undefined
		? undefined
		: normalizeReasoningEfforts(value.reasoningEfforts);
	if (
		reasoningEfforts === null
		|| (
			value.source === "custom"
			&& (displayName === null || contextWindowTokens === undefined || maxOutputTokens === undefined || reasoningEfforts === undefined)
		)
	) {
		return null;
	}
	const model: ModelCustomizationRecord = {
		source: value.source,
		capabilities: normalizeCapabilities(value.capabilities),
		updatedAt
	};
	if (displayName !== null) {
		model.displayName = displayName;
	}
	if (contextWindowTokens !== undefined) {
		model.contextWindowTokens = contextWindowTokens;
	}
	if (maxOutputTokens !== undefined) {
		model.maxOutputTokens = maxOutputTokens;
	}
	if (reasoningEfforts !== undefined) {
		model.reasoningEfforts = reasoningEfforts;
	}
	return model;
}

function normalizeProviderCustomizations(value: unknown): ProviderCustomizations {
	if (!isRecord(value) || value.schemaVersion !== 4) {
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
	if (isRecord(value.excludedModelIds)) {
		for (const [providerId, excludedValue] of Object.entries(value.excludedModelIds)) {
			if (!isProviderId(providerId) || !Array.isArray(excludedValue)) {
				continue;
			}
			const excludedIds: string[] = [...new Set(
				excludedValue
					.map((modelId: unknown): string | null => readTrimmedString(modelId, 200))
					.filter((modelId: string | null): modelId is string => modelId !== null)
			)].sort((left: string, right: string): number => left.localeCompare(right));
			if (excludedIds.length > 0) {
				normalized.excludedModelIds[providerId] = excludedIds;
			}
		}
	}
	return normalized;
}

function cloneSnapshot(value: ProviderCustomizations): ProviderCustomizations {
	return structuredClone(value);
}

type ReadSnapshotResult = {
	value: ProviderCustomizations;
	replaceFile: boolean;
};

async function readSnapshot(filePath: string): Promise<ReadSnapshotResult> {
	try {
		const raw: unknown = JSON.parse(await readFile(filePath, "utf8")) as unknown;
		const validSchema: boolean = isRecord(raw) && raw.schemaVersion === 4;
		return {
			value: normalizeProviderCustomizations(raw),
			replaceFile: !validSchema
		};
	} catch {
		return {
			value: createEmptyProviderCustomizations(),
			replaceFile: false
		};
	}
}

export async function initializeProviderCustomizations(force: boolean = false): Promise<void> {
	const filePath: string = getProviderCustomizationsPath();
	if (!force && initializedPath === filePath) {
		return;
	}
	const result: ReadSnapshotResult = await readSnapshot(filePath);
	snapshot = result.value;
	initializedPath = filePath;
	writeQueue = Promise.resolve();
	if (result.replaceFile) {
		await writeJsonFileAtomic(filePath, snapshot);
	}
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

export function getExcludedModelIds(provider: ProviderId): readonly string[] {
	return snapshot.excludedModelIds[provider] ?? [];
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
