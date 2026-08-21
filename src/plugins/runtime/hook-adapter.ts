import type { HookDecision, HookRunRequest, HookRuntimeEvent } from "../../hooks/types.js";
import { readPluginRecords } from "../store.js";
import { ensurePluginRuntime, invokePlugin } from "./manager.js";
import { listPluginHooks } from "./registries.js";

function matches(matcher: string | undefined, value: string): boolean {
	if (matcher === undefined || matcher.length === 0 || matcher === "*") return true;
	try {
		return new RegExp(matcher, "u").test(value);
	} catch {
		return false;
	}
}

function mergeDecision(decisions: Array<Record<string, unknown>>): HookDecision {
	const blocked = decisions.find((decision): boolean => decision.blocked === true);
	const rewrites = decisions.flatMap((decision): Record<string, unknown>[] => {
		const value = decision.updatedInput;
		return value !== null && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
	});
	const rewriteKeys = new Set(rewrites.map((value): string => JSON.stringify(value)));
	const additionalContext = decisions.map((decision): string => typeof decision.additionalContext === "string" ? decision.additionalContext : "").filter(Boolean).join("\n\n");
	const systemMessages = decisions.map((decision): string => typeof decision.systemMessage === "string" ? decision.systemMessage : "").filter(Boolean);
	return {
		blocked: blocked !== undefined || rewriteKeys.size > 1,
		reason: blocked !== undefined && typeof blocked.reason === "string" ? blocked.reason : rewriteKeys.size > 1 ? "Multiple plugin hooks returned conflicting updatedInput values." : undefined,
		updatedInput: rewriteKeys.size > 1 ? undefined : rewrites[0],
		additionalContext: additionalContext || undefined,
		systemMessages
	};
}

export async function runPluginHooks(request: HookRunRequest, onEvent?: ((event: HookRuntimeEvent) => void) | undefined): Promise<HookDecision> {
	const records = await readPluginRecords();
	const outputs: Array<Record<string, unknown>> = [];
	const matcherValue = request.matcherValue ?? String(request.input.tool_name ?? request.input.prompt ?? "");
	for (const record of records) {
		const hookCapable: boolean = record.nativePlugin?.capabilities.includes("hooks") === true || record.compatibility.harnessBundle;
		if (!record.enabled || record.trust !== "trusted" || !hookCapable) continue;
		try {
			await ensurePluginRuntime(record.id, {
				sessionId: request.sessionId,
				workspaceId: request.workspace?.id,
				workspaceRoot: request.workspace?.sourceFolders.find((source): boolean => source.id === request.targetSourceFolderId)?.path
			});
			const hooks = listPluginHooks(request.event).filter((hook): boolean => hook.pluginId === record.id && matches(hook.matcher, matcherValue));
			if (hooks.length === 0) continue;
			for (const hook of hooks) {
				if (hook.async) {
					void invokePlugin(record.id, request.sessionId, "hook", hook.handlerName, request.input).catch((): void => undefined);
					continue;
				}
				const value = await invokePlugin(record.id, request.sessionId, "hook", hook.handlerName, {
					...request.input,
					session_id: request.sessionId,
					hook_event_name: request.event,
					workspace_id: request.workspace?.id,
					source_folder_id: request.targetSourceFolderId
				}) as Record<string, unknown>;
				outputs.push(value ?? {});
				onEvent?.({ statusMessage: undefined, systemMessage: typeof value?.systemMessage === "string" ? value.systemMessage : undefined });
			}
		} catch (error: unknown) {
			const hooks = listPluginHooks(request.event).filter((hook): boolean => hook.pluginId === record.id && matches(hook.matcher, matcherValue));
			if (hooks.some((hook): boolean => hook.failurePolicy === "block")) outputs.push({ blocked: true, reason: error instanceof Error ? error.message : String(error) });
			else onEvent?.({ systemMessage: `Plugin hook ${record.packageName} failed: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	return mergeDecision(outputs);
}
