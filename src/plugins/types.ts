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

export type PluginRuntimeStatus = "stopped" | "starting" | "ready" | "failed" | "disabled";

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
	status: PluginRuntimeStatus;
	activeSessions: number;
	registeredTools: number;
	registeredSkills: number;
	registeredHooks: number;
	registeredMcpServers: number;
	dependencyStatus: PluginDependencyStatus;
	lastError?: string | undefined;
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
	nativePlugin?: NativePluginDeclaration | undefined;
	dependencyLockHash?: string | undefined;
	runtime?: PluginRuntimeSnapshot | undefined;
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
	nativePlugin?: NativePluginDeclaration | undefined;
	dependencyLockHash?: string | undefined;
	packageRoot?: string | undefined;
};

export type PluginCatalogResult = {
	plugins: PluginRecord[];
	profiles: PluginProfile[];
	activeProfile: PluginProfile;
};
