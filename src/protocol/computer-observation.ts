import { z } from "zod";

export const COMPUTER_RESULT_MAX_BYTES = 8 * 1024 * 1024;
export const computerIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/u);
export const computerToolNameSchema = z.enum([
  "mcp_computer_request_access",
  "mcp_computer_observe",
  "mcp_computer_screenshot",
]);
export type ComputerToolName = z.infer<typeof computerToolNameSchema>;
const rectSchema = z
  .object({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
    width: z.number().finite().min(0).max(100000),
    height: z.number().finite().min(0).max(100000),
  })
  .strict();
const nodeSchema = z
  .object({
    id: computerIdSchema,
    parentId: computerIdSchema.nullable(),
    name: z.string().max(65536),
    automationId: z.string().max(65536),
    controlType: z.string().max(100),
    bounds: rectSchema,
    enabled: z.boolean(),
    password: z.boolean(),
  })
  .strict()
  .refine(
    (node) => !node.password || (node.name === "" && node.automationId === ""),
    "Password content is not allowed",
  );
export const computerObservationSchema = z
  .object({
    observationId: computerIdSchema,
    capturedAt: z.string().datetime(),
    uiaCapturedAt: z.string().datetime(),
    screenBounds: rectSchema,
    width: z.number().int().min(1).max(2560),
    height: z.number().int().min(1).max(2560),
    dpi: z.number().int().min(1).max(2000),
    nodes: z.array(nodeSchema).max(1000),
    texts: z
      .array(
        z
          .object({
            id: computerIdSchema,
            text: z.string().max(65536),
            confidence: z.number().finite().min(0).max(1),
            bounds: rectSchema,
          })
          .strict(),
      )
      .max(500),
    truncated: z.boolean(),
    durationMs: z.number().finite().min(0).max(20000),
    dataUrl: z
      .string()
      .max("data:image/png;base64,".length + Math.ceil((5 * 1024 * 1024) / 3) * 4)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context): void => {
    const length =
      value.nodes.reduce(
        (n, node) =>
          n +
          Buffer.byteLength(node.name + node.automationId + node.controlType),
        0,
      ) +
      value.texts.reduce((n, block) => n + Buffer.byteLength(block.text), 0);
    if (length > 65536)
      context.addIssue({
        code: "custom",
        message: "Observation text exceeds 64 KiB",
      });
    const ids = new Set<string>();
    for (const node of value.nodes) {
      if (
        ids.has(node.id) ||
        (node.parentId !== null && !ids.has(node.parentId))
      )
        context.addIssue({ code: "custom", message: "Invalid UIA hierarchy" });
      ids.add(node.id);
    }
  });
export type ComputerObservation = z.infer<typeof computerObservationSchema>;
export const computerAccessResultSchema = z
  .object({ granted: z.literal(true), accessId: computerIdSchema })
  .strict();
export const computerToolResultParamsSchema = z.discriminatedUnion("ok", [
  z
    .object({
      callId: computerIdSchema,
      ok: z.literal(true),
      result: z.union([computerAccessResultSchema, computerObservationSchema]),
    })
    .strict(),
  z
    .object({
      callId: computerIdSchema,
      ok: z.literal(false),
      error: z
        .object({
          code: z
            .string()
            .regex(/^computer_[a-z_]+$/u)
            .max(120),
          message: z.string().max(1000),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);
export type ComputerToolResultParams = z.infer<
  typeof computerToolResultParamsSchema
>;
export const computerArgsSchemas = {
  mcp_computer_request_access: z
    .object({ reason: z.string().trim().min(1).max(2000) })
    .strict(),
  mcp_computer_observe: z.object({}).strict(),
  mcp_computer_screenshot: z
    .object({ observationId: computerIdSchema })
    .strict(),
} as const;
