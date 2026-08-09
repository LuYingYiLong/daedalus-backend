import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createSkill } from "../../skills/management.js";
import { parseSkillDocument } from "../../skills/frontmatter.js";
import { resolveCatalogSkill } from "../../skills/catalog.js";
import { isGlobalSkillWorkspace } from "../../skills/runtime.js";
import type { SkillWorkspace } from "../../skills/types.js";

export const SKILL_CREATION_SCOPES = ["project", "personal"] as const;

export type SkillCreationScope = typeof SKILL_CREATION_SCOPES[number];

const SKILL_CREATION_SCOPE_ALIASES: Readonly<Record<string, SkillCreationScope>> = {
	project: "project",
	workspace: "project",
	repository: "project",
	personal: "personal",
	user: "personal",
	global: "personal"
};

/**
 * Normalizes a finite set of legacy or provider-facing scope aliases.
 * Unknown values intentionally remain invalid and are rejected by Zod.
 */
export function normalizeSkillCreationScopeInput(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	return SKILL_CREATION_SCOPE_ALIASES[value.trim().toLowerCase()] ?? value;
}

export function resolveSkillCreationScope(scope: SkillCreationScope | undefined, workspace: SkillWorkspace): SkillCreationScope {
	return scope ?? (isGlobalSkillWorkspace(workspace) ? "personal" : "project");
}

function asJsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function registerSkillTools(server: McpServer, workspace: SkillWorkspace): void {
	const pendingProposals: Set<string> = new Set();
	server.registerTool("load", {
		title: "Load Skill",
		description: "读取当前工作区已启用 skill 的正文。只读，不会改变工具权限。",
		inputSchema: z.object({ ref: z.string().min(3).max(80) })
	}, async ({ ref }) => {
		const skill = await resolveCatalogSkill(workspace, ref, true);
		return asJsonResult({ ref: skill.ref, name: skill.name, description: skill.description, activation: "automatic", instructions: skill.document!.body });
	});

	const skillScopeSchema = z.preprocess(
		normalizeSkillCreationScopeInput,
		z.enum(SKILL_CREATION_SCOPES).optional()
	);
	const proposalInput = z.object({
		scope: skillScopeSchema,
		slug: z.string().min(1).max(64),
		skillMd: z.string().min(1).max(65536)
	});
	const proposalTokenFor = (scope: string, slug: string, skillMd: string): string => createHash("sha256")
		.update(`${workspace.id}\n${scope}\n${slug}\n${skillMd}`)
		.digest("hex");
	server.registerTool("propose_create", {
		title: "Propose Skill Creation",
		description: "校验并预览新 skill，不写入磁盘。",
		inputSchema: proposalInput
	}, async ({ scope: requestedScope, slug, skillMd }) => {
		const scope: SkillCreationScope = resolveSkillCreationScope(requestedScope, workspace);
		if (scope === "project" && isGlobalSkillWorkspace(workspace)) {
			throw new Error("Project skill creation requires an active workspace.");
		}
		const document = parseSkillDocument(skillMd);
		const proposalToken: string = proposalTokenFor(scope, slug, skillMd);
		pendingProposals.add(proposalToken);
		return asJsonResult({ valid: true, scope, slug, name: document.name, description: document.description, bytes: Buffer.byteLength(skillMd, "utf8"), proposalToken });
	});

	server.registerTool("create", {
		title: "Create Skill",
		description: "创建项目或个人 SKILL.md。该写操作必须经过审批，且不会覆盖已有目录。",
		inputSchema: proposalInput.extend({ proposalToken: z.string().length(64) })
	}, async ({ scope: requestedScope, slug, skillMd, proposalToken }) => {
		const scope: SkillCreationScope = resolveSkillCreationScope(requestedScope, workspace);
		if (scope === "project" && isGlobalSkillWorkspace(workspace)) {
			throw new Error("Project skill creation requires an active workspace.");
		}
		const expectedToken: string = proposalTokenFor(scope, slug, skillMd);
		if (proposalToken !== expectedToken || !pendingProposals.has(proposalToken)) {
			throw new Error("Skill creation requires a matching propose_create result from this MCP session.");
		}
		pendingProposals.delete(proposalToken);
		const ref = await createSkill(workspace, scope, slug, skillMd);
		const skill = await resolveCatalogSkill(workspace, ref, true);
		return asJsonResult({ created: true, ref, name: skill.name, description: skill.description, enabled: true, activation: "explicit", displayPath: skill.displayPath });
	});
}
