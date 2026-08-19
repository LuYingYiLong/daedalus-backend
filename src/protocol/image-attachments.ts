export const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];

export const MAX_IMAGE_ATTACHMENTS = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 128;
export const MAX_IMAGE_THUMBNAIL_DATA_URL_CHARS = 1_500_000;
