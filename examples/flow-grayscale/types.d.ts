export interface ImageArtifactRef {
	artifactId: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	sha256: string;
	width: number;
	height: number;
	byteSize: number;
	metadata: Record<string, unknown>;
}

/** 宿主代理只接受本次输入或由本次执行产生的 Artifact ID */
export interface GrayscaleExecution {
	config: Record<string, never>;
	inputs: { image: ImageArtifactRef };
	context: { flowId: string; nodeId: string; runId: string; workspaceId: string | null };
	signal: AbortSignal;
	host: { processImage(artifactId: string, operation: { kind: "grayscale" }): Promise<ImageArtifactRef> };
}

export type GrayscaleHandler = (execution: GrayscaleExecution) => Promise<{ image: ImageArtifactRef }>;
