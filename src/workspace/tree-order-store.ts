import { readFile } from "node:fs/promises";
import { getWorkspaceTreeOrderConfigPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";

const SCHEMA_VERSION: 1 = 1;

export type WorkspaceTreeOrderPreferences = {
	schemaVersion: 1;
	workspaceIds: string[];
	sessionIdsByWorkspace: Record<string, string[]>;
	updatedAt: string;
};

export type WorkspaceTreeOrderUpdate = Pick<
	WorkspaceTreeOrderPreferences,
	"workspaceIds" | "sessionIdsByWorkspace"
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

function parseStoredPreferences(value: unknown): WorkspaceTreeOrderPreferences | null {
	if (
		!isRecord(value)
		|| value.schemaVersion !== SCHEMA_VERSION
		|| !Array.isArray(value.workspaceIds)
		|| !isRecord(value.sessionIdsByWorkspace)
		|| typeof value.updatedAt !== "string"
		|| !value.workspaceIds.every(isId)
		|| hasDuplicates(value.workspaceIds)
	) {
		return null;
	}

	const sessionIdsByWorkspace: Record<string, string[]> = {};
	const allSessionIds: Set<string> = new Set();
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

export function reconcileWorkspaceTreeOrder(
	preferences: WorkspaceTreeOrderUpdate,
	inventory: WorkspaceTreeOrderInventory,
	updatedAt: string = new Date().toISOString()
): WorkspaceTreeOrderPreferences {
	const currentWorkspaceIds: string[] = inventory.workspaces.map((workspace): string => workspace.id);
	const visibleSessionIdsByWorkspace: Record<string, string[]> = createVisibleSessionIdsByWorkspace(inventory);
	const workspaceIds: string[] = mergeSavedOrder(currentWorkspaceIds, preferences.workspaceIds);
	const sessionIdsByWorkspace: Record<string, string[]> = {};

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
	const seenSessionIds: Set<string> = new Set();
	for (const [workspaceId, sessionIds] of Object.entries(update.sessionIdsByWorkspace)) {
		if (hasDuplicates(sessionIds)) {
			throw new Error("workspace_tree_order_duplicate_session");
		}
		for (const sessionId of sessionIds) {
			if (seenSessionIds.has(sessionId)) {
				throw new Error("workspace_tree_order_duplicate_session");
			}
			seenSessionIds.add(sessionId);
			const actualWorkspaceId: string | undefined = knownSessionWorkspaceById.get(sessionId);
			if (actualWorkspaceId !== undefined && actualWorkspaceId !== workspaceId) {
				throw new Error("workspace_tree_order_session_workspace_mismatch");
			}
		}
	}
}

function hasSameOrder(
	left: WorkspaceTreeOrderPreferences,
	right: WorkspaceTreeOrderPreferences
): boolean {
	return JSON.stringify({
		workspaceIds: left.workspaceIds,
		sessionIdsByWorkspace: left.sessionIdsByWorkspace
	}) === JSON.stringify({
		workspaceIds: right.workspaceIds,
		sessionIdsByWorkspace: right.sessionIdsByWorkspace
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
