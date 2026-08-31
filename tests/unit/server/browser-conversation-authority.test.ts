import assert from "node:assert/strict";
import test from "node:test";
import {
	BrowserConversationAuthority,
	type BrowserAudit,
} from "../../../src/server/browser-conversation-authority.js";
import {
	browserUrlsFromUserMessage,
	browserExecuteArgsSchema,
	type BrowserConsent,
	type BrowserScope,
} from "../../../src/protocol/external-browser.js";
import { parseBrowserConsent } from "../../../src/providers/browser-consent.js";
const first: BrowserScope = {
	connectionId: "studio-1",
	sessionId: "session-1",
	requestId: "user-1",
	runId: "run-1",
	generation: "gen-1",
};
const second = {
	...first,
	requestId: "user-2",
	runId: "run-2",
	generation: "gen-2",
};
const url = "https://example.test/form?draft=1#contact";
const steps = [
	{
		id: "fill",
		elementId: 0,
		action: "fill",
		value: "Ada",
		description: "Fill name",
		dependsOn: [],
	},
	{
		id: "submit",
		elementId: 1,
		action: "submit",
		description: "Submit to the local test form",
		dependsOn: ["fill"],
	},
];
async function fixture() {
	let now = 1000;
	const audit: BrowserAudit[] = [],
		calls: { op: string; args: Record<string, unknown> }[] = [];
	const authority = new BrowserConversationAuthority(
		async (value) => {
			audit.push(value);
		},
		() => now,
	);
	const controller = new AbortController();
	const forward = async (
		op: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		calls.push({ op, args });
		if (op === "connect") return { targetId: "target", url };
		if (op === "observe") return { observationId: "obs", url };
		if (op === "prepare")
			return { prepareId: "prepare", labels: { fill: "Name", submit: "Send" } };
		return { status: "dispatched" };
	};
	await authority.begin(
		first,
		`Please complete ${url}`,
		true,
		controller.signal,
		async () => {
			throw new Error("must not infer initial consent");
		},
	);
	await authority.execute(first, "mcp_browser_connect", { url }, forward);
	await authority.execute(
		first,
		"mcp_browser_observe",
		{ targetId: "target" },
		forward,
	);
	const propose = () =>
		authority.execute(
			first,
			"mcp_browser_propose",
			{
				targetId: "target",
				observationId: "obs",
				title: "Contact form",
				summary: "Submit name to the test form",
				steps,
			},
			forward,
		);
	return {
		authority,
		calls,
		audit,
		controller,
		forward,
		propose,
		expire: () => {
			now += 600001;
		},
	};
}
test("exact URL scope never expands from paths, queries, fragments or page text", async () => {
	assert.deepEqual(browserUrlsFromUserMessage(`visit ${url}`), [url]);
	assert.deepEqual(
		browserUrlsFromUserMessage("https://user:password@example.test/"),
		[],
	);
	const f = await fixture();
	for (const bad of [
		"https://example.test/",
		"https://example.test/form?draft=2#contact",
		"https://example.test/form?draft=1#other",
	])
		await assert.rejects(
			f.authority.execute(
				first,
				"mcp_browser_connect",
				{ url: bad },
				f.forward,
			),
			/browser_url_not_authorized/u,
		);
	await assert.rejects(
		f.authority.execute(
			first,
			"mcp_browser_click",
			{ targetId: "target", elementId: 0 },
			f.forward,
		),
		/forbidden/u,
	);
});
test("proposal ends the turn, next message authorizes only a subset, values immutable", async () => {
	const f = await fixture();
	const proposal = await f.propose();
	assert.match(String(proposal.confirmation), /Ada/u);
	assert.equal(
		f.calls.some((c) => c.op === "execute"),
		false,
	);
	await assert.rejects(
		f.authority.execute(
			first,
			"mcp_browser_execute_step",
			{ proposalId: proposal.proposalId, stepId: "fill" },
			f.forward,
		),
		/confirmation_pending/u,
	);
	f.authority.finish(first);
	const prompt = await f.authority.begin(
		second,
		"可以，但不要提交",
		true,
		f.controller.signal,
		async (display, reply) => {
			assert.equal(display, proposal.confirmation);
			assert.equal(reply, "可以，但不要提交");
			return { decision: "approve_subset", stepIds: ["fill"] };
		},
	);
	assert.match(prompt, /authorized ONLY/u);
	await assert.rejects(
		f.authority.execute(
			second,
			"mcp_browser_execute_step",
			{ proposalId: proposal.proposalId, stepId: "submit" },
			f.forward,
		),
		/consent_required/u,
	);
	await f.authority.execute(
		second,
		"mcp_browser_execute_step",
		{ proposalId: proposal.proposalId, stepId: "fill" },
		f.forward,
	);
	await f.authority.execute(
		second,
		"mcp_browser_execute_step",
		{ proposalId: proposal.proposalId, stepId: "fill" },
		f.forward,
	);
	assert.equal(f.calls.filter((c) => c.op === "execute").length, 1);
	assert.equal(
		(f.calls.at(-1)!.args.step as Record<string, unknown>).value,
		"Ada",
	);
	assert.equal(
		browserExecuteArgsSchema.safeParse({
			proposalId: proposal.proposalId,
			stepId: "fill",
			value: "Eve",
		}).success,
		false,
	);
});
for (const consent of [
	{ decision: "reject", stepIds: [] },
	{ decision: "clarify", stepIds: [] },
	{ decision: "approve_subset", stepIds: ["missing"] },
	{ decision: "approve_subset", stepIds: ["submit"] },
	{ decision: "approve_all", stepIds: ["fill"] },
] satisfies BrowserConsent[])
	test(`fail closed: ${JSON.stringify(consent)}`, async () => {
		const f = await fixture();
		await f.propose();
		f.authority.finish(first);
		await f.authority.begin(
			second,
			"reply",
			true,
			f.controller.signal,
			async () => consent,
		);
		assert.equal(f.authority.canExecute(second), false);
	});
test("ask mode, expired proposal, replay and malformed interpreter response never grant", async () => {
	for (const mode of ["ask", "expired", "replayed", "invalid"] as const) {
		const f = await fixture();
		await f.propose();
		f.authority.finish(first);
		if (mode === "expired") f.expire();
		await f.authority.begin(
			second,
			"yes",
			mode !== "ask",
			f.controller.signal,
			async () => {
				if (mode === "invalid") throw new Error("model unavailable");
				return { decision: "approve_all", stepIds: ["fill", "submit"] };
			},
			mode !== "replayed",
		);
		assert.equal(f.authority.canExecute(second), false);
	}
});
test("cancellation, stale generation, connection or session cannot use a grant", async () => {
	const f = await fixture();
	const proposal = await f.propose();
	f.authority.finish(first);
	await f.authority.begin(
		second,
		"yes",
		true,
		f.controller.signal,
		async () => ({ decision: "approve_all", stepIds: ["fill", "submit"] }),
	);
	for (const scope of [
		{ ...second, generation: "old" },
		{ ...second, sessionId: "other" },
		{ ...second, connectionId: "other" },
	])
		await assert.rejects(
			f.authority.execute(
				scope,
				"mcp_browser_execute_step",
				{ proposalId: proposal.proposalId, stepId: "fill" },
				f.forward,
			),
			/scope_stale/u,
		);
	f.controller.abort();
	assert.equal(f.authority.canExecute(second), false);
});
test("unknown dispatch is not retried and revokes remaining steps", async () => {
	const f = await fixture();
	const proposal = await f.propose();
	f.authority.finish(first);
	await f.authority.begin(
		second,
		"yes",
		true,
		f.controller.signal,
		async () => ({ decision: "approve_all", stepIds: ["fill", "submit"] }),
	);
	let writes = 0;
	const uncertain = async (): Promise<Record<string, unknown>> => {
		writes++;
		throw new Error("lost reply");
	};
	const result = await f.authority.execute(
		second,
		"mcp_browser_execute_step",
		{ proposalId: proposal.proposalId, stepId: "fill" },
		uncertain,
	);
	assert.equal(result.status, "unknown");
	await assert.rejects(
		f.authority.execute(
			second,
			"mcp_browser_execute_step",
			{ proposalId: proposal.proposalId, stepId: "fill" },
			uncertain,
		),
		/consent_required/u,
	);
	assert.equal(writes, 1);
});
test("consent parser rejects prose, extra fields and oversized output", () => {
	assert.deepEqual(
		parseBrowserConsent('```json\n{"decision":"reject","stepIds":[]}\n```'),
		{ decision: "reject", stepIds: [] },
	);
	for (const raw of [
		'Yes {"decision":"approve_all","stepIds":["fill"]}',
		'{"decision":"approve_all","stepIds":["fill"],"newValue":"injected"}',
		"x".repeat(17000),
	])
		assert.throws(() => parseBrowserConsent(raw));
});

test("ambiguous tabs retain only the actual user's exact URL for the next clarification", async () => {
	const authority = new BrowserConversationAuthority();
	const signal = new AbortController().signal;
	await authority.begin(first, `Look at ${url}`, false, signal, async () => {
		throw new Error("unexpected");
	});
	await authority.execute(first, "mcp_browser_connect", { url }, async () => ({
		ambiguous: true,
		matches: [{ matchId: "first", title: "Test" }],
	}));
	authority.finish(first);
	await authority.begin(second, "第一个标签页", false, signal, async () => {
		throw new Error("not consent");
	});
	await authority.execute(
		second,
		"mcp_browser_connect",
		{ url, matchId: "first" },
		async (_op, args) => {
			assert.equal(args.url, url);
			return { targetId: "selected", url };
		},
	);
	await assert.rejects(
		authority.execute(
			second,
			"mcp_browser_connect",
			{ url: "https://example.test/other" },
			async () => ({}),
		),
		/not_authorized/,
	);
	assert.equal(authority.canExecute(second), false);
});

test("late interpreter results and revoked pending proposals cannot grant a new run", async () => {
	const f = await fixture();
	await f.propose();
	f.authority.finish(first);
	let finish!: (consent: BrowserConsent) => void;
	const pending = f.authority.begin(
		second,
		"yes",
		true,
		f.controller.signal,
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	f.authority.revoke(first.connectionId);
	finish({ decision: "approve_all", stepIds: ["fill", "submit"] });
	await assert.rejects(pending, /stale/);
	assert.equal(f.authority.canExecute(second), false);
});

test("pending-proposal revocation is bound to the original run and generation", async () => {
	for (const revokeCurrent of [false, true]) {
		const f = await fixture();
		await f.propose();
		f.authority.finish(first);
		f.authority.revokePending(
			first.connectionId,
			first.sessionId,
			revokeCurrent ? first.runId : "old-run",
			first.generation,
		);
		let interpreted = false;
		await f.authority.begin(
			second,
			"yes",
			true,
			f.controller.signal,
			async () => {
				interpreted = true;
				return { decision: "approve_all", stepIds: ["fill", "submit"] };
			},
		);
		assert.equal(interpreted, !revokeCurrent);
		assert.equal(f.authority.canExecute(second), !revokeCurrent);
	}
});

test("a new message on another connection invalidates the session's pending proposal", async () => {
	const f = await fixture();
	await f.propose();
	f.authority.finish(first);
	const other = { ...second, connectionId: "another-studio" };
	await f.authority.begin(
		other,
		"Another task",
		true,
		f.controller.signal,
		async () => {
			throw new Error("Foreign consent must not be interpreted");
		},
	);
	f.authority.finish(other);
	let interpreted = false;
	await f.authority.begin(
		second,
		"yes",
		true,
		f.controller.signal,
		async () => {
			interpreted = true;
			return { decision: "approve_all", stepIds: ["fill", "submit"] };
		},
	);
	assert.equal(interpreted, false);
	assert.equal(f.authority.canExecute(second), false);
});
