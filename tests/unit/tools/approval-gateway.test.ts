import assert from "node:assert/strict";
import test from "node:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";

const DOWNLOAD_ARGS: Record<string, unknown> = {
	url: "https://downloads.example.test/tools/example-tool.exe",
	sourceFolderId: "tools",
	relativePath: "bin/example-tool.exe",
	dependency: "example-tool",
	purpose: "Run the project verifier for this request.",
	criticality: "required",
	overwrite: false
};

test("an accepted approval returns a structured timeout failure instead of throwing", async (): Promise<void> => {
	const gateway = new ApprovalGateway("manual");
	const pending = gateway.requestApproval(
		"mcp_workspace_read_text_file",
		{ relativePath: "README.md" },
		"tool-call-1",
		"test approval",
		"workspace-test"
	);
	const mcpHost = {
		getActiveWorkspaceId: (): string => "workspace-test",
		callTool: async (): Promise<never> => {
			throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
		}
	} as unknown as McpHost;

	const result = await gateway.approve(pending.approvalId, mcpHost);
	const content = JSON.parse(result.content) as { failure?: { code?: unknown; category?: unknown } };
	assert.equal(content.failure?.code, "mcp_request_timeout");
	assert.equal(content.failure?.category, "environment");
	assert.equal(gateway.getPending(pending.approvalId), undefined);
	assert.equal(gateway.listPending().length, 0);
});

test("manual downloads always require a new explicit approval", async (): Promise<void> => {
	const gateway = new ApprovalGateway("manual");
	const first = await gateway.evaluate("mcp_workspace_download_file", DOWNLOAD_ARGS, "download-1", "workspace-a", {
		requestId: "request-a"
	});
	assert.equal(first.action, "request_approval");
	if (first.action !== "request_approval") return;
	assert.equal(first.approvalKind, "network_download");

	gateway.grantDownloadAuthorization(first.downloadAuthorization);
	const repeated = await gateway.evaluate("mcp_workspace_download_file", DOWNLOAD_ARGS, "download-2", "workspace-a", {
		requestId: "request-a"
	});
	assert.equal(repeated.action, "request_approval");
});

test("download authorization rejects malformed, insecure, or credentialed URLs before approval", async (): Promise<void> => {
	const gateway = new ApprovalGateway("manual");
	for (const url of ["http://downloads.example.test/tool.bin", "https://token@example.test/tool.bin", "not-a-url"]) {
		const decision = await gateway.evaluate("mcp_workspace_download_file", {
			...DOWNLOAD_ARGS,
			url
		}, "download-invalid", "workspace-a", { requestId: "request-a" });
		assert.equal(decision.action, "deny");
	}
});

test("auto-safe download authorization only matches the approved request fingerprint", async (): Promise<void> => {
	const gateway = new ApprovalGateway("auto-safe");
	const first = await gateway.evaluate("mcp_workspace_download_file", DOWNLOAD_ARGS, "download-1", "workspace-a", {
		requestId: "request-a"
	});
	assert.equal(first.action, "request_approval");
	if (first.action !== "request_approval") return;
	gateway.grantDownloadAuthorization(first.downloadAuthorization);

	assert.equal((await gateway.evaluate("mcp_workspace_download_file", DOWNLOAD_ARGS, "download-2", "workspace-a", {
		requestId: "request-a"
	})).action, "allow");
	assert.equal((await gateway.evaluate("mcp_workspace_download_file", {
		...DOWNLOAD_ARGS,
		relativePath: "bin/other-tool.exe"
	}, "download-3", "workspace-a", {
		requestId: "request-a"
	})).action, "request_approval");
	assert.equal((await gateway.evaluate("mcp_workspace_download_file", DOWNLOAD_ARGS, "download-4", "workspace-a", {
		requestId: "request-b"
	})).action, "request_approval");
});

test("auto-safe approval can cover only the explicitly disclosed downloads in one request", async (): Promise<void> => {
	const gateway = new ApprovalGateway("auto-safe");
	const secondDownload = {
		...DOWNLOAD_ARGS,
		url: "https://downloads.example.test/tools/verifier-data.zip",
		relativePath: "cache/verifier-data.zip",
		dependency: "verifier-data"
	};
	const first = await gateway.evaluate("mcp_workspace_download_file", {
		...DOWNLOAD_ARGS,
		downloadScope: [secondDownload]
	}, "download-1", "workspace-a", { requestId: "request-a" });
	assert.equal(first.action, "request_approval");
	if (first.action !== "request_approval") return;
	assert.equal(first.downloadAuthorization?.downloads.length, 2);
	gateway.grantDownloadAuthorization(first.downloadAuthorization);
	assert.equal((await gateway.evaluate("mcp_workspace_download_file", secondDownload, "download-2", "workspace-a", {
		requestId: "request-a"
	})).action, "allow");
	assert.equal((await gateway.evaluate("mcp_workspace_download_file", {
		...DOWNLOAD_ARGS,
		url: "https://downloads.example.test/tools/unlisted.exe"
	}, "download-3", "workspace-a", { requestId: "request-a" })).action, "request_approval");
});

test("full-trust permits the structured downloader and terminal download syntax", async (): Promise<void> => {
	const gateway = new ApprovalGateway("full-trust");
	assert.equal((await gateway.evaluate("mcp_workspace_download_file", DOWNLOAD_ARGS, "download-1", "workspace-a", {
		requestId: "request-a"
	})).action, "allow");
	assert.equal((await gateway.evaluate("mcp_terminal_run_command", {
		commandLine: "curl.exe https://downloads.example.test/tool.exe -o tool.exe"
	}, "terminal-download", "workspace-a", {
		requestId: "request-a"
	})).action, "allow");
});

test("manual and auto-safe terminal download syntax returns a structured policy denial", async (): Promise<void> => {
	for (const mode of ["manual", "auto-safe"] as const) {
		const decision = await new ApprovalGateway(mode).evaluate("mcp_terminal_run_command", {
			commandLine: "Invoke-WebRequest https://downloads.example.test/tool.exe -OutFile tool.exe"
		}, "terminal-download", "workspace-a", { requestId: "request-a" });
		assert.equal(decision.action, "deny");
		if (decision.action === "deny") {
			assert.equal(decision.code, "network_access_required");
		}
	}
});

test("auto-safe command-review ask_user becomes a real approval instead of a denial", async (): Promise<void> => {
	const gateway = new ApprovalGateway("auto-safe", {
		resolveSandboxAvailability: () => ({ available: true }),
		reviewCommand: async () => ({
			decision: "ask_user",
			reason: "The command needs user confirmation.",
			audit: {
				source: "model",
				decision: "ask_user",
				reason: "The command needs user confirmation."
			}
		})
	});
	const decision = await gateway.evaluate("mcp_terminal_run_command", {
		commandLine: "python tools/build.py",
		cwd: "."
	}, "terminal-review", "workspace-a", { requestId: "request-a" });
	assert.equal(decision.action, "request_approval");
	if (decision.action === "request_approval") {
		assert.equal(decision.reason, "The command needs user confirmation.");
	}
});

test("process tools require exact one-shot consent when the OS sandbox is unavailable", async (): Promise<void> => {
	const gateway = new ApprovalGateway("manual", {
		resolveSandboxAvailability: () => ({
			available: false,
			error: "sandbox_unavailable: test helper missing."
		})
	});
	for (const [toolName, args] of [
		["mcp_terminal_run_safe_preset", { presetName: "workspace.typecheck" }],
		["mcp_terminal_run_godot_scene_script", { operationJson: '{"operation":"save"}' }],
		["mcp_godot_launch_editor", {}],
		["mcp_godot_get_runtime_status", {}],
		["mcp_godot_resave_resource", { resourcePath: "res://player.tres" }]
	] as const) {
		const decision = await gateway.evaluate(toolName, args, `call-${toolName}`, "workspace-a");
		assert.equal(decision.action, "request_approval");
		if (decision.action === "request_approval") {
			assert.equal(decision.requiredConsent?.expectedText, "RUN WITHOUT SANDBOX");
			assert.match(decision.requiredConsent?.prompt ?? "", /sandbox is unavailable/iu);
		}
	}
});
