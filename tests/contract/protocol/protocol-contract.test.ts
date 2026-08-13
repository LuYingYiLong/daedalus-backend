import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import { REQUEST_HANDLER_METHODS, REQUEST_HANDLERS } from "../../../src/server/request-dispatcher.js";

const configuredPluginDir: string | undefined = process.env.DAEDALUS_EDITOR_BRIDGE_DIR;
const pluginDir: string = configuredPluginDir ?? "D:/GodotProjects/example/addons/daedalus_editor_bridge";
const bridgeRuntimePaths: string[] = [
	path.join(pluginDir, "scripts", "bridge_runtime.gd"),
	path.join(pluginDir, "scripts", "editor_context.gd")
];
const frontendRpcSkipReason: string | undefined = configuredPluginDir === undefined && bridgeRuntimePaths.some((filePath: string): boolean => !existsSync(filePath))
	? `Daedalus Editor Bridge sources not found at ${pluginDir}; set DAEDALUS_EDITOR_BRIDGE_DIR to enable this external contract test.`
	: undefined;
const BACKEND_ONLY_OR_STUDIO_RPC_METHODS: Set<string> = new Set([
	"attachment.image.generated.get",
	"attachment.image.get",
	"attachment.text.save",
	"attachment.text.get",
	"backend.shutdown",
	"backend.update.check",
	"backend.update.install",
	"agent.goal.current",
	"agent.goal.pause",
	"agent.goal.resume",
	"agent.goal.cancel",
	"agent.goal.dismiss",
	"agent.goal.extendBudget",
	"agent.goal.rollback.preview",
	"agent.goal.rollback.apply",
	"generalSettings.get",
	"generalSettings.update",
	"godotDocumentation.branches.list",
	"godotDocumentation.get",
	"godotDocumentation.health.check",
	"godotDocumentation.importLocal",
	"godotDocumentation.install",
	"godotDocumentation.job.cancel",
	"godotDocumentation.job.get",
	"godotDocumentation.remove",
	"godotDocumentation.repair",
	"godotDocumentation.setEnabled",
	"godotDocumentation.update",
	"provider.custom.add",
	"provider.usage.get",
	"provider.setEnabled",
	"provider.custom.remove",
	"provider.model.add",
	"provider.model.update",
	"provider.models.discover",
	"provider.models.import",
	"provider.models.sync",
	"ai.toolBudget.continue",
	"ai.toolBudget.stop",
	"message.queue.reorder",
	"session.context.estimate",
	"session.export",
	"session.fork",
	"session.import",
	"session.timeline.search.index",
	"session.timeline.search.start",
	"session.timeline.search.page",
	"session.timeline.search.cancel",
	"session.timeline.index",
	"session.guide.reorder",
	"session.integrity.check",
	"session.model.set",
	"session.pin.set",
	"session.selectionAsk.cancel",
	"session.selectionAsk.create",
	"session.selectionAsk.delete",
	"session.selectionAsk.deleteAll",
	"session.selectionAsk.get",
	"session.selectionAsk.list",
	"session.selectionAsk.send",
	"session.overview.get",
	"session.workflow.todo.dismiss",
	"skill.install",
	"webSearchSettings.get",
	"webSearchSettings.update",
	"usage.metrics.summary.get",
	"usage.metrics.logs.list",
	"usage.metrics.trends.get",
	"workspace.delete",
	"workspace.update",
	"workspace.tree.order.get",
	"workspace.tree.order.update",
	"workspace.git.diff.get",
	"workspace.git.diff.summary.get",
	"workspace.git.diff.file.get",
	"workspace.git.commit.message.generate",
	"workspace.git.commitOrPush",
	"workspace.git.branches.list",
	"workspace.git.branch.checkout",
	"workspace.git.branch.create"
]);

function unique(values: string[]): string[] {
	return Array.from(new Set(values)).sort();
}

function difference(left: string[], right: string[]): string[] {
	const rightSet: Set<string> = new Set(right);
	return left.filter((value: string): boolean => !rightSet.has(value)).sort();
}

async function readBackendSchemaMethods(): Promise<string[]> {
	const schemaPath: string = path.resolve("src/protocol/schema.ts");
	const source: string = await fs.readFile(schemaPath, "utf8");
	return unique([...source.matchAll(/method:\s*z\.literal\("([^"]+)"\)/g)].map((match: RegExpMatchArray): string => match[1]!));
}

async function readFrontendRpcMethods(): Promise<string[]> {
	for (const filePath of bridgeRuntimePaths) {
		assert.ok(existsSync(filePath), `Daedalus Editor Bridge source not found at ${filePath}`);
	}
	const source: string = (await Promise.all(bridgeRuntimePaths.map(async (filePath: string): Promise<string> => await fs.readFile(filePath, "utf8")))).join("\n");
	const bridgeMethods: string[] = ["client.hello", "editor.context.update", "editor.heartbeat", "editor.tool.result"];
	return bridgeMethods.filter((method: string): boolean => source.includes(`"${method}"`));
}

test("backend protocol schema and WebSocket dispatcher stay in sync", async (): Promise<void> => {
	const schemaMethods: string[] = await readBackendSchemaMethods();
	const dispatcherMethods: string[] = unique([...REQUEST_HANDLER_METHODS]);

	assert.deepEqual(difference(schemaMethods, dispatcherMethods), [], "schema methods missing dispatcher handler");
	assert.deepEqual(difference(dispatcherMethods, schemaMethods), [], "dispatcher handlers missing schema method");
	for (const method of dispatcherMethods) {
		assert.equal(typeof REQUEST_HANDLERS.get(method as never), "function", `dispatcher handler missing implementation: ${method}`);
	}
	assert.ok(new Set([...REQUEST_HANDLERS.values()]).size > 1, "dispatcher must use domain-specific handlers");
});

test("Editor Bridge RPC surface is minimal and covered by the backend schema", { skip: frontendRpcSkipReason }, async (): Promise<void> => {
	const schemaMethods: string[] = await readBackendSchemaMethods();
	const frontendMethods: string[] = await readFrontendRpcMethods();
	assert.deepEqual(frontendMethods, ["client.hello", "editor.context.update", "editor.heartbeat", "editor.tool.result"]);
	assert.deepEqual(difference(frontendMethods, schemaMethods), [], "Bridge RPC methods missing from backend schema");
	assert.equal(frontendMethods.some((method: string): boolean => BACKEND_ONLY_OR_STUDIO_RPC_METHODS.has(method)), false);
});

test("session.timeline accepts omitted beforeOffset as latest page request", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-latest",
		method: "session.timeline",
		params: {
			sessionId: "session-test",
			limit: 20
		}
	}).success, true);
});

test("session.timeline accepts afterOffset page request", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-after",
		method: "session.timeline",
		params: {
			sessionId: "session-test",
			afterOffset: 80,
			limit: 20
		}
	}).success, true);
});

test("session.integrity.check accepts session id", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-integrity-check",
		method: "session.integrity.check",
		params: {
			sessionId: "session-test"
		}
	}).success, true);
});

test("workspace.delete accepts workspace id", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-delete",
		method: "workspace.delete",
		params: {
			workspaceId: "workspace-a"
		}
	}).success, true);
});

test("Godot documentation local import requires a branch and absolute-source candidate", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "godot-docs-import-local",
		method: "godotDocumentation.importLocal",
		params: {
			branch: "4.7",
			sourcePath: "C:\\Downloads\\godot-docs-4.7.zip"
		}
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "godot-docs-import-local-invalid",
		method: "godotDocumentation.importLocal",
		params: {
			branch: "4.7",
			sourcePath: ""
		}
	}).success, false);
});

test("Godot documentation health and repair requests require explicit targets and network consent", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "godot-docs-health",
		method: "godotDocumentation.health.check",
		params: { documentId: "godot-docs-47", deep: true }
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "godot-docs-repair",
		method: "godotDocumentation.repair",
		params: { documentId: "godot-docs-47", allowNetwork: false }
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "godot-docs-repair-invalid",
		method: "godotDocumentation.repair",
		params: { documentId: "godot-docs-47" }
	}).success, false);
});

test("workspace tree order accepts a complete unique order snapshot", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-tree-order",
		method: "workspace.tree.order.update",
		params: {
			workspaceIds: ["workspace-b", "workspace-a"],
			sessionIdsByWorkspace: {
				"workspace-a": ["session-a-2", "session-a-1"],
				"workspace-b": ["session-b-1"]
			},
			pinnedSessionIds: ["session-pinned"],
			recentSessionIds: ["session-recent"],
			expandedSectionKeys: ["pinned", "projects"],
			expandedWorkspaceIds: ["workspace-b"]
		}
	}).success, true);
});

test("session.timeline.search.index accepts a paged Studio search request", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-search-index",
		method: "session.timeline.search.index",
		params: {
			sessionId: "session-test",
			afterOffset: 120,
			limit: 500
		}
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-search-index-invalid",
		method: "session.timeline.search.index",
		params: {
			sessionId: "session-test",
			limit: 501
		}
	}).success, false);
});

test("session timeline search lifecycle validates start, page and cancel requests", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-search-start",
		method: "session.timeline.search.start",
		params: { sessionId: "session-test" }
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-search-page",
		method: "session.timeline.search.page",
		params: { searchId: "search-1", afterOffset: 400, limit: 500 }
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-search-cancel",
		method: "session.timeline.search.cancel",
		params: { searchId: "search-1" }
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-search-page-invalid",
		method: "session.timeline.search.page",
		params: { searchId: "search-1", limit: 501 }
	}).success, false);
});

test("workspace tree order rejects duplicate session ids across workspaces", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-tree-order-duplicate",
		method: "workspace.tree.order.update",
		params: {
			workspaceIds: ["workspace-a", "workspace-b"],
			sessionIdsByWorkspace: {
				"workspace-a": ["session-shared"],
				"workspace-b": ["session-shared"]
			},
			pinnedSessionIds: [],
			recentSessionIds: [],
			expandedSectionKeys: ["pinned", "projects", "recent"],
			expandedWorkspaceIds: ["workspace-a"]
		}
	}).success, false);
});

test("session.timeline.index accepts a session id", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-index",
		method: "session.timeline.index",
		params: { sessionId: "session-test" }
	}).success, true);
});

test("workspace.update accepts a multi-root project configuration", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-update",
		method: "workspace.update",
		params: {
			workspaceId: "workspace-a",
			name: "Gameplay",
			icon: 5,
			color: 4,
			sourceFolders: [
				{ id: "game", path: "D:/Projects/game" },
				{ id: "tools", path: "D:/Projects/tools" }
			],
			primarySourceFolderId: "game"
		}
	}).success, true);
});

test("workspace.git.diff.get accepts workspace id", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-git-diff",
		method: "workspace.git.diff.get",
		params: {
			workspaceId: "workspace-a",
			sourceFolderId: "tools"
		}
	}).success, true);
});

test("workspace git commit requests are accepted", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-git-commit-message",
		method: "workspace.git.commit.message.generate",
		params: {
			workspaceId: "workspace-a",
			includeUnstagedChanges: true,
			provider: "deepseek",
			model: "deepseek-v4-pro"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-git-commit-push",
		method: "workspace.git.commitOrPush",
		params: {
			workspaceId: "workspace-a",
			action: "commit_and_push",
			message: "Add local tic-tac-toe",
			includeUnstagedChanges: true
		}
	}).success, true);
});

test("workspace git diff summary and file requests are accepted", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-git-diff-summary",
		method: "workspace.git.diff.summary.get",
		params: { workspaceId: "workspace-a", cursor: 0, limit: 100 }
	}).success, true);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-git-diff-file",
		method: "workspace.git.diff.file.get",
		params: { workspaceId: "workspace-a", path: "scripts/player.gd" }
	}).success, true);
});

test("workspace git branch requests are accepted", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-git-branches-list",
		method: "workspace.git.branches.list",
		params: {
			workspaceId: "workspace-a"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-git-branch-checkout",
		method: "workspace.git.branch.checkout",
		params: {
			workspaceId: "workspace-a",
			branchName: "feature/dialog"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-git-branch-create",
		method: "workspace.git.branch.create",
		params: {
			workspaceId: "workspace-a",
			branchName: "feature/dialog",
			startPoint: "main"
		}
	}).success, true);
});

test("tool budget decision requests are accepted", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "tool-budget-continue",
		method: "ai.toolBudget.continue",
		params: {
			budgetId: "tool-budget-a"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "tool-budget-stop",
		method: "ai.toolBudget.stop",
		params: {
			budgetId: "tool-budget-a"
		}
	}).success, true);
});

test("queued message requests accept send snapshots and reorder", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "message-queue-add",
		method: "message.queue.add",
		params: {
			text: "排队修复 useDiskSpaceCheck",
			mode: "agent",
			provider: "moonshot",
			model: "kimi-k3",
			skillRefs: ["builtin:backend-helper"],
			additionalContext: [
				{
					id: "ctx-a",
					kind: "file",
					title: "useDiskSpaceCheck.ts",
					source: "manual",
					resourcePath: "src/renderer/src/hooks/useDiskSpaceCheck.ts"
				}
			]
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "message-queue-reorder",
		method: "message.queue.reorder",
		params: {
			queueIds: [2, 1]
		}
	}).success, true);
});

test("pending guide requests accept reorder", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "guide-reorder",
		method: "session.guide.reorder",
		params: {
			guideIds: ["guide-a", "guide-b"]
		}
	}).success, true);
});

test("ai chat accepts queued run identity", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "queued-ai-chat",
		method: "ai.chat",
		params: {
			message: "执行队列消息",
			mode: "agent",
			options: {
				stream: true,
				queueItemId: 7
			}
		}
	}).success, true);
});

test("backend update requests are accepted", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "backend-update-check",
		method: "backend.update.check"
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "backend-update-install",
		method: "backend.update.install",
		params: {
			version: "1.0.9"
		}
	}).success, true);
});

test("usage metrics requests are accepted", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "usage-summary",
		method: "usage.metrics.summary.get",
		params: {
			provider: "deepseek",
			model: "deepseek-v4-pro",
			sessionId: "session-a",
			workspaceId: "workspace-a",
			operation: "workflow_phase",
			status: "success",
			usageSource: "provider"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "usage-logs",
		method: "usage.metrics.logs.list",
		params: {
			limit: 50,
			offset: 0,
			startAt: "2026-07-21T00:00:00.000Z",
			endAt: "2026-07-22T00:00:00.000Z"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "usage-trends",
		method: "usage.metrics.trends.get",
		params: {
			bucket: "hour",
			provider: "moonshot"
		}
	}).success, true);
});

test("session.workflow.todo.dismiss accepts optional workflow identity", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "todo-dismiss",
		method: "session.workflow.todo.dismiss",
		params: {
			workflowId: "workflow-a",
			runId: "workflow-run-a"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "todo-dismiss-empty",
		method: "session.workflow.todo.dismiss"
	}).success, true);
});

test("session.overview.get accepts session overview limits", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-overview",
		method: "session.overview.get",
		params: {
			sessionId: "session-test",
			planLimit: 3,
			sourceLimit: 10,
			includePlanPreviews: false,
			includeSourceImages: false
		}
	}).success, true);
});

test("general settings update accepts next-step hint preference", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "general-settings-update",
		method: "generalSettings.update",
		params: {
			nextStepHintsEnabled: false
		}
	}).success, true);
});

test("web search settings get and update are accepted", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "web-search-settings-get",
		method: "webSearchSettings.get"
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "web-search-settings-update",
		method: "webSearchSettings.update",
		params: {
			enabled: true,
			provider: "zhipu",
			model: "glm-5.2",
			maxKeywords: 3
		}
	}).success, true);
});
