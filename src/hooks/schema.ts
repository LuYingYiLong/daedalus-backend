import { z } from "zod";
import { HOOK_EVENT_NAMES, type HooksConfig } from "./types.js";

export const MAX_HOOKS_CONFIG_CHARS: number = 512 * 1024;
const MAX_MATCHER_CHARS: number = 500;
const MAX_COMMAND_CHARS: number = 16_000;
const MAX_STATUS_CHARS: number = 500;
const MAX_GROUPS_PER_EVENT: number = 128;
const MAX_HANDLERS_PER_GROUP: number = 32;

const hookCommandHandlerSchema = z.object({
	type: z.literal("command"),
	command: z.string().trim().min(1).max(MAX_COMMAND_CHARS),
	commandWindows: z.string().trim().min(1).max(MAX_COMMAND_CHARS).optional(),
	timeout: z.number().finite().positive().max(600).optional(),
	statusMessage: z.string().max(MAX_STATUS_CHARS).optional(),
	additionalContextLimit: z.number().int().min(0).max(100_000).optional(),
	async: z.boolean().optional(),
	failurePolicy: z.enum(["continue", "block"]).optional()
}).strict();

const hookMatcherGroupSchema = z.object({
	matcher: z.string().max(MAX_MATCHER_CHARS).optional(),
	hooks: z.array(hookCommandHandlerSchema).min(1).max(MAX_HANDLERS_PER_GROUP)
}).strict().superRefine((group, context): void => {
	if (group.matcher === undefined || group.matcher === "" || group.matcher === "*") return;
	try {
		new RegExp(group.matcher, "u");
	} catch (error: unknown) {
		context.addIssue({
			code: "custom",
			path: ["matcher"],
			message: `Invalid matcher regular expression: ${error instanceof Error ? error.message : String(error)}`
		});
	}
});

const hooksShape: Record<string, z.ZodTypeAny> = Object.fromEntries(
	HOOK_EVENT_NAMES.map((eventName: string): [string, z.ZodTypeAny] => [
		eventName,
		z.array(hookMatcherGroupSchema).max(MAX_GROUPS_PER_EVENT).optional()
	])
);

export const hooksConfigSchema = z.object({
	description: z.string().max(2000).optional(),
	hooks: z.object(hooksShape).strict()
}).strict();

export function parseHooksConfigText(content: string): HooksConfig {
	if (content.length > MAX_HOOKS_CONFIG_CHARS) {
		throw new Error(`Hooks configuration exceeds ${MAX_HOOKS_CONFIG_CHARS} characters.`);
	}
	let value: unknown;
	try {
		value = JSON.parse(content) as unknown;
	} catch (error: unknown) {
		throw new Error(`Invalid hooks.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	return hooksConfigSchema.parse(value) as HooksConfig;
}

export function formatHookValidationError(error: unknown): string[] {
	if (!(error instanceof z.ZodError)) {
		return [error instanceof Error ? error.message : String(error)];
	}
	return error.issues.map((issue): string => `${issue.path.join(".") || "hooks.json"}: ${issue.message}`);
}
