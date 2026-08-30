import { z } from "zod";
import { computerIdSchema } from "./computer-observation.js";

export const computerOverlayPreviewActionSchema = z.enum(["running", "paused", "click", "stop"]);
export const computerOverlayPreviewSchema = z.object({
	connectionId: computerIdSchema,
	sessionId: computerIdSchema,
	requestId: computerIdSchema,
	action: computerOverlayPreviewActionSchema,
}).strict();
export type ComputerOverlayPreview = z.infer<typeof computerOverlayPreviewSchema>;
