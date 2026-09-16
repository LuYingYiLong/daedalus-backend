import { readFile } from "node:fs/promises";
import { getFlowTreeOrderConfigPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";

const SCHEMA_VERSION: 1 = 1;

export const FLOW_TREE_SECTION_KEYS = ["pinned", "projects", "recent"] as const;
export type FlowTreeSectionKey = typeof FLOW_TREE_SECTION_KEYS[number];

export type FlowTreeOrderPreferences = {
	schemaVersion: 1;
	pinnedFlowIds: string[];
	recentFlowIds: string[];
	flowIdsByWorkspace: Record<string, string[]>;
	expandedSectionKeys: FlowTreeSectionKey[];
	expandedWorkspaceIds: string[];
	updatedAt: string;
};

export type FlowTreeOrderUpdate = Pick<
	FlowTreeOrderPreferences,
	"pinnedFlowIds"
	| "recentFlowIds"
	| "flowIdsByWorkspace"
	| "expandedSectionKeys"
	| "expandedWorkspaceIds"
>;

export type FlowTreeOrderInventory = {
	workspaces?: ReadonlyArray<{ id: string }>;
	flows: ReadonlyArray<{
		id: string;
		workspaceId: string | null;
		pinned: boolean;
	}>;
};

function createEmptyPreferences(): FlowTreeOrderPreferences {
	return {
		schemaVersion: SCHEMA_VERSION,
		pinnedFlowIds: [],
		recentFlowIds: [],
		flowIdsByWorkspace: {},
		expandedSectionKeys: [...FLOW_TREE_SECTION_KEYS],
		expandedWorkspaceIds: [],
		updatedAt: new Date(0).toISOString(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
	return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 240;
}

function hasDuplicates(values: readonly string[]): boolean {
	return new Set(values).size !== values.length;
}

function isSection(value: unknown): value is FlowTreeSectionKey {
	return typeof value === "string" && FLOW_TREE_SECTION_KEYS.includes(value as FlowTreeSectionKey);
}

function parseStoredPreferences(value: unknown): FlowTreeOrderPreferences | null {
	if (
		!isRecord(value)
		|| value.schemaVersion !== SCHEMA_VERSION
		|| !Array.isArray(value.pinnedFlowIds)
		|| !Array.isArray(value.recentFlowIds)
		|| !isRecord(value.flowIdsByWorkspace)
		|| !Array.isArray(value.expandedSectionKeys)
		|| !Array.isArray(value.expandedWorkspaceIds)
		|| typeof value.updatedAt !== "string"
		|| !value.pinnedFlowIds.every(isId)
		|| !value.recentFlowIds.every(isId)
		|| !value.expandedSectionKeys.every(isSection)
		|| !value.expandedWorkspaceIds.every(isId)
		|| hasDuplicates(value.pinnedFlowIds)
		|| hasDuplicates(value.recentFlowIds)
		|| hasDuplicates(value.expandedSectionKeys)
		|| hasDuplicates(value.expandedWorkspaceIds)
	) {
		return null;
	}

	const flowIdsByWorkspace: Record<string, string[]> = {};
	const allFlowIds: Set<string> = new Set([...value.pinnedFlowIds, ...value.recentFlowIds]);
	if (allFlowIds.size !== value.pinnedFlowIds.length + value.recentFlowIds.length) return null;
	for (const [workspaceId, candidateIds] of Object.entries(value.flowIdsByWorkspace)) {
		if (!isId(workspaceId) || !Array.isArray(candidateIds) || !candidateIds.every(isId) || hasDuplicates(candidateIds)) {
			return null;
		}
		for (const flowId of candidateIds) {
			if (allFlowIds.has(flowId)) return null;
			allFlowIds.add(flowId);
		}
		flowIdsByWorkspace[workspaceId] = [...candidateIds];
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		pinnedFlowIds: [...value.pinnedFlowIds],
		recentFlowIds: [...value.recentFlowIds],
		flowIdsByWorkspace,
		expandedSectionKeys: [...value.expandedSectionKeys],
		expandedWorkspaceIds: [...value.expandedWorkspaceIds],
		updatedAt: value.updatedAt,
	};
}

function mergeSavedOrder(currentIds: readonly string[], savedIds: readonly string[]): string[] {
	const currentIdSet: ReadonlySet<string> = new Set(currentIds);
	const knownSavedIds: string[] = savedIds.filter((id: string): boolean => currentIdSet.has(id));
	const knownSavedIdSet: ReadonlySet<string> = new Set(knownSavedIds);
	return [...currentIds.filter((id: string): boolean => !knownSavedIdSet.has(id)), ...knownSavedIds];
}

function getCurrentBuckets(inventory: FlowTreeOrderInventory): {
	pinned: string[];
	recent: string[];
	projects: Record<string, string[]>;
} {
	const pinned: string[] = [];
	const recent: string[] = [];
	const projects: Record<string, string[]> = {};
	for (const workspace of inventory.workspaces ?? []) projects[workspace.id] = [];
	for (const flow of inventory.flows) {
		if (flow.pinned) {
			pinned.push(flow.id);
		} else if (flow.workspaceId === null) {
			recent.push(flow.id);
		} else {
			(projects[flow.workspaceId] ??= []).push(flow.id);
		}
	}
	return { pinned, recent, projects };
}

export function reconcileFlowTreeOrder(
	preferences: FlowTreeOrderUpdate,
	inventory: FlowTreeOrderInventory,
	updatedAt: string = new Date().toISOString(),
): FlowTreeOrderPreferences {
	const current = getCurrentBuckets(inventory);
	const flowIdsByWorkspace: Record<string, string[]> = {};
	const workspaceIds: string[] = Object.keys(current.projects);
	for (const workspaceId of workspaceIds) {
		flowIdsByWorkspace[workspaceId] = mergeSavedOrder(
			current.projects[workspaceId] ?? [],
			preferences.flowIdsByWorkspace[workspaceId] ?? [],
		);
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		pinnedFlowIds: mergeSavedOrder(current.pinned, preferences.pinnedFlowIds),
		recentFlowIds: mergeSavedOrder(current.recent, preferences.recentFlowIds),
		flowIdsByWorkspace,
		expandedSectionKeys: preferences.expandedSectionKeys.filter(isSection),
		expandedWorkspaceIds: workspaceIds.filter((id: string): boolean => preferences.expandedWorkspaceIds.includes(id)),
		updatedAt,
	};
}

export function validateFlowTreeOrderUpdate(update: FlowTreeOrderUpdate, inventory: FlowTreeOrderInventory): void {
	const flowById: ReadonlyMap<string, FlowTreeOrderInventory["flows"][number]> = new Map(
		inventory.flows.map((flow): [string, FlowTreeOrderInventory["flows"][number]] => [flow.id, flow]),
	);
	const finalPinnedFlowIds: ReadonlySet<string> = new Set(update.pinnedFlowIds);
	const seen: Set<string> = new Set();
	const add = (flowId: string): void => {
		if (!isId(flowId) || seen.has(flowId) || !flowById.has(flowId)) {
			throw new Error("flow_tree_order_invalid_flow");
		}
		seen.add(flowId);
	};
	if (hasDuplicates(update.pinnedFlowIds) || hasDuplicates(update.recentFlowIds)) {
		throw new Error("flow_tree_order_duplicate_flow");
	}
	for (const flowId of update.pinnedFlowIds) {
		add(flowId);
	}
	for (const flowId of update.recentFlowIds) {
		add(flowId);
		if (flowById.get(flowId)!.workspaceId !== null) throw new Error("flow_tree_order_recent_workspace_mismatch");
	}
	for (const [workspaceId, flowIds] of Object.entries(update.flowIdsByWorkspace)) {
		if (!isId(workspaceId) || !Array.isArray(flowIds) || hasDuplicates(flowIds)) {
			throw new Error("flow_tree_order_invalid_workspace");
		}
		for (const flowId of flowIds) {
			add(flowId);
			const flow = flowById.get(flowId)!;
			if (finalPinnedFlowIds.has(flowId) || flow.workspaceId !== workspaceId) throw new Error("flow_tree_order_workspace_mismatch");
		}
	}
	if (seen.size !== inventory.flows.length) throw new Error("flow_tree_order_missing_flow");
	if (hasDuplicates(update.expandedSectionKeys) || !update.expandedSectionKeys.every(isSection)) {
		throw new Error("flow_tree_order_invalid_section");
	}
	if (hasDuplicates(update.expandedWorkspaceIds) || !update.expandedWorkspaceIds.every(isId)) {
		throw new Error("flow_tree_order_duplicate_workspace");
	}
}

function materializeFlowTreeOrder(update: FlowTreeOrderUpdate): FlowTreeOrderPreferences {
	return {
		schemaVersion: SCHEMA_VERSION,
		pinnedFlowIds: [...update.pinnedFlowIds],
		recentFlowIds: [...update.recentFlowIds],
		flowIdsByWorkspace: Object.fromEntries(
			Object.entries(update.flowIdsByWorkspace).map(([workspaceId, flowIds]): [string, string[]] => [workspaceId, [...flowIds]]),
		),
		expandedSectionKeys: [...update.expandedSectionKeys],
		expandedWorkspaceIds: [...update.expandedWorkspaceIds],
		updatedAt: new Date().toISOString(),
	};
}

function hasSameOrder(left: FlowTreeOrderPreferences, right: FlowTreeOrderPreferences): boolean {
	return JSON.stringify({
		pinnedFlowIds: left.pinnedFlowIds,
		recentFlowIds: left.recentFlowIds,
		flowIdsByWorkspace: left.flowIdsByWorkspace,
		expandedSectionKeys: left.expandedSectionKeys,
		expandedWorkspaceIds: left.expandedWorkspaceIds,
	}) === JSON.stringify({
		pinnedFlowIds: right.pinnedFlowIds,
		recentFlowIds: right.recentFlowIds,
		flowIdsByWorkspace: right.flowIdsByWorkspace,
		expandedSectionKeys: right.expandedSectionKeys,
		expandedWorkspaceIds: right.expandedWorkspaceIds,
	});
}

export class FlowTreeOrderStore {
	private snapshot: FlowTreeOrderPreferences = createEmptyPreferences();
	private initialized: boolean = false;
	private initializationPromise: Promise<void> | null = null;
	private writeQueue: Promise<void> = Promise.resolve();

	public constructor(private readonly filePath: string = getFlowTreeOrderConfigPath()) {}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.initializationPromise !== null) {
			await this.initializationPromise;
			return;
		}
		this.initializationPromise = (async (): Promise<void> => {
			let parsed: FlowTreeOrderPreferences | null = null;
			let replaceInvalid: boolean = false;
			try {
				parsed = parseStoredPreferences(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
				replaceInvalid = parsed === null;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") replaceInvalid = true;
			}
			this.snapshot = parsed ?? createEmptyPreferences();
			this.writeQueue = Promise.resolve();
			if (replaceInvalid) await writeJsonFileAtomic(this.filePath, this.snapshot);
			this.initialized = true;
		})();
		try {
			await this.initializationPromise;
		} finally {
			this.initializationPromise = null;
		}
	}

	public async get(inventory: FlowTreeOrderInventory): Promise<FlowTreeOrderPreferences> {
		await this.initialize();
		const operation: Promise<FlowTreeOrderPreferences> = this.writeQueue.then(async (): Promise<FlowTreeOrderPreferences> => {
			const reconciled = reconcileFlowTreeOrder(this.snapshot, inventory);
			if (!hasSameOrder(this.snapshot, reconciled)) {
				await writeJsonFileAtomic(this.filePath, reconciled);
				this.snapshot = reconciled;
			}
			return structuredClone(this.snapshot);
		});
		this.writeQueue = operation.then((): void => undefined, (): void => undefined);
		return operation;
	}

	public async update(update: FlowTreeOrderUpdate, inventory: FlowTreeOrderInventory): Promise<FlowTreeOrderPreferences> {
		await this.initialize();
		const operation: Promise<FlowTreeOrderPreferences> = this.writeQueue.then(async (): Promise<FlowTreeOrderPreferences> => {
			validateFlowTreeOrderUpdate(update, inventory);
			const reconciled = materializeFlowTreeOrder(update);
			await writeJsonFileAtomic(this.filePath, reconciled);
			this.snapshot = reconciled;
			return structuredClone(this.snapshot);
		});
		this.writeQueue = operation.then((): void => undefined, (): void => undefined);
		return operation;
	}
}

const flowTreeOrderStore: FlowTreeOrderStore = new FlowTreeOrderStore();

export async function getFlowTreeOrder(inventory: FlowTreeOrderInventory): Promise<FlowTreeOrderPreferences> {
	return flowTreeOrderStore.get(inventory);
}

export async function updateFlowTreeOrder(
	update: FlowTreeOrderUpdate,
	inventory: FlowTreeOrderInventory,
): Promise<FlowTreeOrderPreferences> {
	return flowTreeOrderStore.update(update, inventory);
}
