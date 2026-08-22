import { z } from "zod";
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DATA_URL_CHARS,
	MAX_IMAGE_THUMBNAIL_DATA_URL_CHARS,
	SUPPORTED_IMAGE_MIME_TYPES
} from "./image-attachments.js";

export const promptIdSchema = z.enum([
	"godot.assistant",
	"workspace.assistant",
	"gdscript.reviewer",
	"scene.architect",
	"backend.helper",
	"git.committer"
]);

export const skillIdSchema = z.enum([
	"godot.project_init",
	"gdscript.review",
	"scene.builder",
	"file.creator",
	"backend.helper",
	"skill.creator",
	"image.gen"
]);

export const skillRefSchema = z.string()
	.min(3)
	.max(320)
	.regex(/^(?:(?:builtin|personal):[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?|project:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:@[a-f0-9]{12})?|(?:plugin|harness):[A-Za-z0-9@._:-]+:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/u, "Invalid skill reference.");

const skillTargetSchema = z.object({
	workspaceId: z.string().min(1).max(200).optional(),
	sourceFolderId: z.string().min(1).max(200).optional(),
}).strict();

const hookConfigTargetSchema = z.discriminatedUnion("scope", [
	z.object({ scope: z.literal("global") }).strict(),
	z.object({
		scope: z.literal("source"),
		workspaceId: z.string().min(1).max(200),
		sourceFolderId: z.string().min(1).max(200)
	}).strict()
]);

export const providerIdSchema = z.string()
	.min(1)
	.max(80)
	.regex(/^[a-z][a-z0-9._-]*$/u, "Provider id must be lowercase ASCII with digits, dot, underscore, or dash.");

const providerWebsiteUrlSchema = z.string()
	.trim()
	.max(2048)
	.refine((value: string): boolean => {
		if (value.length === 0) {
			return true;
		}
		try {
			const parsed: URL = new URL(value);
			return parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			return false;
		}
	}, "Provider website URL must use http or https.");

const imageContextDataSchema = z.object({
	mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES as [string, ...string[]]),
	dataUrl: z.string().min(1).max(MAX_IMAGE_DATA_URL_CHARS).optional(),
	attachmentId: z.string().min(1).max(160).optional(),
	thumbnailDataUrl: z.string().min(1).max(MAX_IMAGE_THUMBNAIL_DATA_URL_CHARS).optional(),
	byteSize: z.number().int().positive().max(MAX_IMAGE_BYTES),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
	sourcePath: z.string().min(1).max(1000).optional()
});

const textAttachmentContextDataSchema = z.object({
	attachmentId: z.string().min(1).max(160),
	mimeType: z.literal("text/plain"),
	byteSize: z.number().int().positive().max(1_000_000),
	fileName: z.string().min(1).max(200),
	content: z.string().max(1_000_000).optional()
});

const providerTaskModelRefSchema = z.object({
	provider: providerIdSchema,
	model: z.string().min(1)
});

const providerModelRoutingSchema = z
	.object({
		imageRecognition: providerTaskModelRefSchema.nullable().optional(),
		sessionTitle: providerTaskModelRefSchema.nullable().optional(),
		nextStepHints: providerTaskModelRefSchema.nullable().optional(),
		imageGeneration: providerTaskModelRefSchema.nullable().optional(),
		gitCommit: providerTaskModelRefSchema.nullable().optional(),
		commandReview: providerTaskModelRefSchema.nullable().optional(),
		goalEvaluator: providerTaskModelRefSchema.nullable().optional(),
		contextCompression: providerTaskModelRefSchema.nullable().optional()
	})
	.strict();

const providerRequestJsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		z.string().max(16_000),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(providerRequestJsonValueSchema).max(512),
		z.record(z.string().min(1).max(160), providerRequestJsonValueSchema)
	])
);

const providerRequestOverridesSchema = z
	.object({
		headers: z.record(z.string().min(1).max(160), z.string().max(8_000)).optional(),
		body: z.record(z.string().min(1).max(160), providerRequestJsonValueSchema).optional()
	})
	.strict();

const providerReasoningEffortOptionSchema = z
	.object({
		id: z.string().trim().min(1).max(32),
		fallback: z.enum(["low", "medium", "high", "max"]),
		default: z.boolean().optional()
	})
	.strict();

const providerReasoningEffortsSchema = z
	.array(providerReasoningEffortOptionSchema)
	.max(16)
	.superRefine((options, context): void => {
		const ids: Set<string> = new Set();
		let defaultCount: number = 0;
		for (const [index, option] of options.entries()) {
			if (ids.has(option.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Reasoning effort IDs must be unique.",
					path: [index, "id"]
				});
			}
			ids.add(option.id);
			defaultCount += option.default === true ? 1 : 0;
		}
		if (defaultCount > 1) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Only one reasoning effort can be the default."
			});
		}
	});

const providerModelCapabilitiesSchema = z
	.object({
		imageInput: z.boolean().optional(),
		videoInput: z.boolean().optional(),
		reasoning: z.boolean().optional(),
		reasoningEfforts: providerReasoningEffortsSchema.optional(),
		tools: z.boolean().optional(),
		webSearch: z.boolean().optional(),
		vision: z.boolean().optional(),
		imageGeneration: z.boolean().optional(),
		imageEdit: z.boolean().optional()
	})
	.strict();

const discoveredProviderModelSchema = z
	.object({
		id: z.string().trim().min(1).max(200),
		displayName: z.string().trim().min(1).max(120),
		contextWindowTokens: z.number().int().positive().max(2_000_000_000),
		maxOutputTokens: z.number().int().positive().max(2_000_000_000),
		capabilities: providerModelCapabilitiesSchema,
		ownedBy: z.string().trim().min(1).max(200).optional()
	})
	.strict();

const sessionUiMetadataParamsSchema = z
	.object({
		provider: providerIdSchema.optional(),
		model: z.string().min(1).optional(),
		reasoningEffort: z.string().min(1).max(32).optional(),
		chatMode: z.enum(["agent", "ask", "plan", "goal"]).optional(),
		approvalMode: z.enum(["manual", "auto-safe", "full-trust"]).optional(),
		workflowTodoCollapsed: z.boolean().optional(),
		workflowTodoDismissedKey: z.string().trim().min(1).max(300).nullable().optional(),
		workspaceLaunch: z.enum(["file-explorer", "terminal", "vscode", "visual-studio", "github-desktop", "git-bash", "godot"]).optional(),
		scheduledTaskOrigin: z.object({
			taskId: z.string().min(1).max(160),
			runId: z.string().min(1).max(160),
			kind: z.enum(["agent", "monitor"]),
			scheduledAt: z.string().datetime(),
			executionPolicy: z.enum(["read_only", "auto_safe"]),
		}).strict().optional()
	})
	.strict();

const editableProviderModelCapabilitiesSchema = z
	.object({
		imageInput: z.boolean(),
		videoInput: z.boolean(),
		reasoning: z.boolean(),
		tools: z.boolean(),
		webSearch: z.boolean(),
		imageGeneration: z.boolean(),
		imageEdit: z.boolean()
	})
	.strict();

const editableProviderModelCapabilityOverridesSchema = z
	.object({
		imageInput: z.boolean().nullable(),
		videoInput: z.boolean().nullable(),
		reasoning: z.boolean().nullable(),
		tools: z.boolean().nullable(),
		webSearch: z.boolean().nullable(),
		imageGeneration: z.boolean().nullable(),
		imageEdit: z.boolean().nullable()
	})
	.strict();

export const messageTextAnchorSchema = z
	.object({
		entryId: z.string().trim().min(1).max(240),
		requestId: z.string().trim().min(1).max(240),
		role: z.enum(["user", "assistant"]),
		segmentKey: z.string().trim().min(1).max(240),
		startOffset: z.number().int().min(0).max(2_000_000_000),
		endOffset: z.number().int().positive().max(2_000_000_000),
		quote: z.string().min(1).max(8000),
		contextBefore: z.string().max(800),
		contextAfter: z.string().max(800)
	})
	.strict()
	.superRefine((anchor, context): void => {
		if (anchor.endOffset <= anchor.startOffset) {
			context.addIssue({
				code: "custom",
				path: ["endOffset"],
				message: "Selection endOffset must be greater than startOffset."
			});
		}
	});

const messageSelectionContextDataSchema = z
	.object({
		anchor: messageTextAnchorSchema,
		selectedText: z.string().min(1).max(8000),
		annotation: z.string().max(1200)
	})
	.strict();

const fileSelectionContextDataSchema = z
	.object({
		selectedText: z.string().min(1).max(8000),
		annotation: z.string().max(1200),
		lineStart: z.number().int().positive().max(2_000_000_000),
		lineEnd: z.number().int().positive().max(2_000_000_000),
		columnStart: z.number().int().positive().max(2_000_000_000),
		columnEnd: z.number().int().positive().max(2_000_000_000),
		workspaceId: z.string().min(1).max(200).optional(),
		sourceFolderId: z.string().min(1).max(200),
		relativePath: z.string().min(1).max(1000)
	})
	.strict()
	.superRefine((selection, context): void => {
		if (selection.lineEnd < selection.lineStart || (selection.lineEnd === selection.lineStart && selection.columnEnd <= selection.columnStart)) {
			context.addIssue({
				code: "custom",
				path: ["lineEnd"],
				message: "File selection end must be after its start."
			});
		}
	});

const webElementContextDataSchema = z
	.object({
		url: z
			.url()
			.max(2048)
			.refine((value: string): boolean => value.startsWith("https://") || value.startsWith("http://"), "Web element URL must use HTTP or HTTPS."),
		pageTitle: z.string().max(300),
		selector: z.string().min(1).max(1000),
		tagName: z.string().min(1).max(80),
		role: z.string().max(120),
		accessibleName: z.string().max(500),
		selectedText: z.string().max(8000),
		attributes: z.record(z.string().min(1).max(120), z.string().max(500)).superRefine((attributes, context): void => {
			if (Object.keys(attributes).length > 20) {
				context.addIssue({
					code: "custom",
					message: "Web element attributes cannot contain more than 20 entries."
				});
			}
		}),
		annotation: z.string().max(1200)
	})
	.strict();

export const additionalContextItemSchema = z
	.object({
		id: z.string().min(1).max(160),
		kind: z.enum([
			"editor_selection",
			"scene",
			"node",
			"file",
			"folder",
			"script",
			"script_selection",
			"filesystem_selection",
			"image",
			"text_attachment",
			"git_diff_comment",
			"message_selection",
			"file_selection",
			"web_element"
		]),
		title: z.string().min(1).max(200),
		subtitle: z.string().max(400).optional(),
		pinned: z.boolean().optional(),
		source: z.enum(["editor", "manual"]),
		resourcePath: z.string().max(1000).optional(),
		nodePath: z.string().max(500).optional(),
		nodeType: z.string().max(160).optional(),
		scriptPath: z.string().max(500).optional(),
		summary: z.string().max(1200).optional(),
		data: z.unknown().optional()
	})
	.superRefine((item, context): void => {
		if (item.kind === "web_element") {
			if (!webElementContextDataSchema.safeParse(item.data).success) {
				context.addIssue({
					code: "custom",
					path: ["data"],
					message: "Web element context data must contain a validated page and element snapshot."
				});
			}
			if (item.pinned === true) {
				context.addIssue({
					code: "custom",
					path: ["pinned"],
					message: "Web element context cannot be pinned."
				});
			}
			return;
		}

		if (item.kind === "file_selection") {
			if (!fileSelectionContextDataSchema.safeParse(item.data).success || item.resourcePath === undefined) {
				context.addIssue({
					code: "custom",
					path: ["data"],
					message: "File selection context data must contain a path, selection range, selectedText, and annotation."
				});
			}
			if (item.pinned === true) {
				context.addIssue({
					code: "custom",
					path: ["pinned"],
					message: "File selection context cannot be pinned."
				});
			}
			return;
		}

		if (item.kind === "message_selection") {
			const parsed = messageSelectionContextDataSchema.safeParse(item.data);
			if (!parsed.success || parsed.data.selectedText !== parsed.data.anchor.quote) {
				context.addIssue({
					code: "custom",
					path: ["data"],
					message: "Message selection context data must contain a matching anchor, selectedText, and annotation."
				});
			}
			if (item.pinned === true) {
				context.addIssue({
					code: "custom",
					path: ["pinned"],
					message: "Message selection context cannot be pinned."
				});
			}
			return;
		}

		if (item.kind === "text_attachment") {
			if (!textAttachmentContextDataSchema.safeParse(item.data).success) {
				context.addIssue({
					code: "custom",
					path: ["data"],
					message: "Text attachment context data must contain attachment metadata."
				});
			}
			return;
		}

		if (item.kind !== "image") {
			return;
		}

		const parsed = imageContextDataSchema.safeParse(item.data);
		if (!parsed.success) {
			context.addIssue({
				code: "custom",
				path: ["data"],
				message: "Image context data must contain valid attachment metadata and a bounded optional preview."
			});
			return;
		}

		if (parsed.data.dataUrl === undefined && parsed.data.attachmentId === undefined) {
			context.addIssue({
				code: "custom",
				path: ["data"],
				message: "Image context data must contain dataUrl or attachmentId."
			});
			return;
		}

		if (parsed.data.dataUrl !== undefined && !parsed.data.dataUrl.startsWith(`data:${parsed.data.mimeType};base64,`)) {
			context.addIssue({
				code: "custom",
				path: ["data", "dataUrl"],
				message: "Image dataUrl must match mimeType."
			});
		}
	});

export const aiChatParamsSchema = z
	.object({
		message: z.string(),
		mode: z.enum(["agent", "ask", "plan", "goal"]).optional(),
		provider: providerIdSchema.optional(),
		model: z.string().min(1).optional(),
		promptId: promptIdSchema.optional(),
		skillRefs: z.array(skillRefSchema).max(4).optional(),
		systemPrompt: z.string().optional(),
		retryFromRequestId: z.string().min(1).optional(),
		retryOfRunId: z.string().min(1).optional(),
		additionalContext: z.array(additionalContextItemSchema).max(32).optional(),
		options: z
			.object({
				temperature: z.number().min(0).max(2).optional(),
				topP: z.number().min(0).max(1).optional(),
				maxTokens: z.number().int().positive().optional(),
				reasoningEffort: z.string().min(1).max(32).optional(),
				stop: z.union([z.string(), z.array(z.string())]).optional(),
				responseFormat: z.union([z.literal("text"), z.literal("json")]).optional(),
				stream: z.boolean().optional(),
				toolBudget: z.enum(["simple", "normal", "codegen", "project_edit"]).optional(),
				executionPolicy: z.enum(["auto", "read_only"]).optional(),
				verificationPolicy: z.enum(["required", "best_effort", "skip"]).optional(),
				outputTarget: z.enum(["chat", "workspace"]).optional(),
				workflow: z.enum(["auto", "single", "multi_phase", "llm_planned"]).optional(),
				queueItemId: z.number().int().positive().optional()
			})
			.optional()
	})
	.superRefine((params, context): void => {
		if (params.message.trim().length === 0 && (params.additionalContext?.length ?? 0) === 0) {
			context.addIssue({
				code: "custom",
				path: ["message"],
				message: "Message or additional context is required."
			});
		}
	});

const guideTextSchema = z.string().min(1).max(4000);
const scheduledQueueOriginSchema = z.object({
	taskId: z.string().min(1).max(160),
	runId: z.string().min(1).max(160),
	kind: z.enum(["agent", "monitor"]),
	scheduledAt: z.string().min(1).max(100),
	executionPolicy: z.enum(["read_only", "auto_safe"]),
}).strict();
const queuedMessageSnapshotShape = {
	text: z.string().max(20000),
	mode: z.enum(["agent", "ask", "plan", "goal"]).optional(),
	provider: providerIdSchema.optional(),
	model: z.string().min(1).optional(),
	reasoningEffort: z.string().min(1).max(32).optional(),
	executionPolicy: z.enum(["auto", "read_only"]).optional(),
	verificationPolicy: z.enum(["required", "best_effort", "skip"]).optional(),
	outputTarget: z.enum(["chat", "workspace"]).optional(),
	skillRefs: z.array(skillRefSchema).max(4).optional(),
	additionalContext: z.array(additionalContextItemSchema).max(32).optional(),
	scheduledTaskOrigin: scheduledQueueOriginSchema.optional(),
};
function requireQueuedMessageContent(
	params: { text: string; additionalContext?: unknown[] | undefined },
	context: z.RefinementCtx
): void {
	if (params.text.trim().length === 0 && (params.additionalContext?.length ?? 0) === 0) {
		context.addIssue({
			code: "custom",
			path: ["text"],
			message: "Message text or additional context is required."
		});
	}
}
const queuedMessageSnapshotSchema = z.object(queuedMessageSnapshotShape).strict().superRefine(requireQueuedMessageContent);
const queuedMessageUpdateSchema = z.object({
	...queuedMessageSnapshotShape,
	queueId: z.number().int().positive(),
}).strict().superRefine(requireQueuedMessageContent);
const workbenchAdditionalContextActionSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("set"),
		items: z.array(additionalContextItemSchema).max(10)
	}),
	z.object({
		action: z.literal("addOrReplace"),
		item: additionalContextItemSchema
	}),
	z.object({
		action: z.literal("remove"),
		contextId: z.string().min(1).max(160)
	}),
	z.object({
		action: z.literal("pin"),
		contextId: z.string().min(1).max(160),
		pinned: z.boolean()
	}),
	z.object({
		action: z.literal("clearUnpinned")
	})
]);
const workbenchPatchParamsSchema = z
	.object({
		clientSequence: z.number().int().nonnegative().optional(),
		composer: z
			.object({
				text: z.string().max(20000).optional(),
				chatMode: z.enum(["agent", "ask", "plan", "goal"]).optional(),
				provider: providerIdSchema.optional(),
				model: z.string().min(1).optional(),
				reasoningEffort: z.string().min(1).max(32).optional(),
				additionalContext: z.array(additionalContextItemSchema).max(10).optional()
			})
			.strict()
			.optional(),
		additionalContextAction: workbenchAdditionalContextActionSchema.optional(),
		nextStepHintsAction: z.literal("clear").optional(),
		activeRun: z
			.object({
				status: z.enum(["idle", "streaming", "paused", "approval", "cancelling"]).optional(),
				requestId: z.string().min(1).optional(),
				startedAt: z.string().min(1).optional(),
				queueItemId: z.number().int().positive().optional(),
				statusCode: z.string().max(80).optional()
			})
			.strict()
			.optional()
	})
	.strict();
const usageMetricsStatusSchema = z.enum(["success", "error", "cancelled"]);
const usageMetricsSourceSchema = z.enum(["provider", "estimated", "missing"]);
const usageMetricsFiltersSchema = z
	.object({
		startAt: z.string().min(1).optional(),
		endAt: z.string().min(1).optional(),
		provider: providerIdSchema.optional(),
		model: z.string().min(1).optional(),
		sessionId: z.string().min(1).optional(),
		workspaceId: z.string().min(1).optional(),
		operation: z.string().min(1).max(120).optional(),
		status: usageMetricsStatusSchema.optional(),
		usageSource: usageMetricsSourceSchema.optional()
	})
	.strict();
const usageMetricsLogsParamsSchema = usageMetricsFiltersSchema
	.extend({
		limit: z.number().int().min(1).max(500).optional(),
		offset: z.number().int().min(0).optional()
	})
	.strict();
const usageMetricsTrendsParamsSchema = usageMetricsFiltersSchema
	.extend({
		bucket: z.enum(["hour", "day"]).optional()
	})
	.strict();
const workspaceTreeOrderIdSchema = z.string().trim().min(1).max(240);
const workspaceTreeSectionKeySchema = z.enum(["pinned", "projects", "recent"]);
const workspaceTreeOrderUpdateParamsSchema = z
	.object({
		workspaceIds: z.array(workspaceTreeOrderIdSchema).max(10_000),
		sessionIdsByWorkspace: z.record(workspaceTreeOrderIdSchema, z.array(workspaceTreeOrderIdSchema).max(100_000)),
		pinnedSessionIds: z.array(workspaceTreeOrderIdSchema).max(100_000),
		recentSessionIds: z.array(workspaceTreeOrderIdSchema).max(100_000),
		expandedSectionKeys: z.array(workspaceTreeSectionKeySchema).max(3),
		expandedWorkspaceIds: z.array(workspaceTreeOrderIdSchema).max(10_000)
	})
	.strict()
	.superRefine((value, context): void => {
		if (new Set(value.workspaceIds).size !== value.workspaceIds.length) {
			context.addIssue({
				code: "custom",
				path: ["workspaceIds"],
				message: "Workspace ids must be unique."
			});
		}
		if (new Set(value.expandedSectionKeys).size !== value.expandedSectionKeys.length) {
			context.addIssue({
				code: "custom",
				path: ["expandedSectionKeys"],
				message: "Expanded section keys must be unique."
			});
		}
		if (new Set(value.expandedWorkspaceIds).size !== value.expandedWorkspaceIds.length) {
			context.addIssue({
				code: "custom",
				path: ["expandedWorkspaceIds"],
				message: "Expanded workspace ids must be unique."
			});
		}
		const seenSessionIds: Set<string> = new Set();
		const sessionOrderGroups: Array<{
			path: Array<string>;
			sessionIds: string[];
		}> = [
			{ path: ["pinnedSessionIds"], sessionIds: value.pinnedSessionIds },
			{ path: ["recentSessionIds"], sessionIds: value.recentSessionIds },
			...Object.entries(value.sessionIdsByWorkspace).map(([workspaceId, sessionIds]) => ({
				path: ["sessionIdsByWorkspace", workspaceId],
				sessionIds
			}))
		];
		for (const { path, sessionIds } of sessionOrderGroups) {
			const localIds: Set<string> = new Set();
			for (const sessionId of sessionIds) {
				if (localIds.has(sessionId) || seenSessionIds.has(sessionId)) {
					context.addIssue({
						code: "custom",
						path,
						message: "Session ids must be unique across all workspace tree sections."
					});
					return;
				}
				localIds.add(sessionId);
				seenSessionIds.add(sessionId);
			}
		}
	});
const customMcpSecretRecordSchema = z
	.record(z.string().min(1).max(160), z.string().max(20000))
	.refine((value: Record<string, string>): boolean => Object.keys(value).length <= 64, "Too many secret entries");
const customMcpSecretUpdateRecordSchema = z
	.record(z.string().min(1).max(160), z.union([z.string().max(20000), z.null()]))
	.refine((value: Record<string, string | null>): boolean => Object.keys(value).length <= 64, "Too many secret entries");
const customMcpPlanAccessSchema = z.enum(["disabled", "read"]).optional();
const customMcpServerInputSchema = z.discriminatedUnion("transport", [
	z.object({
		name: z.string().min(1).max(80),
		description: z.string().max(300).optional(),
		transport: z.literal("stdio"),
		enabled: z.boolean().optional(),
		planAccess: customMcpPlanAccessSchema,
		command: z.string().min(1).max(300),
		args: z.array(z.string().max(1000)).max(64).optional(),
		env: customMcpSecretRecordSchema.optional(),
	}),
	z.object({
		name: z.string().min(1).max(80),
		description: z.string().max(300).optional(),
		transport: z.literal("http"),
		enabled: z.boolean().optional(),
		planAccess: customMcpPlanAccessSchema,
		url: z.string().url().max(1000),
		headers: customMcpSecretRecordSchema.optional(),
	})
]);
const customMcpServerUpdateSchema = z.discriminatedUnion("transport", [
	z.object({
		serverId: z.string().min(1),
		description: z.string().max(300).optional(),
		transport: z.literal("stdio"),
		enabled: z.boolean().optional(),
		planAccess: customMcpPlanAccessSchema,
		command: z.string().min(1).max(300),
		args: z.array(z.string().max(1000)).max(64).optional(),
		env: customMcpSecretUpdateRecordSchema.optional(),
	}).strict(),
	z.object({
		serverId: z.string().min(1),
		description: z.string().max(300).optional(),
		transport: z.literal("http"),
		enabled: z.boolean().optional(),
		planAccess: customMcpPlanAccessSchema,
		url: z.string().url().max(1000),
		headers: customMcpSecretUpdateRecordSchema.optional(),
	}).strict()
]);

const pluginSourceSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("local"),
		path: z.string().min(1).max(2000)
	}).strict(),
	z.object({
		type: z.literal("tarball"),
		path: z.string().min(1).max(2000),
		sha256: z.string().regex(/^[0-9a-f]{64}$/iu)
	}).strict(),
	z.object({
		type: z.literal("npm"),
		packageName: z.string().regex(/^(?:@?[a-z0-9][a-z0-9._-]*)(?:\/[a-z0-9][a-z0-9._-]*)?$/iu).max(160),
		version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u).max(80)
	}).strict(),
	z.object({
		type: z.literal("git"),
		url: z.string().url().max(2000),
		commit: z.string().regex(/^[0-9a-f]{7,64}$/iu)
	}).strict()
]);

export const clientRequestSchema = z.discriminatedUnion("method", [
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ping"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("backend.health"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("backend.shutdown"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("backend.update.check"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("backend.update.install"),
		params: z.object({
			version: z.string().min(1).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("usage.metrics.summary.get"),
		params: usageMetricsFiltersSchema.optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("usage.metrics.logs.list"),
		params: usageMetricsLogsParamsSchema.optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("usage.metrics.trends.get"),
		params: usageMetricsTrendsParamsSchema.optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("command.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("client.hello"),
		params: z.object({
			protocolVersion: z.literal(3),
			clientType: z.enum(["godot_editor_bridge", "godot_plugin", "studio", "studio_scheduler", "cli", "smoke", "external_mcp"]).optional(),
			clientName: z.string().min(1).max(120).optional(),
			workspaceRoot: z.string().min(1).optional(),
			workspaceId: z.string().min(1).optional(),
			godotExecutablePath: z.string().min(1).optional(),
			editorInstanceId: z.string().min(1).max(160).optional(),
			pluginVersion: z.string().min(1).max(64).optional(),
			pluginProtocolVersion: z.number().int().positive().optional(),
			studioBindingVersion: z.string().min(1).max(64).optional(),
			bridgeVersion: z.string().min(1).max(64).optional(),
			bridgeProtocolVersion: z.number().int().positive().optional(),
			godotVersion: z.string().min(1).max(64).optional(),
			capabilities: z.record(z.string().min(1), z.boolean()).optional()
		})
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("client.info"),
		params: z.object({}).optional()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("client.capabilities.update"),
		params: z.object({
			capabilities: z.object({
				browserTools: z.boolean().optional(),
				scheduledTasks: z.boolean().optional(),
				scheduledTaskReport: z.boolean().optional(),
			}).strict()
		})
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("browser.tool.result"),
		params: z
			.object({
				callId: z.string().min(1).max(160),
				ok: z.boolean(),
				result: z.record(z.string(), z.unknown()).optional(),
				error: z
					.object({
						code: z.string().min(1).max(120),
						message: z.string().min(1).max(4000),
						retryable: z.boolean()
					})
					.strict()
					.optional()
			})
			.strict()
			.superRefine((value, context): void => {
				if (value.ok && value.result === undefined)
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Successful browser tool results require result."
					});
				if (!value.ok && value.error === undefined)
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Failed browser tool results require error."
					});
			})
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.configure"),
		params: z.object({
			provider: providerIdSchema,
			apiKey: z.string().min(1),
			model: z.string().min(1).optional(),
			baseUrl: z.string().min(1).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.config.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.current.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.modelSelection.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.config.set"),
		params: z.object({
			provider: providerIdSchema,
			apiKey: z.string().min(1).nullable().optional(),
			model: z.string().min(1).optional(),
			baseUrl: z.string().min(1).max(1000).nullable().optional(),
			enabled: z.boolean().optional(),
			activate: z.boolean().optional(),
			modelRouting: providerModelRoutingSchema.optional(),
			requestOverrides: providerRequestOverridesSchema.nullable().optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.config.clear"),
		params: z.object({
			provider: providerIdSchema.optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.models.list"),
		params: z.object({
			provider: providerIdSchema.optional(),
			refresh: z.boolean().optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.models.discover"),
		params: z.object({
			provider: providerIdSchema,
			apiKey: z.string().trim().min(1).max(20_000).optional(),
			baseUrl: z.string().trim().min(1).max(1000).nullable().optional()
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.models.import"),
		params: z.object({
			provider: providerIdSchema,
			models: z.array(discoveredProviderModelSchema).max(2000)
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.models.sync"),
		params: z.object({
			provider: providerIdSchema,
			upsertModels: z.array(discoveredProviderModelSchema).max(2000),
			enableModelIds: z.array(z.string().trim().min(1).max(200)).max(2000),
			removeModelIds: z.array(z.string().trim().min(1).max(200)).max(2000)
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.custom.add"),
		params: z.object({
			displayName: z.string().trim().min(1).max(80),
			providerType: z.enum(["openai", "openai-responses", "anthropic"]),
			websiteUrl: providerWebsiteUrlSchema.nullable().optional()
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.custom.update"),
		params: z.object({
			provider: providerIdSchema,
			displayName: z.string().trim().min(1).max(80),
			providerType: z.enum(["openai", "openai-responses", "anthropic"]),
			websiteUrl: providerWebsiteUrlSchema.nullable().optional()
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.usage.get"),
		params: z.object({
			provider: providerIdSchema
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.setEnabled"),
		params: z.object({
			provider: providerIdSchema,
			enabled: z.boolean()
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.custom.remove"),
		params: z.object({
			provider: providerIdSchema
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.model.add"),
		params: z.object({
			provider: providerIdSchema,
			id: z.string().trim().min(1).max(200),
			displayName: z.string().trim().min(1).max(120),
			contextWindowTokens: z.number().int().positive().max(2_000_000_000),
			maxOutputTokens: z.number().int().positive().max(2_000_000_000),
			capabilities: editableProviderModelCapabilitiesSchema,
			reasoningEfforts: providerReasoningEffortsSchema
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.model.update"),
		params: z.object({
			provider: providerIdSchema,
			id: z.string().trim().min(1).max(200),
			displayName: z.string().trim().min(1).max(120).nullable(),
			contextWindowTokens: z.number().int().positive().max(2_000_000_000).nullable(),
			maxOutputTokens: z.number().int().positive().max(2_000_000_000).nullable(),
			capabilities: editableProviderModelCapabilityOverridesSchema,
			reasoningEfforts: providerReasoningEffortsSchema.nullable()
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ai.chat"),
		params: aiChatParamsSchema,
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.run.retry"),
		params: z.object({
			runId: z.string().min(1)
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.goal.current"),
		params: z.object({ sessionId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.goal.pause"),
		params: z.object({ goalId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.goal.resume"),
		params: z.object({ goalId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.goal.cancel"),
		params: z.object({ goalId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.goal.dismiss"),
		params: z.object({ goalId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.goal.extendBudget"),
		params: z.object({
			goalId: z.string().min(1),
			additionalCycles: z.number().int().min(0).max(100),
			additionalTokens: z.number().int().min(0).max(10_000_000),
			additionalActiveMinutes: z.number().int().min(0).max(10_080)
		}).strict().refine((value): boolean => (
			value.additionalCycles > 0 || value.additionalTokens > 0 || value.additionalActiveMinutes > 0
		), "At least one budget increase is required.")
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.goal.rollback.preview"),
		params: z.object({ goalId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("agent.goal.rollback.apply"),
		params: z.object({ goalId: z.string().min(1), fingerprint: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ai.next_step_hints"),
		params: z.object({
			sessionId: z.string().min(1).optional(),
			anchorRequestId: z.string().min(1).optional(),
			trigger: z.enum(["done", "paused"]).optional(),
			maxHints: z.number().int().min(1).max(5).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ai.cancel"),
		params: z.object({
			requestId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ai.toolBudget.continue"),
		params: z.object({
			budgetId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ai.toolBudget.stop"),
		params: z.object({
			budgetId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("prompt.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("userPrompt.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("userPrompt.set"),
		params: z.object({
			prompt: z.string().max(20000).optional(),
			gitCommitPrompt: z.string().max(20000).optional(),
			commandReviewPrompt: z.string().max(20000).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("generalSettings.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("generalSettings.update"),
		params: z.object({
			nextStepHintsEnabled: z.boolean().optional(),
			godotExecutablePath: z.string().min(1).nullable().optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.branches.list"),
		params: z.object({
			refresh: z.boolean().optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.install"),
		params: z.object({
			branch: z.string().min(1).max(120),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.importLocal"),
		params: z.object({
			branch: z.string().min(1).max(120),
			sourcePath: z.string().min(1).max(32_768),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.update"),
		params: z.object({
			documentId: z.string().min(1).max(80),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.health.check"),
		params: z.object({
			documentId: z.string().min(1).max(80),
			deep: z.boolean().optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.repair"),
		params: z.object({
			documentId: z.string().min(1).max(80),
			allowNetwork: z.boolean(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.remove"),
		params: z.object({
			documentId: z.string().min(1).max(80),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.setEnabled"),
		params: z.object({
			enabled: z.boolean(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.job.get"),
		params: z.object({
			jobId: z.string().min(1).max(100),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("godotDocumentation.job.cancel"),
		params: z.object({
			jobId: z.string().min(1).max(100),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("webSearchSettings.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("webSearchSettings.update"),
		params: z.object({
			enabled: z.boolean().optional(),
			provider: providerIdSchema.optional(),
			model: z.string().min(1).optional(),
			maxResults: z.number().min(0).max(100).optional(),
			maxKeywords: z.number().min(1).max(3).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.list"),
		params: skillTargetSchema.optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.get"),
		params: z.object({
			ref: skillRefSchema,
			workspaceId: z.string().min(1).max(200).optional(),
			sourceFolderId: z.string().min(1).max(200).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.set_enabled"),
		params: z.object({
			ref: skillRefSchema,
			enabled: z.boolean(),
			workspaceId: z.string().min(1).max(200).optional(),
			sourceFolderId: z.string().min(1).max(200).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.update"),
		params: z.object({
			ref: skillRefSchema,
			content: z.string().min(1).max(65536),
			workspaceId: z.string().min(1).max(200).optional(),
			sourceFolderId: z.string().min(1).max(200).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.remove"),
		params: z.object({
			ref: skillRefSchema,
			workspaceId: z.string().min(1).max(200).optional(),
			sourceFolderId: z.string().min(1).max(200).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.install"),
		params: z.object({
			source: z.enum(["personal", "project"]),
			kind: z.enum(["folder", "zip"]),
			path: z.string().min(1),
			workspaceId: z.string().min(1).max(200).optional(),
			sourceFolderId: z.string().min(1).max(200).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.reload"),
		params: skillTargetSchema.optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("scheduled-task.tool.result"),
		params: z.object({
			callId: z.string().min(1).max(160),
			ok: z.boolean(),
			result: z.record(z.string(), z.unknown()).optional(),
			error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(4000), retryable: z.boolean() }).strict().optional(),
		}).strict().superRefine((value, context): void => {
			if (value.ok && value.result === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "Successful scheduled task tool results require result." });
			if (!value.ok && value.error === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "Failed scheduled task tool results require error." });
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plugin.catalog.list"),
		params: z.object({}).strict().optional()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plugin.scan"),
		params: z.object({ source: pluginSourceSchema }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plugin.install"),
		params: z.object({ source: pluginSourceSchema }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plugin.remove"),
		params: z.object({ pluginId: z.string().min(1).max(240) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plugin.trust.update"),
		params: z.object({
			pluginId: z.string().min(1).max(240),
			fingerprint: z.string().length(64),
			status: z.enum(["trusted", "disabled"])
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plugin.profile.get"),
		params: z.object({}).strict().optional()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plugin.profile.update"),
		params: z.object({ pluginIds: z.array(z.string().min(1).max(240)).max(256) }).strict()
	}),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.update.install"), params: z.object({ pluginId: z.string().min(1).max(240), expectedFingerprint: z.string().length(64), source: pluginSourceSchema }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.versions.list"), params: z.object({ pluginId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.rollback"), params: z.object({ pluginId: z.string().min(1).max(240), fingerprint: z.string().length(64) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.runtime.list"), params: z.object({}).strict().optional() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.runtime.restart"), params: z.object({ pluginId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.runtime.disable"), params: z.object({ pluginId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.runtime.clear_quarantine"), params: z.object({ pluginId: z.string().min(1).max(240), sessionId: z.string().min(1).max(240).optional() }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.runtime.logs.list"), params: z.object({ pluginId: z.string().min(1).max(240).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().optional() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.runtime.dependencies.install"), params: z.object({ pluginId: z.string().min(1).max(240), allowNetwork: z.boolean() }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.harness.config.get"), params: z.object({}).strict().optional() }),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("plugin.harness.config.update"),
		params: z.object({
			expectedRevision: z.string().length(64),
			enabled: z.boolean(),
			executablePath: z.string().trim().min(1).max(4096).nullable(),
			sourceRoot: z.string().trim().min(1).max(4096).nullable(),
			launchMode: z.enum(["installed", "source"])
		}).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("plugin.harness.detect"),
		params: z.object({
			// Detection may inspect the values currently being edited in Studio without persisting them.
			draft: z.object({
				enabled: z.boolean(),
				executablePath: z.string().trim().max(4096).nullable(),
				sourceRoot: z.string().trim().max(4096).nullable(),
				launchMode: z.enum(["installed", "source"]),
			}).strict().optional(),
		}).strict().optional(),
	}),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.harness.preview"), params: z.object({ pluginId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.harness.runtime.status"), params: z.object({ pluginId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.extensions.registry.get"), params: z.object({}).strict().optional() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.command.resolve"), params: z.object({ command: z.string().min(1).max(160), args: z.record(z.string().min(1).max(64), z.unknown()).optional() }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.context-provider.list"), params: z.object({}).strict().optional() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.context-provider.resolve"), params: z.object({ providerId: z.string().min(1).max(240), args: z.record(z.string().min(1).max(64), z.unknown()).optional(), scopes: z.array(z.enum(["workspace", "browser", "plugin"])).max(3).optional() }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.ui.panel.create"), params: z.object({ panelId: z.string().min(1).max(240), location: z.enum(["side", "bottom"]), state: z.record(z.string(), z.unknown()).optional() }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.ui.panel.action"), params: z.object({ panelId: z.string().min(1).max(240), action: z.string().min(1).max(160), args: z.record(z.string(), z.unknown()).optional() }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.ui.panel.state.get"), params: z.object({ panelId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.ui.panel.state.update"), params: z.object({ panelId: z.string().min(1).max(240), state: z.record(z.string(), z.unknown()) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.settings.state.get"), params: z.object({ settingsId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.settings.state.update"), params: z.object({ settingsId: z.string().min(1).max(240), state: z.record(z.string(), z.unknown()) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.browser.invoke"), params: z.object({ pluginId: z.string().min(1).max(240), action: z.enum(["navigate", "observe", "navigation", "scroll", "wait", "text", "screenshot", "click", "type", "select", "download", "tabs"]), args: z.record(z.string(), z.unknown()).optional() }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.language-service.start"), params: z.object({ serviceId: z.string().min(1).max(240), workspaceRoot: z.string().min(1).max(4096) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.language-service.stop"), params: z.object({ serviceId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.events.publish"), params: z.object({ pluginId: z.string().min(1).max(240), topic: z.string().min(1).max(240), payload: z.record(z.string(), z.unknown()) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.events.subscribe"), params: z.object({ pluginId: z.string().min(1).max(240), topic: z.string().min(1).max(240), cursor: z.string().max(160).optional() }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.events.ack"), params: z.object({ pluginId: z.string().min(1).max(240), topic: z.string().min(1).max(240), cursor: z.string().min(1).max(160) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.timeline.append"), params: z.object({ pluginId: z.string().min(1).max(240), partType: z.string().min(1).max(240), title: z.string().max(200).optional(), summary: z.string().max(1200).optional(), icon: z.string().max(80).optional(), status: z.enum(["info", "success", "warning", "error"]).optional(), data: z.record(z.string(), z.unknown()) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.harness.convert.preview"), params: z.object({ pluginId: z.string().min(1).max(240) }).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("plugin.harness.convert.activate"), params: z.object({ pluginId: z.string().min(1).max(240), expectedFingerprint: z.string().length(64) }).strict() }),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.reset"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.info"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.create"),
		params: z.object({
			title: z.string().min(1),
			workspaceId: z.string().min(1).nullable().optional(),
			temporary: z.boolean().optional(),
		}).merge(sessionUiMetadataParamsSchema),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.fork"),
		params: z.object({
			sourceSessionId: z.string().min(1),
			sourceRequestId: z.string().min(1).optional(),
			title: z.string().trim().min(1).max(200),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.worktree.create"),
		params: z
			.object({
				sessionId: z.string().min(1),
				workspaceId: z.string().min(1),
				sources: z.record(z.string().min(1), z.object({
					startingState: z.discriminatedUnion("type", [
						z.object({ type: z.literal("head") }).strict(),
						z.object({ type: z.literal("branch"), ref: z.string().min(1).max(500) }).strict(),
						z.object({ type: z.literal("working-tree") }).strict()
					]).optional(),
					environmentId: z.string().min(1).max(64).nullable().optional(),
					environmentFingerprint: z.string().length(64).nullable().optional()
				}).strict()).optional()
			})
			.strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("session.worktree.operation.get"),
		params: z.object({ operationId: z.string().uuid() }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("session.worktree.operation.cancel"),
		params: z.object({ operationId: z.string().uuid() }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("session.worktree.setup.retry"),
		params: z.object({ sessionId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("session.worktree.setup.skip"),
		params: z.object({ sessionId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("session.worktree.handoff.preview"),
		params: z.object({ sessionId: z.string().min(1), target: z.enum(["local", "worktree"]), branchBySource: z.record(z.string(), z.string().min(1)).optional() }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("session.worktree.handoff.execute"),
		params: z.object({ sessionId: z.string().min(1), target: z.enum(["local", "worktree"]), branchBySource: z.record(z.string(), z.string().min(1)).optional() }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.worktree.delete"),
		params: z
			.object({
				sessionId: z.string().min(1)
			})
			.strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("environment.config.get"),
		params: z.object({ workspaceId: z.string().min(1), sourceFolderId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("environment.config.update"),
		params: z.object({ workspaceId: z.string().min(1), sourceFolderId: z.string().min(1), content: z.string().max(262144), expectedRevision: z.string().length(64) }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("environment.trust.update"),
		params: z.object({ workspaceId: z.string().min(1), sourceFolderId: z.string().min(1), fingerprint: z.string().length(64), status: z.enum(["trusted", "network-approved", "disabled"]) }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("environment.actions.list"),
		params: z.object({ workspaceId: z.string().min(1), sourceFolderId: z.string().min(1), environmentId: z.string().min(1).optional() }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.open"),
		params: z.object({
			sessionId: z.string().min(1),
			limit: z.number().int().positive().max(500).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.subscribe"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.unsubscribe"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.editor.bind"),
		params: z.object({
			sessionId: z.string().min(1).optional(),
			editorInstanceId: z.string().min(1).max(160),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.timeline"),
		params: z.object({
			sessionId: z.string().min(1).optional(),
			beforeOffset: z.number().int().min(0).optional(),
			afterOffset: z.number().int().min(0).optional(),
			limit: z.number().int().positive().max(500).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.timeline.search.index"),
		params: z.object({
			sessionId: z.string().min(1),
			afterOffset: z.number().int().min(0).optional(),
			limit: z.number().int().positive().max(500).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.timeline.search.start"),
		params: z.object({
			sessionId: z.string().min(1),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.timeline.search.page"),
		params: z.object({
			searchId: z.string().min(1),
			afterOffset: z.number().int().min(0).optional(),
			limit: z.number().int().positive().max(500).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.timeline.search.cancel"),
		params: z.object({
			searchId: z.string().min(1),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.selectionAsk.list"),
		params: z.object({
			sessionId: z.string().min(1)
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.selectionAsk.get"),
		params: z.object({
			sessionId: z.string().min(1),
			threadId: z.string().min(1),
			beforeSequence: z.number().int().positive().optional(),
			limit: z.number().int().min(1).max(200).optional()
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.selectionAsk.create"),
		params: z.object({
			sessionId: z.string().min(1),
			anchor: messageTextAnchorSchema,
			locale: z.enum(["zh-CN", "en-US"]).optional()
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.selectionAsk.send"),
		params: z.object({
			sessionId: z.string().min(1),
			threadId: z.string().min(1),
			message: z.string().trim().min(1).max(20000)
		}).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.integrity.check"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.selectionAsk.cancel"),
		params: z.object({
			sessionId: z.string().min(1),
			threadId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.selectionAsk.delete"),
		params: z.object({
			sessionId: z.string().min(1),
			threadId: z.string().min(1),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.selectionAsk.deleteAll"),
		params: z.object({
			sessionId: z.string().min(1),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.browser.snapshot"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.archive"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.archived.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.archived.restore"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.archived.delete"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.export"),
		params: z.object({
			sessionId: z.string().min(1),
			destinationPath: z.string().min(1).max(32_767),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.import"),
		params: z.object({
			sourcePath: z.string().min(1).max(32_767),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.save"),
		params: sessionUiMetadataParamsSchema.optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.model.set"),
		params: z.object({
			provider: providerIdSchema,
			model: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.delete"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.rename"),
		params: z.object({
			sessionId: z.string().min(1),
			title: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.workspace.move"),
		params: z.object({
			sessionId: z.string().min(1),
			workspaceId: z.string().min(1),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.compress"),
		params: z.object({
			keepRecent: z.number().int().min(2).max(50).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.summary"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.overview.get"),
		params: z.object({
			sessionId: z.string().min(1),
			planLimit: z.number().int().min(0).max(100).optional(),
			sourceLimit: z.number().int().min(0).max(100).optional(),
			includePlanPreviews: z.boolean().optional(),
			includeSourceImages: z.boolean().optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.context.estimate"),
		params: z.object({
			message: z.string().max(20000).optional(),
			mode: z.enum(["agent", "ask", "plan", "goal"]).optional(),
			provider: providerIdSchema.optional(),
			model: z.string().min(1).optional(),
			additionalContext: z.array(additionalContextItemSchema).max(10).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.workflow.todo.dismiss"),
		params: z.object({
			workflowId: z.string().min(1).optional(),
			runId: z.string().min(1).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.workbench.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.workbench.patch"),
		params: workbenchPatchParamsSchema,
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.guide.add"),
		params: z.object({
			clientGuideId: z.string().min(1).max(128),
			text: guideTextSchema,
			anchorRequestId: z.string().min(1).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.guide.update"),
		params: z.object({
			guideId: z.string().min(1),
			text: guideTextSchema,
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.guide.delete"),
		params: z.object({
			guideId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.guide.reorder"),
		params: z.object({
			guideIds: z.array(z.string().min(1)).max(64),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("message.queue.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("message.queue.add"),
		params: queuedMessageSnapshotSchema,
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("message.queue.update"),
		params: queuedMessageUpdateSchema,
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("message.queue.remove"),
		params: z.object({
			queueId: z.number().int().positive(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("message.queue.status"),
		params: z.object({
			queueId: z.number().int().positive(),
			status: z.enum(["pending", "sending", "approval", "failed", "cancelled", "rejected"]),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("message.queue.reorder"),
		params: z.object({
			queueIds: z.array(z.number().int().positive()).max(128),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.listTools"),
		params: z.object({
			serverId: z.string().optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.callTool"),
		params: z.object({
			serverId: z.string().optional(),
			name: z.string(),
			args: z.record(z.string(), z.unknown()).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.listResources"),
		params: z.object({
			serverId: z.string().optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.readResource"),
		params: z.object({
			serverId: z.string().optional(),
			uri: z.string(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.config.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.config.add"),
		params: customMcpServerInputSchema,
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.config.update"),
		params: customMcpServerUpdateSchema,
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.config.remove"),
		params: z.object({
			serverId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.config.setEnabled"),
		params: z.object({
			serverId: z.string().min(1),
			enabled: z.boolean(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("tool.catalog.list"),
		params: z.object({
			mode: z.enum(["minimal", "lite", "full"]).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("tool.execute"),
		params: z.object({
			mode: z.enum(["minimal", "lite", "full"]).optional(),
			toolName: z.string().min(1),
			args: z.record(z.string(), z.unknown()).optional(),
			toolCallId: z.string().min(1).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("fileChange.create"),
		params: z.object({
			relativePath: z.string().min(1),
			content: z.string(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("fileChange.overwrite"),
		params: z.object({
			relativePath: z.string().min(1),
			content: z.string(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("fileChange.delete"),
		params: z.object({
			relativePath: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("fileEdit.batch.get"),
		params: z.object({
			sessionId: z.string().min(1),
			batchId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("attachment.image.save"),
		params: z.object({
			sessionId: z.string().min(1),
			mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES as [string, ...string[]]),
			dataUrl: z.string().min(1).max(MAX_IMAGE_DATA_URL_CHARS),
			byteSize: z.number().int().positive().max(MAX_IMAGE_BYTES),
			width: z.number().int().positive().optional(),
			height: z.number().int().positive().optional(),
			title: z.string().min(1).max(200).optional(),
			sourcePath: z.string().min(1).max(1000).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("attachment.image.generated.get"),
		params: z.object({
			sessionId: z.string().min(1),
			imageId: z.string().min(1).max(160),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plan.get"),
		params: z.object({
			sessionId: z.string().min(1).optional(),
			planId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plan.clarify"),
		params: z.object({
			planId: z.string().min(1),
			reply: z.string().min(1).max(8000).optional(),
			/** A structured decision to continue planning without this answer. */
			skip: z.literal(true).optional(),
		}).superRefine((value, context): void => {
			if (value.skip === true || value.reply !== undefined) {
				return;
			}
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["reply"],
				message: "plan.clarify requires either reply or skip: true."
			});
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("hooks.config.sources.list"),
		params: z.object({ workspaceId: z.string().min(1).max(200).optional() }).strict().optional()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("hooks.config.get"),
		params: hookConfigTargetSchema
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("hooks.config.update"),
		params: z.intersection(hookConfigTargetSchema, z.object({
			content: z.string().max(512 * 1024),
			expectedRevision: z.string().length(64)
		}).strict())
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("hooks.trust.update"),
		params: z.intersection(hookConfigTargetSchema, z.object({
			fingerprint: z.string().length(64),
			status: z.enum(["trusted", "disabled"])
		}).strict())
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("hooks.runs.list"),
		params: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict().optional()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plan.revise"),
		params: z.object({
			planId: z.string().min(1),
			feedback: z.string().min(1).max(12000),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("plan.approve"),
		params: z.object({
			planId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("approval.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("approval.mode.set"),
		params: z.object({
			mode: z.enum(["manual", "auto-safe", "full-trust"]),
			confirmationText: z.string().optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("approval.approve"),
		params: z.object({
			approvalId: z.string().min(1),
			consentText: z.string().optional(),
			enableAutoSafe: z.boolean().optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("approval.reject"),
		params: z.object({
			approvalId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("environment.configure"),
		params: z.object({
			godotExecutablePath: z.string().min(1).optional(),
			godotProjectPath: z.string().min(1).optional(),
			sessionId: z.string().min(1).nullable().optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("editor.context.update"),
		params: z.record(z.string(), z.unknown()),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("editor.heartbeat"),
		params: z.object({
			editorInstanceId: z.string().min(1).max(160),
			workspaceRoot: z.string().min(1),
			contextRevision: z.number().int().nonnegative(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("editor.instances.list"),
		params: z.object({
			workspaceId: z.string().min(1).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("editor.tool.result"),
		params: z.object({
			callId: z.string().min(1),
			ok: z.boolean(),
			result: z.unknown().optional(),
			error: z.object({
				code: z.string().min(1).max(160),
				message: z.string().min(1).max(8_000),
				retryable: z.boolean(),
				details: z.record(z.string(), z.unknown()).optional(),
			}).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.tree.order.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.tree.order.update"),
		params: workspaceTreeOrderUpdateParamsSchema,
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.select"),
		params: z.object({
			workspaceId: z.string().min(1),
			sessionId: z.string().min(1).nullable().optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.delete"),
		params: z.object({
			workspaceId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.info"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.worktree.eligibility.get"),
		params: z
			.object({
				workspaceId: z.string().min(1)
			})
			.strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("workspace.worktree.status.list"), params: z.object({}).strict()
	}),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("workspace.worktree.settings.get"), params: z.object({}).strict() }),
	z.object({ type: z.literal("request"), id: z.string(), method: z.literal("workspace.worktree.settings.update"), params: z.object({ rootDirectory: z.union([z.string().trim().min(1).max(4096), z.null()]).optional(), fetchBeforeCreate: z.boolean().optional(), autoDeleteManaged: z.boolean().optional(), autoDeleteLimit: z.number().int().min(1).max(100).optional() }).strict() }),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("workspace.worktree.repair"), params: z.object({ sessionId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("workspace.worktree.permanent.create"),
		params: z.object({ workspaceId: z.string().min(1), name: z.string().trim().min(1).max(100), sources: z.record(z.string(), z.object({ startingState: z.discriminatedUnion("type", [z.object({ type: z.literal("head") }).strict(), z.object({ type: z.literal("branch"), ref: z.string().min(1).max(500) }).strict()]), environmentId: z.string().min(1).nullable().optional() }).strict()).optional() }).strict()
	}),
	z.object({
		type: z.literal("request"), id: z.string(), method: z.literal("workspace.worktree.permanent.delete"), params: z.object({ workspaceId: z.string().min(1) }).strict()
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.diff.get"),
		params: z.object({
			workspaceId: z.string().min(1),
			sourceFolderId: z.string().min(1).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.timeline.index"),
		params: z.object({
			sessionId: z.string().min(1).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.pin.set"),
		params: z.object({
			sessionId: z.string().min(1),
			pinned: z.boolean(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.update"),
		params: z.object({
			workspaceId: z.string().min(1),
			name: z.string().max(120),
			icon: z.number().int().min(0).max(6),
			color: z.number().int().min(0).max(7),
			sourceFolders: z.array(z.object({
				id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/u).optional(),
				path: z.string().min(1).max(4000),
			}).strict()).min(1).max(32),
			primarySourceFolderId: z.string().min(1),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("attachment.image.get"),
		params: z.object({
			attachmentId: z.string().min(1).max(160),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("attachment.text.save"),
		params: z.object({
			sessionId: z.string().min(1),
			content: z.string().min(1).max(1_000_000),
			title: z.string().min(1).max(200).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("attachment.text.get"),
		params: z.object({
			attachmentId: z.string().min(1).max(160),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.diff.summary.get"),
		params: z.object({
			workspaceId: z.string().min(1),
			sourceFolderId: z.string().min(1).optional(),
			cursor: z.number().int().nonnegative().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.diff.file.get"),
		params: z.object({
			workspaceId: z.string().min(1),
			sourceFolderId: z.string().min(1).optional(),
			path: z.string().min(1).max(1000),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.commit.message.generate"),
		params: z.object({
			workspaceId: z.string().min(1),
			sourceFolderId: z.string().min(1).optional(),
			includeUnstagedChanges: z.boolean(),
			provider: providerIdSchema.optional(),
			model: z.string().min(1).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.commitOrPush"),
		params: z.object({
			workspaceId: z.string().min(1),
			sourceFolderId: z.string().min(1).optional(),
			action: z.enum(["commit", "push", "commit_and_push"]),
			message: z.string().max(20000).optional(),
			includeUnstagedChanges: z.boolean(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.branches.list"),
		params: z.object({
			workspaceId: z.string().min(1),
			sourceFolderId: z.string().min(1).optional(),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.branch.checkout"),
		params: z.object({
			workspaceId: z.string().min(1),
			sourceFolderId: z.string().min(1).optional(),
			branchName: z.string().min(1).max(240),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.branch.create"),
		params: z.object({
			workspaceId: z.string().min(1),
			sourceFolderId: z.string().min(1).optional(),
			branchName: z.string().min(1).max(240),
			startPoint: z.string().min(1).max(240).optional(),
		}).strict(),
	})
]);

// WebSocket 边界使用该 envelope；内部 handler 继续接收不含传输字段的 ClientRequest。
export const clientRequestEnvelopeSchema = z.intersection(
	z.object({
		protocolVersion: z.literal(3)
	}),
	clientRequestSchema
);

export const serverResponseSchema = z.discriminatedUnion("ok", [
	z.object({
		type: z.literal("response"),
		id: z.string(),
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.object({
		type: z.literal("response"),
		id: z.string(),
		ok: z.literal(false),
		error: z.object({
			code: z.string(),
			message: z.string(),
		}),
	}),
]);
