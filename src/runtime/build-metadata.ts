import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSea } from "node:sea";

declare const __DAEDALUS_BACKEND_VERSION__: string | undefined;
declare const __DAEDALUS_BUILD_ID__: string | undefined;
declare const __DAEDALUS_BUILD_NODE_VERSION__: string | undefined;
declare const __DAEDALUS_SEA_BUILD__: boolean | undefined;

export const BACKEND_PROTOCOL_VERSION: number = 3;

export type BackendDistribution = "sea" | "source";

export type BackendBuildMetadata = {
	version: string;
	buildId: string;
	buildNodeVersion: string;
	runtimeNodeVersion: string;
	distribution: BackendDistribution;
	platform: NodeJS.Platform;
	arch: string;
	protocolVersion: number;
};

function readInjectedValue(value: string | undefined): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSourcePackageVersion(): string {
	const envVersion: string | undefined = process.env.npm_package_version;
	if (envVersion !== undefined && envVersion.trim().length > 0) {
		return envVersion.trim();
	}

	try {
		const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
			version?: unknown;
		};
		return typeof manifest.version === "string" && manifest.version.trim().length > 0
			? manifest.version.trim()
			: "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export function getBackendBuildMetadata(): BackendBuildMetadata {
	const seaBuild: boolean =
		typeof __DAEDALUS_SEA_BUILD__ !== "undefined" && __DAEDALUS_SEA_BUILD__;
	const injectedVersion: string | null = readInjectedValue(
		typeof __DAEDALUS_BACKEND_VERSION__ === "undefined" ? undefined : __DAEDALUS_BACKEND_VERSION__
	);
	const injectedBuildId: string | null = readInjectedValue(
		typeof __DAEDALUS_BUILD_ID__ === "undefined" ? undefined : __DAEDALUS_BUILD_ID__
	);
	const injectedNodeVersion: string | null = readInjectedValue(
		typeof __DAEDALUS_BUILD_NODE_VERSION__ === "undefined" ? undefined : __DAEDALUS_BUILD_NODE_VERSION__
	);
	const version: string = seaBuild
		? injectedVersion ?? "0.0.0"
		: injectedVersion ?? readSourcePackageVersion();

	return {
		version,
		buildId: injectedBuildId ?? `source-${version}`,
		buildNodeVersion: injectedNodeVersion ?? process.versions.node,
		runtimeNodeVersion: process.versions.node,
		distribution: isSea() ? "sea" : "source",
		platform: process.platform,
		arch: process.arch,
		protocolVersion: BACKEND_PROTOCOL_VERSION
	};
}
