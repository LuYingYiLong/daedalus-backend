import { z } from "zod";

export const mascotPreviewStatusSchema = z.enum(["idle", "thinking", "executing", "awaiting_approval", "completed", "failed", "sleeping", "disconnected", "auto"]);
export const mascotPreviewSchema = z.object({
	requestId: z.string().min(1),
	sessionId: z.string().min(1),
	status: mascotPreviewStatusSchema,
}).strict();
export type MascotPreview = z.infer<typeof mascotPreviewSchema>;
