import { z } from "zod";

export const COMPUTER_GROUNDING_MAX_BYTES = 16 * 1024;
export const COMPUTER_GROUNDINGS_PER_FRAME = 10;
export const computerUiaActionSchema = z.enum([
  "uia_invoke", "uia_toggle", "uia_select", "uia_set_value", "uia_scroll", "uia_expand_collapse",
]);
export type ComputerUiaAction = z.infer<typeof computerUiaActionSchema>;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/u);
export const computerGroundingBoxSchema = z.object({
  x: z.number().finite().min(0), y: z.number().finite().min(0),
  width: z.number().finite().positive(), height: z.number().finite().positive(),
}).strict();
export const computerLocateArgsSchema = z.object({
  observationId: id, target: z.string().trim().min(1).max(2000),
  uiaAction: computerUiaActionSchema.optional(),
}).strict();
export type ComputerLocateArgs = z.infer<typeof computerLocateArgsSchema>;
export const computerVisualGroundingSchema = z.object({
  coordinateSpace: z.literal("image_pixels"),
  candidates: z.array(z.object({
    description: z.string().trim().min(1).max(1000), box: computerGroundingBoxSchema,
  }).strict()).max(5),
}).strict();
export type ComputerVisualGrounding = z.infer<typeof computerVisualGroundingSchema>;
const candidateSchema = z.object({
  description: z.string().max(1000), box: computerGroundingBoxSchema,
  status: z.enum(["matched", "ambiguous", "visual_only"]),
  nodeId: id.optional(), supportedActions: z.array(computerUiaActionSchema).max(6).optional(),
}).strict().refine(v => v.status === "matched"
  ? v.nodeId !== undefined && (v.supportedActions?.length ?? 0) > 0
  : v.nodeId === undefined && v.supportedActions === undefined);
export const computerGroundingResultSchema = z.object({
  groundingId: id, observationId: id, generation: z.number().int().nonnegative(),
  target: z.string().max(2000), uiaAction: computerUiaActionSchema,
  coordinateSpace: z.literal("image_pixels"),
  status: z.enum(["matched", "ambiguous", "visual_only", "not_found"]),
  candidates: z.array(candidateSchema).max(5),
  provider: z.string().min(1).max(200), model: z.string().min(1).max(300),
  durationMs: z.number().finite().nonnegative(), untrustedEvidence: z.literal(true),
}).strict().superRefine((v, ctx) => {
  const expected = v.candidates.length === 0 ? "not_found"
    : v.candidates.length > 1 ? "ambiguous" : v.candidates[0]!.status;
  if (v.status !== expected) ctx.addIssue({ code: "custom", message: "Inconsistent grounding status" });
});
export type ComputerGroundingResult = z.infer<typeof computerGroundingResultSchema>;
export const computerGroundingValidateArgsSchema = z.object({
  observationId: id, generation: z.number().int().nonnegative(),
}).strict();
export const computerGroundingValidationSchema = computerGroundingValidateArgsSchema.extend({ valid: z.literal(true) });
