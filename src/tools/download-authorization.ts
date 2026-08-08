import { createHash } from "node:crypto";
import type { WorkspaceFileRef } from "../workspace/source-context.js";

export const DOWNLOAD_CRITICALITIES = ["required", "recommended", "optional"] as const;
export type DownloadCriticality = typeof DOWNLOAD_CRITICALITIES[number];

export type DownloadRequest = {
	url: string;
	sourceFolderId: string;
	relativePath: string;
	dependency: string;
	purpose: string;
	criticality: DownloadCriticality;
	expectedSha256?: string | undefined;
	overwrite: boolean;
};

export type DownloadAuthorizationScope = {
	kind: "network_download";
	requestId: string;
	workspaceId?: string | undefined;
	fingerprints: string[];
	downloads: DownloadRequest[];
};

export type NetworkAccessRequired = {
	code: "network_access_required";
	category: "policy";
	dependency: string;
	purpose: string;
	criticality: DownloadCriticality;
	target: WorkspaceFileRef;
	execution: "download_only";
	approvalRequired: true;
};

type DownloadScopeEntry = Omit<DownloadRequest, "overwrite"> & {
	overwrite?: boolean | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDownloadCriticality(value: unknown): value is DownloadCriticality {
	return typeof value === "string" && (DOWNLOAD_CRITICALITIES as readonly string[]).includes(value);
}

function normalizeSha256(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const normalized: string = value.trim().toLowerCase();
	return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : undefined;
}

function normalizeString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isAllowedDownloadUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
	} catch {
		return false;
	}
}

function parseDownloadRequest(value: unknown): DownloadRequest | null {
	if (!isRecord(value)) return null;
	const url: string | null = normalizeString(value.url);
	const sourceFolderId: string | null = normalizeString(value.sourceFolderId);
	const relativePath: string | null = normalizeString(value.relativePath);
	const dependency: string | null = normalizeString(value.dependency);
	const purpose: string | null = normalizeString(value.purpose);
	if (
		url === null
		|| sourceFolderId === null
		|| relativePath === null
		|| dependency === null
		|| purpose === null
		|| !isAllowedDownloadUrl(url)
		|| !isDownloadCriticality(value.criticality)
	) {
		return null;
	}
	if (value.expectedSha256 !== undefined && normalizeSha256(value.expectedSha256) === undefined) {
		return null;
	}

	return {
		url,
		sourceFolderId,
		relativePath,
		dependency,
		purpose,
		criticality: value.criticality,
		expectedSha256: normalizeSha256(value.expectedSha256),
		overwrite: value.overwrite === true
	};
}

function stableDownloadPayload(request: DownloadRequest): string {
	return JSON.stringify({
		url: request.url,
		sourceFolderId: request.sourceFolderId,
		relativePath: request.relativePath.replaceAll("\\", "/"),
		expectedSha256: request.expectedSha256 ?? null,
		overwrite: request.overwrite
	});
}

export function createDownloadFingerprint(request: DownloadRequest): string {
	return createHash("sha256").update(stableDownloadPayload(request)).digest("hex");
}

export function getDownloadRequest(args: Record<string, unknown>): DownloadRequest | null {
	return parseDownloadRequest(args);
}

/**
 * An auto-safe approval can only cover the exact download entries explicitly
 * disclosed with the first request. New URL/path combinations need a new card.
 */
export function createDownloadAuthorizationScope(
	args: Record<string, unknown>,
	requestId: string | undefined,
	workspaceId?: string | undefined
): DownloadAuthorizationScope | undefined {
	if (requestId === undefined || requestId.length === 0) return undefined;
	const current: DownloadRequest | null = getDownloadRequest(args);
	if (current === null) return undefined;
	const rawScope: unknown = args.downloadScope;
	const candidates: DownloadRequest[] = [];
	if (Array.isArray(rawScope)) {
		for (const entry of rawScope) {
			const parsed: DownloadRequest | null = parseDownloadRequest(entry as DownloadScopeEntry);
			if (parsed === null) {
				return undefined;
			}
			candidates.push(parsed);
		}
	}
	const byFingerprint: Map<string, DownloadRequest> = new Map();
	for (const candidate of [...candidates, current]) {
		byFingerprint.set(createDownloadFingerprint(candidate), candidate);
	}
	const currentFingerprint: string = createDownloadFingerprint(current);
	if (!byFingerprint.has(currentFingerprint)) return undefined;
	const downloads: DownloadRequest[] = [...byFingerprint.values()];
	return {
		kind: "network_download",
		requestId,
		workspaceId,
		fingerprints: downloads.map(createDownloadFingerprint).sort(),
		downloads
	};
}

export function createNetworkAccessRequired(
	request: DownloadRequest,
	workspaceId: string
): NetworkAccessRequired {
	return {
		code: "network_access_required",
		category: "policy",
		dependency: request.dependency,
		purpose: request.purpose,
		criticality: request.criticality,
		target: {
			workspaceId,
			sourceFolderId: request.sourceFolderId,
			relativePath: request.relativePath.replaceAll("\\", "/")
		},
		execution: "download_only",
		approvalRequired: true
	};
}

export function isDownloadAuthorizationScope(value: unknown): value is DownloadAuthorizationScope {
	if (!isRecord(value) || value.kind !== "network_download" || typeof value.requestId !== "string" || !Array.isArray(value.fingerprints) || !Array.isArray(value.downloads)) {
		return false;
	}
	return value.fingerprints.every((fingerprint: unknown): boolean => typeof fingerprint === "string" && /^[a-f0-9]{64}$/u.test(fingerprint))
		&& value.downloads.every((download: unknown): boolean => parseDownloadRequest(download) !== null);
}

/**
 * Detect only explicit downloader executables in a shell command. This is a
 * command-syntax guard, not a natural-language classifier.
 */
export function isTerminalDownloadCommand(args: Record<string, unknown>): boolean {
	if (typeof args.commandLine !== "string") return false;
	return args.commandLine
		.split(/[;|&]/u)
		.some((segment: string): boolean => /^\s*(?:&\s*)?(?:curl(?:\.exe)?|wget(?:\.exe)?|invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer)\b/iu.test(segment));
}
