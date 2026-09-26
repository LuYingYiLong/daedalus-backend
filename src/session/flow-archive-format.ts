import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

export const FLOW_ARCHIVE_MAGIC = Buffer.from("DAEDALUS-FLOW-3\0", "ascii");
export const FLOW_ARCHIVE_HEADER_BYTES = FLOW_ARCHIVE_MAGIC.byteLength + 8;
export const MAX_FLOW_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FLOW_MANIFEST_BYTES = 128 * 1024 * 1024;
export const MAX_FLOW_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_FLOW_ARCHIVE_ARTIFACTS = 10_000;
const CHUNK_BYTES = 1024 * 1024;

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const result = await handle.write(bytes, offset, bytes.byteLength - offset);
		if (result.bytesWritten <= 0) throw new Error("Flow archive write stopped unexpectedly.");
		offset += result.bytesWritten;
	}
}

export async function appendVerifiedFile(handle: FileHandle, source: string, expectedSize: number, expectedSha256?: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const hash: Hash = createHash("sha256");
	let size = 0;
	for await (const value of createReadStream(source, { highWaterMark: CHUNK_BYTES, signal })) {
		signal?.throwIfAborted();
		const chunk = value as Buffer;
		size += chunk.byteLength;
		if (size > expectedSize) throw new Error("Flow archive source changed size while reading.");
		hash.update(chunk);
		await writeAll(handle, chunk);
	}
	signal?.throwIfAborted();
	if (size !== expectedSize || expectedSha256 !== undefined && hash.digest("hex") !== expectedSha256)
		throw new Error("Flow archive source size or checksum is invalid.");
}

export async function writeFlowArchiveHeader(handle: FileHandle, manifestBytes: number): Promise<void> {
	if (!Number.isSafeInteger(manifestBytes) || manifestBytes <= 0 || manifestBytes > MAX_FLOW_MANIFEST_BYTES)
		throw new Error("Flow archive manifest exceeds the supported size.");
	const header = Buffer.alloc(FLOW_ARCHIVE_HEADER_BYTES);
	FLOW_ARCHIVE_MAGIC.copy(header);
	header.writeBigUInt64LE(BigInt(manifestBytes), FLOW_ARCHIVE_MAGIC.byteLength);
	await writeAll(handle, header);
}

export async function readFlowArchiveHeader(handle: FileHandle, packageBytes: number): Promise<number> {
	const header = Buffer.alloc(FLOW_ARCHIVE_HEADER_BYTES);
	let offset = 0;
	while (offset < header.byteLength) {
		const result = await handle.read(header, offset, header.byteLength - offset, offset);
		if (result.bytesRead === 0) break;
		offset += result.bytesRead;
	}
	if (offset !== header.byteLength || !header.subarray(0, FLOW_ARCHIVE_MAGIC.byteLength).equals(FLOW_ARCHIVE_MAGIC))
		throw Object.assign(new Error("Unsupported Flow archive format. Re-export this Flow with the current Daedalus version."), { code: "flow_import_unsupported_format" });
	const manifestBytes = Number(header.readBigUInt64LE(FLOW_ARCHIVE_MAGIC.byteLength));
	if (!Number.isSafeInteger(manifestBytes) || manifestBytes <= 0 || manifestBytes > MAX_FLOW_MANIFEST_BYTES || FLOW_ARCHIVE_HEADER_BYTES + manifestBytes > packageBytes)
		throw new Error("Flow archive manifest size is invalid.");
	return manifestBytes;
}

export async function extractFlowArchiveSlice(handle: FileHandle, start: number, size: number, destination: string, expectedSha256?: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const target = await open(destination, "wx");
	const hash = createHash("sha256");
	let offset = 0;
	try {
		while (offset < size) {
			signal?.throwIfAborted();
			const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - offset));
			const result = await handle.read(chunk, 0, chunk.byteLength, start + offset);
			if (result.bytesRead <= 0) throw new Error("Flow archive ended before the expected media content.");
			const bytes = chunk.subarray(0, result.bytesRead);
			hash.update(bytes);
			await writeAll(target, bytes);
			offset += bytes.byteLength;
		}
		signal?.throwIfAborted();
		await target.sync();
	} finally { await target.close(); }
	if (expectedSha256 !== undefined && hash.digest("hex") !== expectedSha256)
		throw new Error("Flow archive media checksum does not match.");
}
