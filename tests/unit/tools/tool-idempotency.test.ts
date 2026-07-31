import assert from "node:assert/strict";
import test from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import {
	collectGodotRefreshPaths,
	executeLlmToolWithIdempotency,
	getLlmToolExecutionIdentity,
	refreshEditorFilesystemAfterGodotMutation,
	shouldDedupeLlmToolExecution
} from "../../../src/tools/tool-idempotency.js";

test("only write and destructive tools are deduplicated", (): void => {
	assert.equal(shouldDedupeLlmToolExecution("mcp_godot_read_text_file"), false);
	assert.equal(shouldDedupeLlmToolExecution("mcp_terminal_run_safe_preset"), false);
	assert.equal(shouldDedupeLlmToolExecution("mcp_godot_propose_create_text_file"), false);
	assert.equal(shouldDedupeLlmToolExecution("mcp_godot_create_text_file"), true);
	assert.equal(shouldDedupeLlmToolExecution("mcp_godot_delete_file"), true);
	assert.equal(shouldDedupeLlmToolExecution("mcp_custom_server_tool_12345678"), true);
});

test("tool execution fingerprints are stable across argument key order", (): void => {
	const left = getLlmToolExecutionIdentity(
		"mcp_godot_create_text_file",
		{ relativePath: "scripts/player.gd", content: "extends Node\n", nested: { b: 2, a: 1 } },
		"workspace:alpha"
	);
	const right = getLlmToolExecutionIdentity(
		"mcp_godot_create_text_file",
		{ nested: { a: 1, b: 2 }, content: "extends Node\n", relativePath: "scripts/player.gd" },
		"workspace:alpha"
	);

	assert.notEqual(left, undefined);
	assert.deepEqual(left, right);
});

test("tool execution fingerprints include workspace scope", (): void => {
	const args: Record<string, unknown> = {
		relativePath: "scripts/player.gd",
		content: "extends Node\n"
	};
	const alpha = getLlmToolExecutionIdentity("mcp_godot_create_text_file", args, "workspace:alpha");
	const beta = getLlmToolExecutionIdentity("mcp_godot_create_text_file", args, "workspace:beta");

	assert.notEqual(alpha, undefined);
	assert.notEqual(beta, undefined);
	assert.notEqual(alpha?.fingerprint, beta?.fingerprint);
	assert.equal(alpha?.argsHash, beta?.argsHash);
});

test("approval reason does not affect execution fingerprints", (): void => {
	const baseArgs: Record<string, unknown> = {
		relativePath: "scripts/player.gd",
		content: "extends Node\n"
	};
	const argsWithReason: Record<string, unknown> = {
		...baseArgs,
		approvalReason: "Create the script file so the approval UI can explain the change."
	};

	const base = getLlmToolExecutionIdentity("mcp_godot_create_text_file", baseArgs, "workspace:alpha");
	const withReason = getLlmToolExecutionIdentity("mcp_godot_create_text_file", argsWithReason, "workspace:alpha");

	assert.notEqual(base, undefined);
	assert.deepEqual(withReason, base);
});

test("read tools do not produce execution identities", (): void => {
	assert.equal(getLlmToolExecutionIdentity("mcp_godot_read_text_file", { relativePath: "project.godot" }), undefined);
});

test("scene view results can remain intact until the visual enricher consumes them", async (): Promise<void> => {
	const dataUrl: string = `data:image/png;base64,${"a".repeat(16_000)}`;
	const content: string = JSON.stringify({
		ok: true,
		result: {
			mimeType: "image/png",
			dataUrl,
			byteSize: 12_000
		}
	});
	const mcpHost = {
		getActiveWorkspaceId: (): undefined => undefined,
		callTool: async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => ({
			content: [{ type: "text", text: content }]
		})
	} as unknown as McpHost;

	const trimmed = await executeLlmToolWithIdempotency(
		mcpHost,
		"mcp_godot_editor_capture_scene_view",
		{}
	);
	const preserved = await executeLlmToolWithIdempotency(
		mcpHost,
		"mcp_godot_editor_capture_scene_view",
		{},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		true
	);

	assert.equal(trimmed.truncated, true);
	assert.equal(trimmed.content.includes(dataUrl), false);
	assert.equal(preserved.truncated, true);
	assert.equal(preserved.content, content);
});

test("project setting mutations refresh project.godot", (): void => {
	assert.deepEqual(
		collectGodotRefreshPaths("mcp_godot_set_project_setting", {
			key: "application/config/name",
			valueExpression: "\"Daedalus\""
		}),
		["project.godot"]
	);
	assert.deepEqual(
		collectGodotRefreshPaths("mcp_godot_unset_project_setting", {
			key: "application/config/name"
		}),
		["project.godot"]
	);
	assert.deepEqual(
		collectGodotRefreshPaths("mcp_godot_set_input_action", {
			action: "jump",
			events: []
		}),
		["project.godot"]
	);
	assert.deepEqual(
		collectGodotRefreshPaths("mcp_godot_unset_autoload", {
			name: "GameState"
		}),
		["project.godot"]
	);
});

test("workspace file mutations collect Godot editor refresh paths", (): void => {
	assert.deepEqual(
		collectGodotRefreshPaths("mcp_workspace_create_text_file", {
			relativePath: "scripts/player.gd",
			content: "extends Node\n"
		}),
		["scripts/player.gd"]
	);
	assert.deepEqual(
		collectGodotRefreshPaths("mcp_workspace_replace_line_in_file", {
			relativePath: "scenes/main.tscn",
			lineNumber: 12,
			expectedText: "[node name=\"Main\" type=\"Node\"]",
			newText: "[node name=\"Main\" type=\"Node2D\"]"
		}),
		["scenes/main.tscn"]
	);
});

test("Godot mutation refresh waits for an editor acknowledgement", async (): Promise<void> => {
	let acknowledge: ((value: unknown[]) => void) | undefined;
	const acknowledgement = new Promise<unknown[]>((resolve): void => {
		acknowledge = resolve;
	});
	const mcpHost = {
		getEditorBridge: (): { refreshFilesystem: () => Promise<unknown[]> } => ({
			refreshFilesystem: async (): Promise<unknown[]> => acknowledgement
		})
	} as unknown as McpHost;

	let completed: boolean = false;
	const refresh = refreshEditorFilesystemAfterGodotMutation(
		mcpHost,
		"mcp_godot_overwrite_text_file",
		{ relativePath: "scenes/main.tscn" }
	).then((outcome) => {
		completed = true;
		return outcome;
	});

	await Promise.resolve();
	assert.equal(completed, false);
	acknowledge?.([{ ok: true }]);
	assert.deepEqual(await refresh, {
		status: "confirmed",
		changedPaths: ["scenes/main.tscn"],
		editorCount: 1
	});
});

test("Godot mutation refresh reports unavailable and failed editor notifications", async (): Promise<void> => {
	const unavailableHost = {
		getEditorBridge: (): { refreshFilesystem: () => Promise<null> } => ({
			refreshFilesystem: async (): Promise<null> => null
		})
	} as unknown as McpHost;
	const failedHost = {
		getEditorBridge: (): { refreshFilesystem: () => Promise<never> } => ({
			refreshFilesystem: async (): Promise<never> => {
				throw new Error("editor disconnected");
			}
		})
	} as unknown as McpHost;

	assert.equal((await refreshEditorFilesystemAfterGodotMutation(
		unavailableHost,
		"mcp_godot_create_text_file",
		{ relativePath: "scripts/player.gd" }
	)).status, "editor_unavailable");
	assert.equal((await refreshEditorFilesystemAfterGodotMutation(
		failedHost,
		"mcp_godot_create_text_file",
		{ relativePath: "scripts/player.gd" }
	)).status, "failed");
});
