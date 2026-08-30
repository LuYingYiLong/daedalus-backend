import type { PluginP2Manifest } from "./extensions/protocol.js";

export const PLUGIN_TRUST_STATUSES = ["review_required", "trusted", "disabled"] as const;
export type PluginTrustStatus = typeof PLUGIN_TRUST_STATUSES[number];

export type PluginSource =
	| { type: "local"; path: string }
	| { type: "npm"; packageName: string; version: string }
	| { type: "git"; url: string; commit: string }
	| { type: "tarball"; path: string; sha256: string };

export type PluginCompatibility = {
	daedalus: "native" | "unknown";
	harnessBundle: boolean;
	harnessClient: boolean;
	patchPath?: string | undefined;
	patchExists: boolean;
	entryPaths: string[];
	unsupportedFeatures: string[];
	warnings: string[];
	classification: "native" | "harness-bundle" | "harness-client" | "both" | "metadata-only" | "unsupported";
};

export const PLUGIN_CAPABILITIES = ["tools", "skills", "hooks", "mcp"] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

export type NativePluginDeclaration = {
	apiVersion: number;
	entry: string;
	capabilities: PluginCapability[];
};

export type PluginPresentation = {
	description?: string | undefined;
	readme?: string | undefined;
	changelog?: string | undefined;
	iconDataUrl?: string | undefined;
};

export type PluginIsolationState = {
	status: "none" | "quarantined";
	reason?: string | undefined;
	failureCount: number;
	windowStartedAt?: string | undefined;
	lastFailureAt?: string | undefined;
	updatedAt: string;
};

export type PluginResourceUsage = {
	activeCalls: number;
	pendingCalls: number;
	rssBytes?: number | undefined;
	lastMeasuredAt?: string | undefined;
};

export type PluginRuntimeStatus = "stopped" | "starting" | "ready" | "failed" | "disabled" | "quarantined";

export type PluginRuntimeKind = "native" | "harness";

export type HarnessRuntimeStatus =
	| "unconfigured"
	| "detected"
	| "needs_setup"
	| "ready"
	| "running"
	| "failed"
	| "disabled";

export type HarnessSkippedRow = {
	index: number;
	id?: string | undefined;
	name?: string | undefined;
	reason: string;
};

export type HarnessBundleSummary = {
	patchPath?: string | undefined;
	totalRows: number;
	bridgeableRows: number;
	skippedRows: HarnessSkippedRow[];
	operations: Array<"insert" | "replace" | "override">;
	warnings: string[];
	dangerousConstructs: string[];
	contentHash: string;
};

export type HarnessRuntimeConfig = {
	enabled: boolean;
	executablePath: string | null;
	sourceRoot: string | null;
	launchMode: "installed" | "source";
	bridgeProtocolVersion: number;
	network: "disabled";
	revision: string;
	updatedAt: string;
};

export type HarnessInstallation = {
	status: "unconfigured" | "detected" | "needs_setup" | "failed";
	launchMode: "installed" | "source";
	version?: string | undefined;
	command?: string | undefined;
	args: string[];
	readOnlyPaths: string[];
	bridgeProtocolVersion: number;
	bridgeCompatible: boolean;
	dependenciesReady: boolean;
	error?: string | undefined;
};

export type PluginDependencyStatus = "not_required" | "pending" | "ready" | "needs_network" | "failed";

export type PluginRuntimeLog = {
	id: string;
	pluginId: string;
	sessionId?: string | undefined;
	event: "start" | "ready" | "register" | "invoke" | "stop" | "error" | "dependency";
	status: "ok" | "failed" | "cancelled";
	message?: string | undefined;
	durationMs?: number | undefined;
	createdAt: string;
};

export type PluginRuntimeSnapshot = {
	pluginId: string;
	runtimeKind?: PluginRuntimeKind | undefined;
	status: PluginRuntimeStatus;
	activeSessions: number;
	registeredTools: number;
	registeredSkills: number;
	registeredHooks: number;
	registeredMcpServers: number;
	dependencyStatus: PluginDependencyStatus;
	harnessStatus?: HarnessRuntimeStatus | undefined;
	harnessVersion?: string | undefined;
	bridgeProtocolVersion?: number | undefined;
	bundleSummary?: HarnessBundleSummary | undefined;
	lastError?: string | undefined;
	isolation?: PluginIsolationState | undefined;
	resourceUsage?: PluginResourceUsage | undefined;
	lastExitCode?: number | null | undefined;
	updatedAt: string;
};

export type PluginRecord = {
	id: string;
	packageName: string;
	version: string;
	source: PluginSource;
	packageRoot: string;
	contentHash: string;
	manifestHash: string;
	fingerprint: string;
	compatibility: PluginCompatibility;
	trust: PluginTrustStatus;
	enabled: boolean;
	installedAt: string;
	updatedAt: string;
	lastError?: string | undefined;
	presentation?: PluginPresentation | undefined;
	nativePlugin?: NativePluginDeclaration | undefined;
	p2?: PluginP2Manifest | undefined;
	dependencyLockHash?: string | undefined;
	harnessBundle?: HarnessBundleSummary | undefined;
	harnessRuntimeFingerprint?: string | undefined;
	isolation?: PluginIsolationState | undefined;
	runtime?: PluginRuntimeSnapshot | undefined;
};

export type PluginVersionRecord = {
	fingerprint: string;
	packageRoot: string;
	packageName: string;
	version: string;
	contentHash: string;
	manifestHash: string;
	installedAt: string;
	updatedAt: string;
};

export type PluginProfile = {
	id: string;
	name: string;
	pluginIds: string[];
	active: boolean;
	updatedAt: string;
};

export type PluginPackageManifest = {
	name: string;
	version: string;
	description?: string | undefined;
	type?: string | undefined;
	main?: string | undefined;
	exports?: unknown;
	files?: unknown;
	engines?: unknown;
	dsh?: unknown;
	daedalus?: unknown;
};

export type PluginScanResult = {
	packageName: string;
	version: string;
	manifest: PluginPackageManifest;
	manifestHash: string;
	contentHash: string;
	compatibility: PluginCompatibility;
	presentation?: PluginPresentation | undefined;
	nativePlugin?: NativePluginDeclaration | undefined;
	p2?: PluginP2Manifest | undefined;
	dependencyLockHash?: string | undefined;
	harnessBundle?: HarnessBundleSummary | undefined;
	packageRoot?: string | undefined;
};

export type PluginCatalogResult = {
	plugins: PluginRecord[];
	profiles: PluginProfile[];
	activeProfile: PluginProfile;
};
