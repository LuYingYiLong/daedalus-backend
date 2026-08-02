export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

const IMAGE_EXTENSIONS: Readonly<Record<SupportedImageMimeType, readonly string[]>> = {
	"image/png": [".png"],
	"image/jpeg": [".jpg", ".jpeg"],
	"image/webp": [".webp"],
	"image/gif": [".gif"]
};

function matches(bytes: Uint8Array, signature: readonly number[], offset: number = 0): boolean {
	if (bytes.byteLength < offset + signature.length) return false;
	return signature.every((value: number, index: number): boolean => bytes[offset + index] === value);
}

export function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
	if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (matches(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
	if (
		matches(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
		|| matches(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
	) return "image/gif";
	return null;
}

export function assertSupportedImageSignature(bytes: Uint8Array): SupportedImageMimeType {
	const detected: SupportedImageMimeType | null = detectImageMimeType(bytes);
	if (detected === null) {
		throw new Error("Image file signature is not a supported PNG, JPEG, WebP, or GIF image.");
	}
	return detected;
}

export function getImageExtensions(mimeType: SupportedImageMimeType): readonly string[] {
	return IMAGE_EXTENSIONS[mimeType];
}

export function assertImagePathMatchesMimeType(relativePath: string, mimeType: SupportedImageMimeType): void {
	const extensions: readonly string[] = getImageExtensions(mimeType);
	const lowerPath: string = relativePath.toLowerCase();
	if (!extensions.some((extension: string): boolean => lowerPath.endsWith(extension))) {
		throw new Error(
			`Image destination ${relativePath} does not match its actual ${mimeType} content. `
			+ `Use one of: ${extensions.join(", ")}.`
		);
	}
}
