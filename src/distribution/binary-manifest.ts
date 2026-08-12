import { z } from "zod";

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const executableSchema = z.object({
	fileName: z.literal("daedalus-backend.exe"),
	size: z.number().int().positive(),
	sha256: sha256Schema
});

export const backendPayloadManifestV1Schema = z.object({
	schemaVersion: z.literal(1),
	version: semverSchema,
	buildId: z.string().min(1),
	platform: z.literal("win32"),
	arch: z.literal("x64"),
	nodeVersion: z.string().min(1),
	protocolVersion: z.number().int().positive(),
	minBridgeProtocolVersion: z.number().int().positive(),
	maxBridgeProtocolVersion: z.number().int().positive(),
	minStudioVersion: semverSchema,
	publishedAt: z.string().datetime(),
	authenticode: z.enum(["signed", "unsigned"]),
	executable: executableSchema
});

export const backendReleaseManifestV1Schema = backendPayloadManifestV1Schema.extend({
	archive: z.object({
		fileName: z.literal("daedalus-backend-win32-x64.zip"),
		size: z.number().int().positive(),
		sha256: sha256Schema
	}),
	payloadManifestSha256: sha256Schema
});

export type BackendPayloadManifestV1 = z.infer<typeof backendPayloadManifestV1Schema>;
export type BackendReleaseManifestV1 = z.infer<typeof backendReleaseManifestV1Schema>;

export function parseBackendReleaseManifest(value: unknown): BackendReleaseManifestV1 {
	return backendReleaseManifestV1Schema.parse(value);
}
