import type { AdditionalContextItem } from "../../protocol/types.js";
import type { ProviderChatOptions } from "../../providers/provider-types.js";
import { resolveImageInspection } from "../../providers/tool-image-reference.js";
import { routeToolImageExecutionResult } from "../../providers/tool-image-recognition.js";
import { saveImageAttachment } from "../../session/session-attachments.js";
import type { IdempotentToolExecutionResult } from "../../tools/tool-idempotency.js";
import type { ToolResultEnricher } from "../../tools/tool-dispatcher.js";
import type { ClientSession } from "../client-session.js";

const SCENE_VIEW_TOOL: string = "mcp_godot_editor_capture_scene_view";
const IMAGE_INSPECT_TOOL: string = "mcp_image_inspect";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getString(record: JsonRecord, key: string): string | undefined {
	const value: unknown = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getPositiveInteger(record: JsonRecord, key: string): number | undefined {
	const value: unknown = record[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseCaptureResult(content: string): JsonRecord {
	let outer: unknown;
	try {
		outer = JSON.parse(content);
	} catch {
		throw new Error("scene_view_capture_invalid_result");
	}
	if (!isRecord(outer)) {
		throw new Error("scene_view_capture_invalid_result");
	}
	return isRecord(outer.result) ? outer.result : outer;
}

export type SceneViewToolResultEnricher = {
	enricher: ToolResultEnricher;
	getCapturedAttachments: () => AdditionalContextItem[];
};

export function createSceneViewToolResultEnricher(params: {
	session: ClientSession;
	options: ProviderChatOptions;
	phaseInstruction: string;
	abortSignal?: AbortSignal | undefined;
}): SceneViewToolResultEnricher {
	const capturedAttachments: AdditionalContextItem[] = [];

	const enricher: ToolResultEnricher = async (input): Promise<IdempotentToolExecutionResult> => {
		if (input.toolName === IMAGE_INSPECT_TOOL) {
			return routeToolImageExecutionResult({
				result: input.result,
				options: params.options,
				contextText: params.phaseInstruction,
				abortSignal: params.abortSignal,
				onProgress: input.onProgress
			});
		}
		if (input.toolName !== SCENE_VIEW_TOOL) {
			return input.result;
		}
		if (params.session.sessionId === undefined) {
			throw new Error("scene_view_capture_requires_session");
		}

		const capture: JsonRecord = parseCaptureResult(input.result.content);
		const mimeType: string | undefined = getString(capture, "mimeType");
		const dataUrl: string | undefined = getString(capture, "dataUrl");
		const byteSize: number | undefined = getPositiveInteger(capture, "byteSize");
		if (mimeType !== "image/png" || dataUrl === undefined || byteSize === undefined) {
			throw new Error("scene_view_capture_invalid_image");
		}

		input.onProgress?.({
			status: "message",
			title: "Saving scene view",
			details: "Saving the current Godot editor viewport as a session image.",
			code: "scene_view.capture.started"
		});
		const view: string = getString(capture, "view") ?? "scene";
		const attachment: AdditionalContextItem = await saveImageAttachment({
			sessionId: params.session.sessionId,
			mimeType,
			dataUrl,
			byteSize,
			width: getPositiveInteger(capture, "width"),
			height: getPositiveInteger(capture, "height"),
			title: `Editor ${view.toUpperCase()} scene view`,
			source: "editor",
			summary: "Godot editor scene view captured for the current run."
		});
		capturedAttachments.push(attachment);
		const inspection = await resolveImageInspection({
			source: "session",
			imageId: attachment.id,
			question: "Describe the visible Godot editor scene, layout, UI hierarchy, spatial relationships, warnings, and visual problems relevant to the task."
		}, { sessionId: params.session.sessionId });
		input.onProgress?.({
			status: "success",
			title: "Scene view saved",
			details: "The screenshot is stored as a current-session attachment.",
			code: "scene_view.capture.completed"
		});
		const routeInputContent: string = JSON.stringify({
			ok: true,
			artifactRefs: [attachment.id]
		});
		const routed: IdempotentToolExecutionResult = await routeToolImageExecutionResult({
			result: {
				...input.result,
				content: routeInputContent,
				rawContentLength: routeInputContent.length,
				imageReferences: [inspection.reference]
			},
			options: params.options,
			contextText: params.phaseInstruction,
			abortSignal: params.abortSignal,
			onProgress: input.onProgress
		});
		const routedPayload: JsonRecord = JSON.parse(routed.content) as JsonRecord;
		const route: string = getString(routedPayload, "route") ?? "unavailable";
		const content: string = JSON.stringify({
			...routedPayload,
			capture: {
				status: "available",
				attachmentId: attachment.id,
				view,
				width: getPositiveInteger(capture, "width") ?? null,
				height: getPositiveInteger(capture, "height") ?? null
			},
			analysis: route === "current_model"
				? { status: "attached", provider: routedPayload.provider, model: routedPayload.model }
				: route === "image_recognition_model"
					? { status: "completed", provider: routedPayload.provider, model: routedPayload.model, observation: routedPayload.observation }
					: { status: "unavailable", reason: routedPayload.error ?? routedPayload.code }
		}, null, 2);
		return {
			...routed,
			content,
			rawContentLength: content.length
		};
	};

	return {
		enricher,
		getCapturedAttachments: (): AdditionalContextItem[] => [...capturedAttachments]
	};
}
