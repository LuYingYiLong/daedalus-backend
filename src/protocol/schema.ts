import { z } from "zod";
import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_MIME_TYPES } from "./image-attachments.js";

export const promptIdSchema = z.enum([
	"godot.assistant",
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
	.max(80)
	.regex(/^(builtin|personal|project):[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u, "Invalid skill reference.");

export const providerIdSchema = z.string()
	.min(1)
	.max(80)
	.regex(/^[a-z][a-z0-9._-]*$/u, "Provider id must be lowercase ASCII with digits, dot, underscore, or dash.");

const imageContextDataSchema = z.object({
	mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES as [string, ...string[]]),
	dataUrl: z.string().min(1).max(1_500_000).optional(),
	attachmentId: z.string().min(1).max(160).optional(),
	thumbnailDataUrl: z.string().min(1).max(1_500_000).optional(),
	byteSize: z.number().int().positive().max(MAX_IMAGE_BYTES),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional()
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

const providerModelRoutingSchema = z.object({
	imageRecognition: providerTaskModelRefSchema.nullable().optional(),
	workflowPlanner: providerTaskModelRefSchema.nullable().optional(),
	sessionTitle: providerTaskModelRefSchema.nullable().optional(),
	imageGeneration: providerTaskModelRefSchema.nullable().optional(),
	gitCommit: providerTaskModelRefSchema.nullable().optional(),
	commandReview: providerTaskModelRefSchema.nullable().optional()
});

const sessionUiMetadataParamsSchema = z.object({
	provider: providerIdSchema.optional(),
	model: z.string().min(1).optional(),
	chatMode: z.enum(["agent", "ask", "plan"]).optional(),
	approvalMode: z.enum(["manual", "auto-safe", "full-trust"]).optional(),
	workflowTodoCollapsed: z.boolean().optional()
}).strict();

export const additionalContextItemSchema = z.object({
	id: z.string().min(1).max(160),
	kind: z.enum(["editor_selection", "scene", "node", "file", "folder", "script", "script_selection", "filesystem_selection", "image", "text_attachment", "git_diff_comment"]),
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
}).superRefine((item, context): void => {
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
			message: "Image context data must contain mimeType, dataUrl, and byteSize."
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

export const aiChatParamsSchema = z.object({
	message: z.string(),
	mode: z.enum(["agent", "ask", "plan"]).optional(),
	provider: providerIdSchema.optional(),
	model: z.string().min(1).optional(),
	promptId: promptIdSchema.optional(),
	skillRefs: z.array(skillRefSchema).max(4).optional(),
	systemPrompt: z.string().optional(),
	retryFromRequestId: z.string().min(1).optional(),
	additionalContext: z.array(additionalContextItemSchema).max(32).optional(),
	options: z.object({
		temperature: z.number().min(0).max(2).optional(),
		topP: z.number().min(0).max(1).optional(),
		maxTokens: z.number().int().positive().optional(),
		stop: z.union([z.string(), z.array(z.string())]).optional(),
		responseFormat: z.union([z.literal("text"), z.literal("json")]).optional(),
		stream: z.boolean().optional(),
		toolBudget: z.enum(["simple", "normal", "codegen", "project_edit"]).optional(),
		workflow: z.enum(["auto", "single", "multi_phase", "llm_planned"]).optional(),
		queueItemId: z.number().int().positive().optional(),
	}).optional()
});

const guideTextSchema = z.string().min(1).max(4000);
const queuedMessageSnapshotSchema = z.object({
	text: z.string().min(1).max(20000),
	mode: z.enum(["agent", "ask", "plan"]).optional(),
	provider: providerIdSchema.optional(),
	model: z.string().min(1).optional(),
	skillRefs: z.array(skillRefSchema).max(4).optional(),
	additionalContext: z.array(additionalContextItemSchema).max(32).optional(),
}).strict();
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
const workbenchPatchParamsSchema = z.object({
	clientSequence: z.number().int().nonnegative().optional(),
	composer: z.object({
		text: z.string().max(20000).optional(),
		chatMode: z.enum(["agent", "ask", "plan"]).optional(),
		provider: providerIdSchema.optional(),
		model: z.string().min(1).optional(),
		additionalContext: z.array(additionalContextItemSchema).max(10).optional()
	}).strict().optional(),
	additionalContextAction: workbenchAdditionalContextActionSchema.optional(),
	nextStepHintsAction: z.literal("clear").optional(),
	activeRun: z.object({
		status: z.enum(["idle", "streaming", "paused", "approval", "cancelling"]).optional(),
		requestId: z.string().min(1).optional(),
		startedAt: z.string().min(1).optional(),
		queueItemId: z.number().int().positive().optional(),
		statusCode: z.string().max(80).optional()
	}).strict().optional()
}).strict();
const usageMetricsStatusSchema = z.enum(["success", "error", "cancelled"]);
const usageMetricsSourceSchema = z.enum(["provider", "estimated", "missing"]);
const usageMetricsFiltersSchema = z.object({
	startAt: z.string().min(1).optional(),
	endAt: z.string().min(1).optional(),
	provider: providerIdSchema.optional(),
	model: z.string().min(1).optional(),
	sessionId: z.string().min(1).optional(),
	workspaceId: z.string().min(1).optional(),
	operation: z.string().min(1).max(120).optional(),
	status: usageMetricsStatusSchema.optional(),
	usageSource: usageMetricsSourceSchema.optional()
}).strict();
const usageMetricsLogsParamsSchema = usageMetricsFiltersSchema.extend({
	limit: z.number().int().min(1).max(500).optional(),
	offset: z.number().int().min(0).optional()
}).strict();
const usageMetricsTrendsParamsSchema = usageMetricsFiltersSchema.extend({
	bucket: z.enum(["hour", "day"]).optional()
}).strict();
const customMcpSecretRecordSchema = z.record(z.string().min(1).max(160), z.string().max(20000))
	.refine((value: Record<string, string>): boolean => Object.keys(value).length <= 64, "Too many secret entries");
const customMcpSecretUpdateRecordSchema = z.record(z.string().min(1).max(160), z.union([z.string().max(20000), z.null()]))
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
			protocolVersion: z.literal(2),
			clientType: z.enum(["godot_plugin", "studio", "cli", "smoke", "external_mcp"]).optional(),
			clientName: z.string().min(1).max(120).optional(),
			workspaceRoot: z.string().min(1).optional(),
			workspaceId: z.string().min(1).optional(),
			godotExecutablePath: z.string().min(1).optional(),
			editorInstanceId: z.string().min(1).max(160).optional(),
			capabilities: z.record(z.string().min(1), z.boolean()).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("client.info"),
		params: z.object({}).optional(),
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
			activate: z.boolean().optional(),
			modelRouting: providerModelRoutingSchema.optional(),
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
		method: z.literal("ai.chat"),
		params: aiChatParamsSchema,
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
			autoExpandTodoList: z.boolean().optional(),
			godotExecutablePath: z.string().min(1).nullable().optional(),
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
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.get"),
		params: z.object({
			ref: skillRefSchema,
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.set_enabled"),
		params: z.object({
			ref: skillRefSchema,
			enabled: z.boolean(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.update"),
		params: z.object({
			ref: skillRefSchema,
			content: z.string().min(1).max(65536),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.remove"),
		params: z.object({
			ref: skillRefSchema,
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.install"),
		params: z.object({
			source: z.enum(["personal", "project"]),
			kind: z.enum(["folder", "zip"]),
			path: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.reload"),
		params: z.object({}).optional(),
	}),
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
		}).merge(sessionUiMetadataParamsSchema),
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
		method: z.literal("session.integrity.check"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
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
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.context.estimate"),
		params: z.object({
			message: z.string().max(20000).optional(),
			mode: z.enum(["agent", "ask", "plan"]).optional(),
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
		params: queuedMessageSnapshotSchema.extend({
			queueId: z.number().int().positive(),
		}),
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
			dataUrl: z.string().min(1).max(1_500_000),
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
			reply: z.string().min(1).max(8000),
		}),
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
			error: z.string().optional(),
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
		method: z.literal("workspace.git.diff.get"),
		params: z.object({
			workspaceId: z.string().min(1),
		}),
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
		method: z.literal("workspace.git.diff.summary.get"),
		params: z.object({
			workspaceId: z.string().min(1),
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
			path: z.string().min(1).max(1000),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.commit.message.generate"),
		params: z.object({
			workspaceId: z.string().min(1),
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
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.branch.checkout"),
		params: z.object({
			workspaceId: z.string().min(1),
			branchName: z.string().min(1).max(240),
		}).strict(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.git.branch.create"),
		params: z.object({
			workspaceId: z.string().min(1),
			branchName: z.string().min(1).max(240),
			startPoint: z.string().min(1).max(240).optional(),
		}).strict(),
	})
]);

// WebSocket 边界使用该 envelope；内部 handler 继续接收不含传输字段的 ClientRequest。
export const clientRequestEnvelopeSchema = z.intersection(
	z.object({
		protocolVersion: z.literal(2)
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
