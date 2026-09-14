import { z } from "zod";

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const executableSchema = z.object({
        fileName: z.string().regex(/^[A-Za-z0-9._-]+$/u),
        size: z.number().int().positive(),
        sha256: sha256Schema
});

const sandboxHelperSchema = z.object({
        fileName: z.literal("daedalus-windows-sandbox-helper.exe"),
        size: z.number().int().positive(),
        sha256: sha256Schema
});

const platformSchema = z.enum(["win32", "linux"]);

const payloadManifestSchema = z.object({
        schemaVersion: z.literal(1),
        version: semverSchema,
        buildId: z.string().min(1),
        platform: platformSchema,
        arch: z.literal("x64"),
        nodeVersion: z.string().min(1),
        protocolVersion: z.number().int().positive(),
        minBridgeProtocolVersion: z.number().int().positive(),
        maxBridgeProtocolVersion: z.number().int().positive(),
        minStudioVersion: semverSchema,
        publishedAt: z.string().datetime(),
        authenticode: z.enum(["signed", "unsigned"]),
        executable: executableSchema,
        sandboxHelper: sandboxHelperSchema.nullable().default(null)
});

export const backendPayloadManifestV1Schema = payloadManifestSchema;

const releaseManifestSchema = payloadManifestSchema.extend({
        archive: z.object({
                fileName: z.string().regex(/^daedalus-backend-(win32|linux)-x64\.zip$/u),
                size: z.number().int().positive(),
                sha256: sha256Schema
        }),
        payloadManifestSha256: sha256Schema
});

export const backendReleaseManifestV1Schema = releaseManifestSchema;

export type BackendPayloadManifestV1 = z.infer<typeof payloadManifestSchema>;
export type BackendReleaseManifestV1 = z.infer<typeof releaseManifestSchema>;

function assertPlatformFileNames(manifest: BackendPayloadManifestV1, archiveFileName?: string): void {
        const expectedExecutableName: string = manifest.platform === "win32"
                ? "daedalus-backend.exe"
                : "daedalus-backend";
        if (manifest.executable.fileName !== expectedExecutableName) {
                throw new Error(`Backend executable name must be ${expectedExecutableName} for ${manifest.platform}.`);
        }
        if (manifest.platform === "win32") {
                if (manifest.sandboxHelper === null) {
                        throw new Error("Windows backend manifests must include a sandbox helper.");
                }
        } else if (manifest.sandboxHelper !== null) {
                throw new Error("Linux backend manifests must not include a Windows sandbox helper.");
        }
        if (archiveFileName !== undefined && archiveFileName !== `daedalus-backend-${manifest.platform}-x64.zip`) {
                throw new Error(`Backend archive name does not match platform ${manifest.platform}.`);
        }
}

export function parseBackendPayloadManifest(value: unknown): BackendPayloadManifestV1 {
        const manifest: BackendPayloadManifestV1 = payloadManifestSchema.parse(value);
        assertPlatformFileNames(manifest);
        return manifest;
}

export function parseBackendReleaseManifest(value: unknown): BackendReleaseManifestV1 {
        const manifest: BackendReleaseManifestV1 = releaseManifestSchema.parse(value);
        assertPlatformFileNames(manifest, manifest.archive.fileName);
        return manifest;
}
