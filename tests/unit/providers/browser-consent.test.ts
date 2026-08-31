import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretBrowserConsent } from "../../../src/providers/browser-consent.js";
import { resolveProviderAdapter } from "../../../src/providers/provider-adapter.js";
import type { ProviderChatOptions } from "../../../src/providers/provider-types.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";
import type { AiChatParams, ChatMessage } from "../../../src/protocol/types.js";

const options: ProviderChatOptions = {
	provider: "moonshot",
	model: "kimi-k2.6",
	apiKey: "fixture",
	baseUrl: "https://never-request.invalid",
	usageContext: { requestId: "consent-fixture", operation: "chat" },
};
test("consent uses only the displayed proposal and actual reply, with the same model and no history", async (t) => {
	const previous = process.env.USERPROFILE,
		directory = await mkdtemp(join(tmpdir(), "browser-consent-"));
	process.env.USERPROFILE = directory;
	const network = t.mock.method(globalThis, "fetch", async () => {
		throw new Error("No external network allowed");
	});
	try {
		const chat = t.mock.method(
			resolveProviderAdapter(options),
			"chat",
			async (
				params: AiChatParams,
				actual: ProviderChatOptions,
				history: ChatMessage[],
				system: string,
			) => {
				assert.deepEqual(JSON.parse(params.message), {
					displayedProposal: "fill and submit",
					userReply: "可以，但不要提交",
				});
				assert.deepEqual(history, []);
				assert.match(system, /Interpret ONLY/);
				assert.equal(actual.provider, options.provider);
				assert.equal(actual.model, options.model);
				assert.equal(actual.sensitivePayload, true);
				assert.equal(actual.usageContext?.operation, "browser_consent");
				return '{"decision":"approve_subset","stepIds":["fill"]}';
			},
		);
		assert.deepEqual(
			await interpretBrowserConsent(
				"fill and submit",
				"可以，但不要提交",
				options,
				new AbortController().signal,
			),
			{ decision: "approve_subset", stepIds: ["fill"] },
		);
		assert.equal(chat.mock.callCount(), 1);
		assert.equal(network.mock.callCount(), 0);
	} finally {
		if (previous === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancelled interpretation cannot return late approval", async (t) => {
	const controller = new AbortController();
	t.mock.method(resolveProviderAdapter(options), "chat", async () => {
		controller.abort();
		return '{"decision":"approve_all","stepIds":["submit"]}';
	});
	await assert.rejects(
		interpretBrowserConsent("submit", "yes", options, controller.signal),
	);
});

test("all approval modes require browser conversation authority and avoid modal approvals", async () => {
	for (const mode of ["manual", "auto-safe", "full-trust"] as const) {
		const gateway = new ApprovalGateway(mode);
		assert.equal(
			(
				await gateway.evaluate(
					"mcp_browser_connect",
					{ url: "https://example.test/" },
					"connect",
				)
			).action,
			"allow",
		);
		assert.equal(
			(await gateway.evaluate("mcp_browser_propose", {}, "propose")).action,
			"allow",
		);
		assert.equal(
			(await gateway.evaluate("mcp_browser_execute_step", {}, "execute"))
				.action,
			"deny",
		);
		assert.equal(
			(
				await gateway.evaluate(
					"mcp_browser_execute_step",
					{},
					"execute",
					undefined,
					{ browserAuthorized: true },
				)
			).action,
			"allow",
		);
	}
});
