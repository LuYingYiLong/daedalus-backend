import { z } from "zod";

export const browserIdSchema = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9:_-]+$/u);
export const browserUrlSchema = z
	.string()
	.max(4096)
	.transform((value, ctx) => {
		try {
			return normalizeBrowserUrl(value);
		} catch {
			ctx.addIssue({ code: "custom", message: "Invalid browser URL." });
			return z.NEVER;
		}
	});
export function normalizeBrowserUrl(value: string): string {
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("browser_url_invalid");
	return url.href;
}
export function browserUrlsFromUserMessage(message: string): string[] {
	const urls = new Set<string>();
	for (const match of message.matchAll(/https?:\/\/[^\s<>"`“”「」]+/gu)) {
		let candidate = match[0].replace(/[，。；！？）]+$/gu, "");
		for (const [open, close] of [
			["(", ")"],
			["[", "]"],
		] as const) {
			while (
				candidate.endsWith(close) &&
				candidate.split(close).length > candidate.split(open).length
			)
				candidate = candidate.slice(0, -1);
		}
		try {
			urls.add(normalizeBrowserUrl(candidate));
		} catch {
			/* 不猜测或删改查询参数与 fragment */
		}
	}
	return [...urls].slice(0, 10);
}
export const browserStepSchema = z
	.object({
		id: browserIdSchema,
		elementId: z.number().int().min(0).max(199),
		action: z.enum(["click", "fill", "select", "check", "submit"]),
		value: z.string().max(16000).optional(),
		checked: z.boolean().optional(),
		description: z.string().trim().min(1).max(1000),
		dependsOn: z.array(browserIdSchema).max(20).default([]),
	})
	.strict()
	.superRefine((step, ctx) => {
		if (
			(step.action === "fill" || step.action === "select") !==
			(step.value !== undefined)
		)
			ctx.addIssue({
				code: "custom",
				message: "Only fill/select require value.",
			});
		if ((step.action === "check") !== (step.checked !== undefined))
			ctx.addIssue({ code: "custom", message: "Only check requires checked." });
	});
export const browserProposalArgsSchema = z
	.object({
		targetId: browserIdSchema,
		observationId: browserIdSchema,
		title: z.string().trim().min(1).max(200),
		summary: z.string().trim().min(1).max(2000),
		steps: z.array(browserStepSchema).min(1).max(20),
	})
	.strict()
	.superRefine((proposal, ctx) => {
		const prior = new Set<string>();
		for (const step of proposal.steps) {
			if (prior.has(step.id) || step.dependsOn.some((id) => !prior.has(id)))
				ctx.addIssue({
					code: "custom",
					message:
						"Steps must have unique ids and depend only on earlier steps.",
				});
			prior.add(step.id);
		}
	});
export const browserConnectArgsSchema = z
	.object({
		url: browserUrlSchema,
		connectionId: browserIdSchema.optional(),
		matchId: browserIdSchema.optional(),
	})
	.strict();
export const browserExecuteArgsSchema = z
	.object({ proposalId: browserIdSchema, stepId: browserIdSchema })
	.strict();
export const browserConsentSchema = z
	.object({
		decision: z.enum(["approve_all", "approve_subset", "reject", "clarify"]),
		stepIds: z.array(browserIdSchema).max(20),
	})
	.strict();
export type BrowserStep = z.infer<typeof browserStepSchema>;
export type BrowserProposalArgs = z.infer<typeof browserProposalArgsSchema>;
export type BrowserConsent = z.infer<typeof browserConsentSchema>;
export type BrowserScope = {
	connectionId: string;
	sessionId: string;
	requestId: string;
	runId: string;
	generation: string;
};
export type BrowserProposal = BrowserProposalArgs & {
	proposalId: string;
	scope: BrowserScope;
	url: string;
	createdAt: number;
	expiresAt: number;
	confirmation: string;
	prepared: Record<string, unknown>;
};
export const EXTERNAL_BROWSER_TOOLS = [
	"mcp_browser_connect",
	"mcp_browser_propose",
	"mcp_browser_execute_step",
] as const;
export const EXTERNAL_BROWSER_READ_TOOLS = new Set([
	"mcp_browser_observe",
	"mcp_browser_screenshot",
	"mcp_browser_scroll",
	"mcp_browser_wait",
]);
