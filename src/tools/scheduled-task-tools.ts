import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const SCHEDULED_TASK_TOOL_NAMES = [
	"mcp_scheduled_tasks_list",
	"mcp_scheduled_task_create",
	"mcp_scheduled_task_update",
	"mcp_scheduled_task_pause",
	"mcp_scheduled_task_resume",
	"mcp_scheduled_task_delete",
	"mcp_scheduled_task_report",
] as const;

export type ScheduledTaskToolName = typeof SCHEDULED_TASK_TOOL_NAMES[number];
export const SCHEDULED_TASK_TOOL_NAME_SET: ReadonlySet<string> = new Set(SCHEDULED_TASK_TOOL_NAMES);
export const SCHEDULED_TASK_MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set(SCHEDULED_TASK_TOOL_NAMES.slice(0, -1));

export type ScheduledTaskControlContext = {
	execute(toolName: ScheduledTaskToolName, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<Record<string, unknown>>;
};

const scheduleSchema: Record<string, unknown> = {
	oneOf: [
		{
			type: "object",
			properties: {
				kind: { const: "once" },
				runAt: { type: "string", format: "date-time" },
				timezone: { type: "string", minLength: 1, maxLength: 100 },
			},
			required: ["kind", "runAt", "timezone"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				kind: { const: "recurring" },
				cron: { type: "string", minLength: 9, maxLength: 120, description: "A five-field cron expression." },
				timezone: { type: "string", minLength: 1, maxLength: 100 },
			},
			required: ["kind", "cron", "timezone"],
			additionalProperties: false,
		},
	],
};

const contextSchema: Record<string, unknown> = {
	type: "object",
	properties: {
		workspaceId: { type: ["string", "null"], maxLength: 200 },
		provider: { type: "string", minLength: 1, maxLength: 80 },
		model: { type: "string", minLength: 1, maxLength: 200 },
		reasoningEffort: { type: ["string", "null"], maxLength: 32 },
		executionPolicy: { type: "string", enum: ["read_only", "auto_safe"] },
	},
	required: ["workspaceId", "provider", "model", "reasoningEffort", "executionPolicy"],
	additionalProperties: false,
};

const taskProperties: Record<string, unknown> = {
	title: { type: "string", minLength: 1, maxLength: 120 },
	kind: { type: "string", enum: ["reminder", "agent", "monitor"] },
	prompt: { type: "string", minLength: 1, maxLength: 20_000 },
	scheduleDescription: { type: "string", minLength: 1, maxLength: 500 },
	schedule: scheduleSchema,
	context: { anyOf: [contextSchema, { type: "null" }] },
};

export const SCHEDULED_TASK_TOOL_DEFINITIONS: ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "mcp_scheduled_tasks_list",
			description: "List the user's Daedalus Studio scheduled tasks. Use only when the user asks about their reminders or scheduled work.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "mcp_scheduled_task_create",
			description: "Create a reminder, scheduled AI task, or recurring AI monitor after the user explicitly requests it. This always requires approval.",
			parameters: { type: "object", properties: taskProperties, required: ["title", "kind", "prompt", "scheduleDescription", "schedule", "context"], additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "mcp_scheduled_task_update",
			description: "Update an existing scheduled task after explicit user approval.",
			parameters: { type: "object", properties: { taskId: { type: "string", minLength: 1, maxLength: 160 }, expectedRevision: { type: "string", maxLength: 128 }, ...taskProperties }, required: ["taskId"], additionalProperties: false },
		},
	},
	...(["pause", "resume", "delete"] as const).map((action): ChatCompletionTool => ({
		type: "function",
		function: {
			name: `mcp_scheduled_task_${action}`,
			description: `${action[0]!.toUpperCase()}${action.slice(1)} a scheduled task. This changes persistent future behavior and requires approval.`,
			parameters: { type: "object", properties: { taskId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["taskId"], additionalProperties: false },
		},
	})),
	{
		type: "function",
		function: {
			name: "mcp_scheduled_task_report",
			description: "Report whether a scheduled monitoring run found a meaningful change. Available only inside a monitor run and must be called exactly once before finishing.",
			parameters: { type: "object", properties: { changed: { type: "boolean" }, summary: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["changed", "summary"], additionalProperties: false },
		},
	},
];
