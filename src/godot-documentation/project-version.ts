import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectSettings } from "../mcp/godot/tools/project-settings-document.js";

export function parseGodotProjectFeatureVersion(content: string): string | undefined {
	const document = parseProjectSettings(content);
	const features = document.entries.find((entry): boolean => {
		return entry.fullKey === "application/config/features" || entry.fullKey === "config/features";
	});
	return features?.valueExpression.match(/"(\d+\.\d+)"/u)?.[1];
}

export async function readGodotProjectFeatureVersion(rootPath: string): Promise<string | undefined> {
	try {
		return parseGodotProjectFeatureVersion(await readFile(join(rootPath, "project.godot"), "utf8"));
	} catch {
		return undefined;
	}
}
