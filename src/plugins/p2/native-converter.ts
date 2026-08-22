import type { PluginRecord } from "../types.js";

export type NativeConversionReport = {
	pluginId: string;
	converted: boolean;
	activationReady: boolean;
	runtime: "native" | "harness";
	tools: number;
	skills: number;
	hooks: number;
	mcp: number;
	warnings: string[];
	skippedRows: Array<{ index: number; reason: string }>;
	fingerprint: string;
};

export function createNativeConversionReport(record: PluginRecord): NativeConversionReport {
	const summary = record.harnessBundle;
	const warnings: string[] = [...(summary?.warnings ?? [])];
	const skippedRows = summary?.skippedRows.map((row): { index: number; reason: string } => ({ index: row.index, reason: row.reason })) ?? [];
	const converted = record.nativePlugin !== undefined || (summary !== undefined && summary.totalRows === summary.bridgeableRows && summary.dangerousConstructs.length === 0);
	const activationReady = record.nativePlugin !== undefined && converted;
	if (!converted && summary !== undefined) warnings.push("This Bundle contains rows that cannot be converted to the Native API.");
	if (converted && !activationReady) warnings.push("Static conversion is available, but runtime activation still requires a trusted Native entry module.");
	return {
		pluginId: record.id,
		converted,
		activationReady,
		runtime: converted ? "native" : "harness",
		tools: record.p2?.declarations.commands?.length ?? 0,
		skills: record.p2?.declarations.contextProviders?.length ?? 0,
		hooks: 0,
		mcp: 0,
		warnings,
		skippedRows,
		fingerprint: record.fingerprint
	};
}
