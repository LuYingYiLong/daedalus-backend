import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDaedalusPath } from "../../app-paths.js";
import type { WorkspaceConfig, WorkspaceSourceFolder } from "../../workspace/types.js";
import { findPluginDevelopmentRecord, updatePluginDevelopmentRecords } from "./store.js";
import { pluginDevelopmentSnapshotSchema, type PluginDevelopmentProposal, type PluginDevelopmentRecord, type PluginDevelopmentScope, type PluginDevelopmentSnapshot } from "./types.js";
import { validatePluginDevelopmentSnapshot } from "./validation.js";

const MAX_TOTAL_BYTES: number = 1024 * 1024;
const PROPOSAL_TTL_MS: number = 15 * 60 * 1000;

type PendingProposal = {
	token: string;
	sessionId: string;
	targetRoot: string;
	snapshot: PluginDevelopmentSnapshot;
	proposedRevision: string;
	workspaceId?: string | undefined;
	sourceFolderId?: string | undefined;
	valid: boolean;
	expiresAt: number;
};

const proposals = new Map<string, PendingProposal>();
const rootLocks = new Map<string, Promise<void>>();

function isInside(root: string, candidate: string): boolean {
	const child = relative(resolve(root), resolve(candidate));
	return child.length === 0 || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function normalizeFiles(snapshot: PluginDevelopmentSnapshot): PluginDevelopmentSnapshot["files"] {
	return [...snapshot.files].sort((left, right): number => left.path.localeCompare(right.path));
}

export function hashPluginDevelopmentFiles(files: PluginDevelopmentSnapshot["files"]): string {
	const hash = createHash("sha256");
	for (const file of normalizeFiles({ slug: "x", scope: "personal", files })) hash.update(`${file.path}\0${file.content.length}\0${file.content}\0`);
	return hash.digest("hex");
}

async function hashDirectory(root: string): Promise<string | null> {
	try {
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Plugin development root must be a real directory.");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const files: Array<{ path: string; content: string }> = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) throw new Error("Plugin development directories cannot contain symbolic links.");
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) await visit(absolute);
			else if (entry.isFile()) files.push({ path: relative(root, absolute).split(sep).join("/"), content: await readFile(absolute, "utf8") });
			else throw new Error("Plugin development directories can only contain regular files.");
		}
	}
	await visit(root);
	return hashPluginDevelopmentFiles(files);
}

function resolveWorkspaceSource(workspace: WorkspaceConfig, sourceFolderId?: string): WorkspaceSourceFolder {
	const source = workspace.sourceFolders.find((candidate): boolean => candidate.id === (sourceFolderId ?? workspace.primarySourceFolderId));
	if (source === undefined) throw Object.assign(new Error("Plugin development source folder was not found."), { code: "plugin_dev_source_not_found" });
	return source;
}

export function resolvePluginDevelopmentRoot(snapshot: Pick<PluginDevelopmentSnapshot, "slug" | "scope" | "sourceFolderId">, workspace?: WorkspaceConfig): string {
	if (snapshot.scope === "personal") return join(getDaedalusPath("plugins.development"), snapshot.slug);
	if (workspace === undefined) throw Object.assign(new Error("Workspace plugin development requires an active workspace."), { code: "plugin_dev_workspace_required" });
	return join(resolveWorkspaceSource(workspace, snapshot.sourceFolderId).path, "plugins", snapshot.slug);
}

function displayPath(root: string, scope: PluginDevelopmentSnapshot["scope"]): string {
	return scope === "personal" ? `%USERPROFILE%/.daedalus/plugin-dev/${root.split(sep).at(-1) ?? "plugin"}` : root;
}

export async function preparePluginDevelopmentSnapshot(input: unknown, sessionId: string, workspace?: WorkspaceConfig): Promise<PluginDevelopmentProposal> {
	const snapshot = pluginDevelopmentSnapshotSchema.parse(input);
	const totalBytes = snapshot.files.reduce((sum, file): number => sum + Buffer.byteLength(file.content, "utf8"), 0);
	if (totalBytes > MAX_TOTAL_BYTES) throw Object.assign(new Error("Plugin development snapshot exceeds 1 MiB."), { code: "plugin_dev_snapshot_too_large" });
	if (new Set(snapshot.files.map((file): string => file.path.toLowerCase())).size !== snapshot.files.length) throw Object.assign(new Error("Plugin development snapshot contains duplicate paths."), { code: "plugin_dev_duplicate_path" });
	const targetRoot = resolvePluginDevelopmentRoot(snapshot, workspace);
	const currentRevision = await hashDirectory(targetRoot);
	const owner = await findPluginDevelopmentRecord(targetRoot);
	if (currentRevision !== null && owner === undefined) throw Object.assign(new Error("The target directory already exists and is not managed by @plugin-creator."), { code: "plugin_dev_target_unmanaged" });
	if (currentRevision !== null && snapshot.expectedRevision !== currentRevision) throw Object.assign(new Error("Plugin source changed. Reload it before preparing another revision."), { code: "plugin_dev_revision_conflict" });
	if (currentRevision === null && snapshot.expectedRevision !== undefined) throw Object.assign(new Error("The requested base revision no longer exists."), { code: "plugin_dev_revision_conflict" });
	const validation = await validatePluginDevelopmentSnapshot(snapshot.files);
	const proposedRevision = hashPluginDevelopmentFiles(snapshot.files);
	const token = createHash("sha256").update(`${sessionId}\n${targetRoot}\n${currentRevision ?? "new"}\n${proposedRevision}\n${randomUUID()}`).digest("hex");
	const sourceFolderId = snapshot.scope === "workspace" && workspace !== undefined
		? resolveWorkspaceSource(workspace, snapshot.sourceFolderId).id
		: undefined;
	proposals.set(token, {
		token,
		sessionId,
		targetRoot,
		snapshot,
		proposedRevision,
		...(workspace === undefined ? {} : { workspaceId: workspace.id }),
		...(sourceFolderId === undefined ? {} : { sourceFolderId }),
		valid: !validation.diagnostics.some((item): boolean => item.severity === "error"),
		expiresAt: Date.now() + PROPOSAL_TTL_MS
	});
	for (const [proposalToken, proposal] of proposals) if (proposal.expiresAt <= Date.now()) proposals.delete(proposalToken);
	return { proposalToken: token, currentRevision, proposedRevision, diagnostics: validation.diagnostics, capabilitySummary: validation.capabilitySummary, targetDisplayPath: displayPath(targetRoot, snapshot.scope) };
}

async function commitSnapshot(proposal: PendingProposal): Promise<PluginDevelopmentRecord> {
	const { snapshot, targetRoot } = proposal;
	const currentRevision = await hashDirectory(targetRoot);
	if ((snapshot.expectedRevision ?? null) !== currentRevision) throw Object.assign(new Error("Plugin source changed after proposal creation."), { code: "plugin_dev_revision_conflict" });
	const parent = resolve(targetRoot, "..");
	await mkdir(parent, { recursive: true });
	const staging = join(parent, `.${snapshot.slug}.${randomUUID()}.staging`);
	const backup = join(parent, `.${snapshot.slug}.${randomUUID()}.backup`);
	await mkdir(staging, { recursive: false });
	let backedUp = false;
	try {
		for (const file of snapshot.files) {
			const target = join(staging, ...file.path.split("/"));
			if (!isInside(staging, target)) throw new Error("Plugin file path escapes the staging directory.");
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, file.content, "utf8");
		}
		if ((await hashDirectory(staging)) !== proposal.proposedRevision) throw new Error("Plugin staging revision mismatch.");
		try {
			await rename(targetRoot, backup);
			backedUp = true;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(staging, targetRoot);
		} catch (error: unknown) {
			if (backedUp) await rename(backup, targetRoot).catch((): void => undefined);
			throw error;
		}
		const manifest = JSON.parse(await readFile(join(targetRoot, "package.json"), "utf8")) as Record<string, unknown>;
		const record: PluginDevelopmentRecord = {
			slug: snapshot.slug,
			rootPath: targetRoot,
			packageName: typeof manifest.name === "string" ? manifest.name : snapshot.slug,
			scope: snapshot.scope,
			...(snapshot.scope === "workspace" && proposal.workspaceId !== undefined ? { workspaceId: proposal.workspaceId } : {}),
			...(snapshot.scope === "workspace" && proposal.sourceFolderId !== undefined ? { sourceFolderId: proposal.sourceFolderId } : {}),
			revision: proposal.proposedRevision,
			updatedAt: new Date().toISOString(),
			lastSessionId: proposal.sessionId
		};
		try {
			await updatePluginDevelopmentRecords((records): PluginDevelopmentRecord[] => [...records.filter((candidate): boolean => candidate.rootPath !== targetRoot), record]);
		} catch (error: unknown) {
			await rm(targetRoot, { recursive: true, force: true }).catch((): void => undefined);
			if (backedUp) await rename(backup, targetRoot).catch((): void => undefined);
			throw error;
		}
		if (backedUp) await rm(backup, { recursive: true, force: true });
		return record;
	} finally {
		await rm(staging, { recursive: true, force: true }).catch((): void => undefined);
	}
}

export async function applyPluginDevelopmentSnapshot(proposalToken: string, sessionId: string): Promise<PluginDevelopmentRecord> {
	const proposal = proposals.get(proposalToken);
	if (proposal === undefined || proposal.sessionId !== sessionId || proposal.expiresAt <= Date.now()) throw Object.assign(new Error("Plugin development proposal is missing, expired, or belongs to another session."), { code: "plugin_dev_proposal_invalid" });
	proposals.delete(proposalToken);
	if (!proposal.valid) throw Object.assign(new Error("Plugin development proposal contains blocking diagnostics."), { code: "plugin_dev_validation_required" });
	const previous = rootLocks.get(proposal.targetRoot) ?? Promise.resolve();
	let result!: PluginDevelopmentRecord;
	const operation = previous.then(async (): Promise<void> => { result = await commitSnapshot(proposal); });
	const settled = operation.catch((): void => undefined);
	rootLocks.set(proposal.targetRoot, settled);
	try {
		await operation;
	} finally {
		if (rootLocks.get(proposal.targetRoot) === settled) rootLocks.delete(proposal.targetRoot);
	}
	return result;
}

export async function resolveManagedDevelopmentRoot(input: { slug: string; scope: PluginDevelopmentScope; sourceFolderId?: string | undefined }, workspace?: WorkspaceConfig): Promise<{ rootPath: string; revision: string; record: PluginDevelopmentRecord }> {
	const rootPath = resolvePluginDevelopmentRoot(input, workspace);
	const record = await findPluginDevelopmentRecord(rootPath);
	if (record === undefined) throw Object.assign(new Error("Plugin development project is not managed by @plugin-creator."), { code: "plugin_dev_not_found" });
	const revision = await hashDirectory(rootPath);
	if (revision === null || revision !== record.revision) throw Object.assign(new Error("Plugin source changed outside @plugin-creator. Prepare a new revision first."), { code: "plugin_dev_revision_conflict" });
	return { rootPath, revision, record };
}
