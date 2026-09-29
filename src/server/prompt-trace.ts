import { createHash, createHmac, randomBytes } from "node:crypto";
import type { ClientSession } from "./client-session.js";

const CUSTOM_INSTRUCTIONS_TRACE_WARNING_CHARS: number = 4000;
const CACHE_TRACE_KEY: Buffer = randomBytes(32);
const CACHE_TRACE_LIMIT: number = 512;
const previousCacheSections: Map<string, Map<string, string>> = new Map();

export function logPromptCacheDiagnostics(input: {
	requestId: string;
	sessionId?: string | undefined;
	operation: string;
	sections: Record<string, string>;
}): void {
	if (process.env.DAEDALUS_PROMPT_CACHE_DIAGNOSTICS !== "1") return;
	const key: string = `${input.sessionId ?? input.requestId}:${input.operation}`;
	const previous: Map<string, string> | undefined = previousCacheSections.get(key);
	const current: Map<string, string> = new Map();
	const changed: string[] = [];
	const tokenEstimates: Record<string, number> = {};
	for (const [name, value] of Object.entries(input.sections)) {
		const fingerprint: string = createHmac("sha256", CACHE_TRACE_KEY).update(value).digest("hex");
		current.set(name, fingerprint);
		tokenEstimates[name] = Math.max(0, Math.ceil(value.length / 3));
		if (previous?.get(name) !== fingerprint) changed.push(name);
	}
	previousCacheSections.delete(key);
	previousCacheSections.set(key, current);
	if (previousCacheSections.size > CACHE_TRACE_LIMIT) previousCacheSections.delete(previousCacheSections.keys().next().value!);
	console.info(`[prompt.cache] operation=${input.operation} variant=optimized changed=${changed.join(",") || "none"} estimatedTokens=${JSON.stringify(tokenEstimates)}`);
}

export function fingerprintText(text: string): string {
	if (text.length === 0) {
		return "empty";
	}

	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function logPromptTrace(params: {
	requestId: string;
	promptId: string | undefined;
	skillId: string | undefined;
	phaseId?: string | undefined;
	customInstructions: string | undefined;
	systemPrompt: string;
	skillPrompt: string;
	mcpSystemContext: string;
	additionalContextSection?: string | undefined;
	guidePromptSection?: string | undefined;
	fullSystemPrompt: string;
}): void {
	const customInstructions: string = params.customInstructions?.trim() ?? "";
	const customTrace: string = customInstructions.length === 0
		? "none"
		: `${customInstructions.length}chars:${fingerprintText(customInstructions)}`;
	const phaseTrace: string = params.phaseId !== undefined ? ` phase=${params.phaseId}` : "";
	console.info(
		[
			`[prompt.trace] request=${params.requestId}${phaseTrace}`,
			`prompt=${params.promptId ?? "default"}`,
			`skill=${params.skillId ?? "none"}`,
			`custom=${customTrace}`,
			`system=${params.systemPrompt.length}chars:${fingerprintText(params.systemPrompt)}`,
			`skillPrompt=${params.skillPrompt.length}chars:${fingerprintText(params.skillPrompt)}`,
			`mcpContext=${params.mcpSystemContext.length}chars:${fingerprintText(params.mcpSystemContext)}`,
			`additionalContext=${(params.additionalContextSection ?? "").length}chars:${fingerprintText(params.additionalContextSection ?? "")}`,
			`guide=${(params.guidePromptSection ?? "").length}chars:${fingerprintText(params.guidePromptSection ?? "")}`,
			`full=${params.fullSystemPrompt.length}chars:${fingerprintText(params.fullSystemPrompt)}`
		].join(" ")
	);
	console.info(
		`[prompt.priority] request=${params.requestId}${phaseTrace} order=runtime_system_and_tool_safety > project_instructions > current_user_message > settings_custom_instructions > defaults`
	);

	if (customInstructions.length >= CUSTOM_INSTRUCTIONS_TRACE_WARNING_CHARS) {
		console.warn(
			`[prompt.warning] request=${params.requestId}${phaseTrace} custom_instructions_long=${customInstructions.length}chars:${fingerprintText(customInstructions)}`
		);
	}
}

export function logProjectInstructionTrace(session: ClientSession, serverId: string, fileName: string, content: string): void {
	const workspaceId: string = session.activeWorkspace?.id ?? "none";
	const sessionId: string = session.sessionId ?? "none";
	console.info(
		`[prompt.project-instruction] session=${sessionId} workspace=${workspaceId} server=${serverId} file=${fileName} chars=${content.length} sha256=${fingerprintText(content)}`
	);
}
