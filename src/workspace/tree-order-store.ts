import { readFile } from "node:fs/promises";
import { getWorkspaceTreeOrderConfigPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";

const SCHEMA_VERSION: 2 = 2;

export const WORKSPACE_TREE_SECTION_KEYS = ["pinned", "projects", "recent"] as const;
export type WorkspaceTreeSectionKey = typeof WORKSPACE_TREE_SECTION_KEYS[number];

export type WorkspaceTreeOrderPreferences = {
	schemaVersion: 2;
	workspaceIds: string[];
	sessionIdsByWorkspace: Record<string, string[]>;
	pinnedSessionIds: string[];
	recentSessionIds: string[];
	expandedSectionKeys: WorkspaceTreeSectionKey[];
	expandedWorkspaceIds: string[];
	updatedAt: string;
};

export type WorkspaceTreeOrderUpdate = Pick<
	WorkspaceTreeOrderPreferences,
	"workspaceIds"
	| "sessionIdsByWorkspace"
	| "pinnedSessionIds"
	| "recentSessionIds"
	| "expandedSectionKeys"
	| "expandedWorkspaceIds"
>;

export type WorkspaceTreeOrderInventory = {
	workspaces: ReadonlyArray<{ id: string }>;
	sessions: ReadonlyArray<{
		id: string;
		workspaceId?: string | undefined;
		pinned?: boolean | undefined;
		temporary?: boolean | undefined;
	}>;
};

function createEmptyPreferences(): WorkspaceTreeOrderPreferences {
	return {
		schemaVersion: SCHEMA_VERSION,
		workspaceIds: [],
		sessionIdsByWorkspace: {},
		pinnedSessionIds: [],
		recentSessionIds: [],
		expandedSectionKeys: [...WORKSPACE_TREE_SECTION_KEYS],
		expandedWorkspaceIds: [],
		updatedAt: new Date(0).toISOString()
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

function isWorkspaceTreeSectionKey(value: unknown): value is WorkspaceTreeSectionKey {
	return typeof value === "string" && WORKSPACE_TREE_SECTION_KEYS.includes(value as WorkspaceTreeSectionKey);
}

function parseStoredPreferences(value: unknown): WorkspaceTreeOrderPreferences | null {
	if (
		!isRecord(value)
		|| value.schemaVersion !== SCHEMA_VERSION
		|| !Array.isArray(value.workspaceIds)
		|| !isRecord(value.sessionIdsByWorkspace)
		|| !Array.isArray(value.pinnedSessionIds)
		|| !Array.isArray(value.recentSessionIds)
		|| !Array.isArray(value.expandedSectionKeys)
		|| (value.expandedWorkspaceIds !== undefined && !Array.isArray(value.expandedWorkspaceIds))
		|| typeof value.updatedAt !== "string"
		|| !value.workspaceIds.every(isId)
		|| !value.pinnedSessionIds.every(isId)
		|| !value.recentSessionIds.every(isId)
		|| !value.expandedSectionKeys.every(isWorkspaceTreeSectionKey)
		|| (Array.isArray(value.expandedWorkspaceIds) && !value.expandedWorkspaceIds.every(isId))
		|| hasDuplicates(value.workspaceIds)
		|| hasDuplicates(value.pinnedSessionIds)
		|| hasDuplicates(value.recentSessionIds)
		|| hasDuplicates(value.expandedSectionKeys)
		|| (Array.isArray(value.expandedWorkspaceIds) && hasDuplicates(value.expandedWorkspaceIds))
	) {
		return null;
	}

	const sessionIdsByWorkspace: Record<string, string[]> = {};
	const allSessionIds: Set<string> = new Set([
		...value.pinnedSessionIds,
		...value.recentSessionIds
	]);
	if (allSessionIds.size !== value.pinnedSessionIds.length + value.recentSessionIds.length) {
		return null;
	}
	for (const [workspaceId, candidateIds] of Object.entries(value.sessionIdsByWorkspace)) {
		if (!isId(workspaceId) || !Array.isArray(candidateIds) || !candidateIds.every(isId) || hasDuplicates(candidateIds)) {
			return null;
		}
		for (const sessionId of candidateIds) {
			if (allSessionIds.has(sessionId)) {
				return null;
			}
			allSessionIds.add(sessionId);
		}
		sessionIdsByWorkspace[workspaceId] = [...candidateIds];
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		workspaceIds: [...value.workspaceIds],
		sessionIdsByWorkspace,
		pinnedSessionIds: [...value.pinnedSessionIds],
		recentSessionIds: [...value.recentSessionIds],
		expandedSectionKeys: [...value.expandedSectionKeys],
		// Older v2 snapshots predate per-workspace expansion persistence. Preserve
		// their previous UI behavior by treating every saved workspace as expanded.
		expandedWorkspaceIds: Array.isArray(value.expandedWorkspaceIds)
			? [...value.expandedWorkspaceIds]
			: [...value.workspaceIds],
		updatedAt: value.updatedAt
	};
}

function mergeSavedOrder(currentIds: readonly string[], savedIds: readonly string[]): string[] {
	const currentIdSet: ReadonlySet<string> = new Set(currentIds);
	const knownSavedIds: string[] = savedIds.filter((id: string): boolean => currentIdSet.has(id));
	const knownSavedIdSet: ReadonlySet<string> = new Set(knownSavedIds);
	const newIds: string[] = currentIds.filter((id: string): boolean => !knownSavedIdSet.has(id));
	return [...newIds, ...knownSavedIds];
}

function createVisibleSessionIdsByWorkspace(
	inventory: WorkspaceTreeOrderInventory
): Record<string, string[]> {
	const workspaceIdSet: ReadonlySet<string> = new Set(
		inventory.workspaces.map((workspace): string => workspace.id)
	);
	const result: Record<string, string[]> = Object.fromEntries(
		inventory.workspaces.map((workspace): [string, string[]] => [workspace.id, []])
	);
	for (const session of inventory.sessions) {
		if (
			session.temporary === true
			|| session.pinned === true
			|| session.workspaceId === undefined
			|| !workspaceIdSet.has(session.workspaceId)
		) {
			continue;
		}
		result[session.workspaceId]!.push(session.id);
	}
	return result;
}

function createVisiblePinnedSessionIds(inventory: WorkspaceTreeOrderInventory): string[] {
	return inventory.sessions
		.filter((session): boolean => session.temporary !== true && session.pinned === true)
		.map((session): string => session.id);
}

function createVisibleRecentSessionIds(inventory: WorkspaceTreeOrderInventory): string[] {
	const workspaceIdSet: ReadonlySet<string> = new Set(
		inventory.workspaces.map((workspace): string => workspace.id)
	);
	return inventory.sessions
		.filter((session): boolean => {
			return session.temporary !== true
				&& session.pinned !== true
				&& (session.workspaceId === undefined || !workspaceIdSet.has(session.workspaceId));
		})
		.map((session): string => session.id);
}

export function reconcileWorkspaceTreeOrder(
	preferences: WorkspaceTreeOrderUpdate,
	inventory: WorkspaceTreeOrderInventory,
	updatedAt: string = new Date().toISOString()
): WorkspaceTreeOrderPreferences {
	const currentWorkspaceIds: string[] = inventory.workspaces.map((workspace): string => workspace.id);
	const currentWorkspaceIdSet: ReadonlySet<string> = new Set(currentWorkspaceIds);
	const savedWorkspaceIdSet: ReadonlySet<string> = new Set(preferences.workspaceIds);
	const savedExpandedWorkspaceIdSet: ReadonlySet<string> = new Set(preferences.expandedWorkspaceIds);
	const visibleSessionIdsByWorkspace: Record<string, string[]> = createVisibleSessionIdsByWorkspace(inventory);
	const workspaceIds: string[] = mergeSavedOrder(currentWorkspaceIds, preferences.workspaceIds);
	const sessionIdsByWorkspace: Record<string, string[]> = {};
	const pinnedSessionIds: string[] = mergeSavedOrder(
		createVisiblePinnedSessionIds(inventory),
		preferences.pinnedSessionIds
	);
	const recentSessionIds: string[] = mergeSavedOrder(
		createVisibleRecentSessionIds(inventory),
		preferences.recentSessionIds
	);

	for (const workspaceId of workspaceIds) {
		sessionIdsByWorkspace[workspaceId] = mergeSavedOrder(
			visibleSessionIdsByWorkspace[workspaceId] ?? [],
			preferences.sessionIdsByWorkspace[workspaceId] ?? []
		);
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		workspaceIds,
		sessionIdsByWorkspace,
		pinnedSessionIds,
		recentSessionIds,
		expandedSectionKeys: preferences.expandedSectionKeys.filter(isWorkspaceTreeSectionKey),
		expandedWorkspaceIds: workspaceIds.filter((workspaceId: string): boolean => {
			return currentWorkspaceIdSet.has(workspaceId)
				&& (!savedWorkspaceIdSet.has(workspaceId) || savedExpandedWorkspaceIdSet.has(workspaceId));
		}),
		updatedAt
	};
}

export function validateWorkspaceTreeOrderUpdate(
	update: WorkspaceTreeOrderUpdate,
	inventory: WorkspaceTreeOrderInventory
): void {
	if (hasDuplicates(update.workspaceIds)) {
		throw new Error("workspace_tree_order_duplicate_workspace");
	}

	const knownSessionWorkspaceById: ReadonlyMap<string, string | undefined> = new Map(
		inventory.sessions.map((session): [string, string | undefined] => [session.id, session.workspaceId])
	);
	const knownSessionById: ReadonlyMap<string, WorkspaceTreeOrderInventory["sessions"][number]> = new Map(
		inventory.sessions.map((session): [string, WorkspaceTreeOrderInventory["sessions"][number]] => [session.id, session])
	);
	const knownWorkspaceIds: ReadonlySet<string> = new Set(
		inventory.workspaces.map((workspace): string => workspace.id)
	);
	const seenSessionIds: Set<string> = new Set();
	const addSessionId = (sessionId: string): void => {
		if (seenSessionIds.has(sessionId)) {
			throw new Error("workspace_tree_order_duplicate_session");
		}
		seenSessionIds.add(sessionId);
	};

	if (hasDuplicates(update.pinnedSessionIds) || hasDuplicates(update.recentSessionIds)) {
		throw new Error("workspace_tree_order_duplicate_session");
	}
	for (const sessionId of update.pinnedSessionIds) {
		addSessionId(sessionId);
		const knownSession = knownSessionById.get(sessionId);
		if (knownSession !== undefined && knownSession.pinned !== true) {
			throw new Error("workspace_tree_order_session_section_mismatch");
		}
	}
	for (const sessionId of update.recentSessionIds) {
		addSessionId(sessionId);
		const knownSession = knownSessionById.get(sessionId);
		if (
			knownSession !== undefined
			&& (
				knownSession.pinned === true
				|| (
					knownSession.workspaceId !== undefined
					&& knownWorkspaceIds.has(knownSession.workspaceId)
				)
			)
		) {
			throw new Error("workspace_tree_order_session_section_mismatch");
		}
	}
	for (const [workspaceId, sessionIds] of Object.entries(update.sessionIdsByWorkspace)) {
		if (hasDuplicates(sessionIds)) {
			throw new Error("workspace_tree_order_duplicate_session");
		}
		for (const sessionId of sessionIds) {
			addSessionId(sessionId);
			const knownSession = knownSessionById.get(sessionId);
			const actualWorkspaceId: string | undefined = knownSessionWorkspaceById.get(sessionId);
			if (knownSession !== undefined && actualWorkspaceId !== workspaceId) {
				throw new Error("workspace_tree_order_session_workspace_mismatch");
			}
			if (knownSession?.pinned === true) {
				throw new Error("workspace_tree_order_session_section_mismatch");
			}
		}
	}
	if (
		hasDuplicates(update.expandedSectionKeys)
		|| !update.expandedSectionKeys.every(isWorkspaceTreeSectionKey)
	) {
		throw new Error("workspace_tree_order_invalid_section");
	}
	if (hasDuplicates(update.expandedWorkspaceIds)) {
		throw new Error("workspace_tree_order_duplicate_expanded_workspace");
	}
}

function hasSameOrder(
	left: WorkspaceTreeOrderPreferences,
	right: WorkspaceTreeOrderPreferences
): boolean {
	return JSON.stringify({
		workspaceIds: left.workspaceIds,
		sessionIdsByWorkspace: left.sessionIdsByWorkspace,
		pinnedSessionIds: left.pinnedSessionIds,
		recentSessionIds: left.recentSessionIds,
		expandedSectionKeys: left.expandedSectionKeys,
		expandedWorkspaceIds: left.expandedWorkspaceIds
	}) === JSON.stringify({
		workspaceIds: right.workspaceIds,
		sessionIdsByWorkspace: right.sessionIdsByWorkspace,
		pinnedSessionIds: right.pinnedSessionIds,
		recentSessionIds: right.recentSessionIds,
		expandedSectionKeys: right.expandedSectionKeys,
		expandedWorkspaceIds: right.expandedWorkspaceIds
	});
}

export class WorkspaceTreeOrderStore {
	private snapshot: WorkspaceTreeOrderPreferences = createEmptyPreferences();
	private initialized: boolean = false;
	private initializationPromise: Promise<void> | null = null;
	private writeQueue: Promise<void> = Promise.resolve();

	public constructor(private readonly filePath: string) {}

	private async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}
		if (this.initializationPromise !== null) {
			await this.initializationPromise;
			return;
		}

		this.initializationPromise = (async (): Promise<void> => {
			let parsed: WorkspaceTreeOrderPreferences | null = null;
			let replaceInvalid: boolean = false;
			try {
				const raw: unknown = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
				parsed = parseStoredPreferences(raw);
				replaceInvalid = parsed === null;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					replaceInvalid = true;
				}
			}
			this.snapshot = parsed ?? createEmptyPreferences();
			this.writeQueue = Promise.resolve();
			if (replaceInvalid) {
				await writeJsonFileAtomic(this.filePath, this.snapshot);
			}
			this.initialized = true;
		})();
		try {
			await this.initializationPromise;
		} finally {
			this.initializationPromise = null;
		}
	}

	public async get(inventory: WorkspaceTreeOrderInventory): Promise<WorkspaceTreeOrderPreferences> {
		await this.initialize();
		const operation: Promise<WorkspaceTreeOrderPreferences> = this.writeQueue.then(
			async (): Promise<WorkspaceTreeOrderPreferences> => {
				const reconciled: WorkspaceTreeOrderPreferences = reconcileWorkspaceTreeOrder(this.snapshot, inventory);
				if (!hasSameOrder(this.snapshot, reconciled)) {
					await writeJsonFileAtomic(this.filePath, reconciled);
					this.snapshot = reconciled;
				}
				return structuredClone(this.snapshot);
			}
		);
		this.writeQueue = operation.then((): void => undefined, (): void => undefined);
		return operation;
	}

	public async update(
		update: WorkspaceTreeOrderUpdate,
		inventory: WorkspaceTreeOrderInventory
	): Promise<WorkspaceTreeOrderPreferences> {
		await this.initialize();
		const operation: Promise<WorkspaceTreeOrderPreferences> = this.writeQueue.then(
			async (): Promise<WorkspaceTreeOrderPreferences> => {
				validateWorkspaceTreeOrderUpdate(update, inventory);
				const reconciled: WorkspaceTreeOrderPreferences = reconcileWorkspaceTreeOrder(update, inventory);
				await writeJsonFileAtomic(this.filePath, reconciled);
				this.snapshot = reconciled;
				return structuredClone(this.snapshot);
			}
		);
		this.writeQueue = operation.then((): void => undefined, (): void => undefined);
		return operation;
	}
}

const workspaceTreeOrderStore: WorkspaceTreeOrderStore = new WorkspaceTreeOrderStore(
	getWorkspaceTreeOrderConfigPath()
);

export async function getWorkspaceTreeOrder(
	inventory: WorkspaceTreeOrderInventory
): Promise<WorkspaceTreeOrderPreferences> {
	return workspaceTreeOrderStore.get(inventory);
}

export async function updateWorkspaceTreeOrder(
	update: WorkspaceTreeOrderUpdate,
	inventory: WorkspaceTreeOrderInventory
): Promise<WorkspaceTreeOrderPreferences> {
	return workspaceTreeOrderStore.update(update, inventory);
}
