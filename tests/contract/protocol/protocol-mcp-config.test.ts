import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../../../src/protocol/schema.js";

test("mcp.config.update schema accepts stdio and http updates", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-stdio",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			description: "Updated",
			transport: "stdio",
			enabled: true,
			planAccess: "read",
			command: "npx",
			args: ["-y", "demo"],
			env: {
				TOKEN: "",
				NEW_TOKEN: "new-value",
				OPTIONAL: null
			}
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-http",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			transport: "http",
			planAccess: "disabled",
			url: "https://example.com/mcp",
			headers: {
				Authorization: ""
			}
		}
	}).success, true);
});

test("mcp.config.add schema accepts plan-safe custom MCP access", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-add-plan-safe",
		method: "mcp.config.add",
		params: {
			name: "context7",
			transport: "stdio",
			planAccess: "read",
			command: "npx",
			args: ["-y", "@upstash/context7-mcp"]
		}
	}).success, true);
});

test("mcp.config.update schema rejects invalid update payloads", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-missing-id",
		method: "mcp.config.update",
		params: {
			transport: "stdio",
			command: "npx"
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-bad-url",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			transport: "http",
			url: "not-a-url"
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-rename",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			name: "Renamed",
			transport: "stdio",
			command: "npx"
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-bad-plan-access",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			transport: "stdio",
			planAccess: "write",
			command: "npx"
		}
	}).success, false);
});

test("provider.config.set schema accepts task model routing", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "provider-current",
		method: "provider.current.get",
		params: {}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "provider-model-selection",
		method: "provider.modelSelection.get",
		params: {}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "provider-routing",
		method: "provider.config.set",
		params: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			baseUrl: "https://proxy.example/v1",
			modelRouting: {
				imageRecognition: { provider: "moonshot", model: "kimi-k2.6" },
				workflowPlanner: { provider: "deepseek", model: "deepseek-v4-pro" },
				sessionTitle: null,
				gitCommit: { provider: "deepseek", model: "deepseek-v4-pro" }
			}
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "provider-routing-format-bad-provider",
		method: "provider.config.set",
		params: {
			provider: "DeepSeek",
			modelRouting: {
				imageRecognition: { provider: "unknown provider", model: "vision" }
			}
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "provider-routing-clear-base-url",
		method: "provider.config.set",
		params: {
			provider: "deepseek",
			baseUrl: null
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "provider-routing-clear-api-key",
		method: "provider.config.set",
		params: {
			provider: "deepseek",
			apiKey: null
		}
	}).success, true);
});

test("session create and save schema accept frontend session metadata", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-create-metadata",
		method: "session.create",
		params: {
			title: "Session with UI state",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			chatMode: "agent"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-create-no-workspace",
		method: "session.create",
		params: {
			title: "No workspace session",
			workspaceId: null
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-save-metadata",
		method: "session.save",
		params: {
			provider: "moonshot",
			model: "kimi-k2.7-code",
			chatMode: "plan",
			workflowTodoCollapsed: true
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-model-set",
		method: "session.model.set",
		params: {
			provider: "minimax",
			model: "MiniMax-M3"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-save-bad-mode",
		method: "session.save",
		params: {
			chatMode: "code"
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-save-approval-mode",
		method: "session.save",
		params: {
			approvalMode: "auto-safe"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-pin-set",
		method: "session.pin.set",
		params: {
			sessionId: "session-20260726-pinned",
			pinned: true
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-pin-set-invalid",
		method: "session.pin.set",
		params: {
			sessionId: "session-20260726-pinned"
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "session-save-bad-approval-mode",
		method: "session.save",
		params: {
			approvalMode: "always"
		}
	}).success, false);
});

test("user prompt schema accepts backend singleton prompt updates", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "user-prompt-get",
		method: "userPrompt.get",
		params: {}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "user-prompt-set",
		method: "userPrompt.set",
		params: {
			prompt: "请优先用中文回答。"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "user-prompt-set-git",
		method: "userPrompt.set",
		params: {
			gitCommitPrompt: "提交信息标题使用英文动词开头。"
		}
	}).success, true);
});
