import type { PluginP2Manifest } from "./extensions/protocol.js";
import type { FlowNodeTypeDefinition } from "../protocol/types.js";

export const PLUGIN_TRUST_STATUSES = ["review_required", "trusted", "disabled"] as const;
export type PluginTrustStatus = typeof PLUGIN_TRUST_STATUSES[number];

export type PluginSource =
	| { type: "local"; path: string }
	| { type: "npm"; packageName: string; version: string }
	| { type: "git"; url: string; commit: string }
	| { type: "tarball"; path: string; sha256: string };

export type PluginCompatibility = {
	daedalus: "native" | "unknown";
	entryPaths: string[];
	unsupportedFeatures: string[];
	warnings: string[];
	classification: "native" | "metadata-only" | "unsupported";
};

export const PLUGIN_CAPABILITIES = ["tools", "skills", "hooks", "mcp", "flowNodes", "flowHostTools", "flowMedia", "flowTypedValues"] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

export type NativePluginDeclaration = {
	apiVersion: number;
	entry: string;
	capabilities: PluginCapability[];
	flowNodes?: NativeFlowNodeDeclaration[] | undefined;
};

export type NativeFlowNodeDeclaration = Omit<FlowNodeTypeDefinition, "pluginFingerprint"> & {
	handlerName: string;
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
	packageRoot?: string | undefined;
};

export type PluginCatalogResult = {
	plugins: PluginRecord[];
	profiles: PluginProfile[];
	activeProfile: PluginProfile;
};
