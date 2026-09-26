import { inflateRawSync } from "node:zlib";

const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE: number = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE: number = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE: number = 0x04034b50;
const ZIP_COMPRESSION_METHOD_STORED: number = 0;
const ZIP_COMPRESSION_METHOD_DEFLATED: number = 8;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES: number = 22;
const ZIP_MAX_END_RECORD_SEARCH_BYTES: number = 65_557;
const ZIP_MAX_ENTRIES: number = 4096;
const ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES: number = 46;
const ZIP_LOCAL_FILE_HEADER_BYTES: number = 30;
const ZIP_MULTI_DISK_MARKER: number = 0xffff;
const ZIP_UNKNOWN_SIZE_MARKER: number = 0xffffffff;
const OLE2_COMPOUND_FILE_SIGNATURE: number = 0xe011cfd0;

/** OOXML part that holds the visible document body. */
export const DOCX_DOCUMENT_PART_NAME: string = "word/document.xml";
/** Upper bound for the uncompressed document part; bounds memory against ZIP bombs. */
export const DOCX_MAX_DOCUMENT_PART_BYTES: number = 16 * 1024 * 1024;

const DOCX_PARAGRAPH_PATTERN: RegExp = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/gu;
const DOCX_RUN_PATTERN: RegExp = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)(?:\s[^>]*)?\/?>/gu;

type ZipEntry = {
	name: string;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
};

function assertSupportedArchive(archive: Buffer): void {
	if (archive.length >= 4 && archive.readUInt32LE(0) === OLE2_COMPOUND_FILE_SIGNATURE) {
		throw new Error("Unsupported document format: legacy binary .doc files are not supported; only .docx (OOXML) files can be read.");
	}
	if (archive.length < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + 1) {
		throw new Error("Unsupported document format: the file is not a .docx (ZIP) archive.");
	}
}

function findEndOfCentralDirectory(archive: Buffer): number {
	const searchStart: number = Math.max(0, archive.length - ZIP_MAX_END_RECORD_SEARCH_BYTES);
	for (let offset: number = archive.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES; offset >= searchStart; offset -= 1) {
		if (archive.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
			continue;
		}
		const commentLength: number = archive.readUInt16LE(offset + 20);
		if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + commentLength === archive.length) {
			return offset;
		}
	}

	throw new Error("Unsupported document format: the .docx archive has no valid ZIP end-of-directory record.");
}

function readCentralDirectoryEntries(archive: Buffer): ZipEntry[] {
	const endOffset: number = findEndOfCentralDirectory(archive);
	const diskNumber: number = archive.readUInt16LE(endOffset + 4);
	const directoryDiskNumber: number = archive.readUInt16LE(endOffset + 6);
	const entryCount: number = archive.readUInt16LE(endOffset + 10);
	const directorySize: number = archive.readUInt32LE(endOffset + 12);
	const directoryOffset: number = archive.readUInt32LE(endOffset + 16);

	if (diskNumber !== 0 || directoryDiskNumber !== 0) {
		throw new Error("Unsupported .docx archive: multi-disk ZIP archives are not supported.");
	}
	if (entryCount === ZIP_MULTI_DISK_MARKER || directorySize === ZIP_UNKNOWN_SIZE_MARKER || directoryOffset === ZIP_UNKNOWN_SIZE_MARKER) {
		throw new Error("Unsupported .docx archive: ZIP64 archives are not supported.");
	}
	if (entryCount === 0 || entryCount > ZIP_MAX_ENTRIES) {
		throw new Error(`Unsupported .docx archive: the ZIP entry count ${entryCount} is outside the supported range.`);
	}
	if (directoryOffset + directorySize > endOffset || directoryOffset + directorySize > archive.length) {
		throw new Error("Unsupported .docx archive: the ZIP directory points outside the file.");
	}

	const entries: ZipEntry[] = [];
	let cursor: number = directoryOffset;
	for (let index: number = 0; index < entryCount; index += 1) {
		if (cursor + ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES > archive.length || archive.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
			throw new Error("Unsupported .docx archive: a ZIP directory entry is malformed.");
		}
		const flags: number = archive.readUInt16LE(cursor + 8);
		const compressionMethod: number = archive.readUInt16LE(cursor + 10);
		const compressedSize: number = archive.readUInt32LE(cursor + 20);
		const uncompressedSize: number = archive.readUInt32LE(cursor + 24);
		const fileNameLength: number = archive.readUInt16LE(cursor + 28);
		const extraFieldLength: number = archive.readUInt16LE(cursor + 30);
		const commentLength: number = archive.readUInt16LE(cursor + 32);
		const localHeaderOffset: number = archive.readUInt32LE(cursor + 42);
		const nextCursor: number = cursor + ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES + fileNameLength + extraFieldLength + commentLength;
		if (nextCursor > archive.length) {
			throw new Error("Unsupported .docx archive: a ZIP directory entry is truncated.");
		}
		if ((flags & 0x1) !== 0) {
			throw new Error("Unsupported .docx archive: encrypted ZIP entries are not supported.");
		}
		if (compressedSize === ZIP_UNKNOWN_SIZE_MARKER || uncompressedSize === ZIP_UNKNOWN_SIZE_MARKER || localHeaderOffset === ZIP_UNKNOWN_SIZE_MARKER) {
			throw new Error("Unsupported .docx archive: ZIP64 entries are not supported.");
		}

		entries.push({
			name: archive.subarray(cursor + ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES, cursor + ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES + fileNameLength).toString("utf8"),
			compressionMethod,
			compressedSize,
			uncompressedSize,
			localHeaderOffset
		});
		cursor = nextCursor;
	}

	return entries;
}

function readEntryData(archive: Buffer, entry: ZipEntry): Buffer {
	const headerOffset: number = entry.localHeaderOffset;
	if (headerOffset + ZIP_LOCAL_FILE_HEADER_BYTES > archive.length || archive.readUInt32LE(headerOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
		throw new Error("Unsupported .docx archive: a ZIP entry header is malformed.");
	}
	const fileNameLength: number = archive.readUInt16LE(headerOffset + 26);
	const extraFieldLength: number = archive.readUInt16LE(headerOffset + 28);
	const dataOffset: number = headerOffset + ZIP_LOCAL_FILE_HEADER_BYTES + fileNameLength + extraFieldLength;
	const dataEnd: number = dataOffset + entry.compressedSize;
	if (dataEnd > archive.length) {
		throw new Error("Unsupported .docx archive: a ZIP entry points outside the file.");
	}
	if (entry.uncompressedSize > DOCX_MAX_DOCUMENT_PART_BYTES) {
		throw new Error(`Unsupported .docx file: ${entry.name} is larger than the ${DOCX_MAX_DOCUMENT_PART_BYTES} byte document limit.`);
	}

	const compressed: Buffer = archive.subarray(dataOffset, dataEnd);
	if (entry.compressionMethod === ZIP_COMPRESSION_METHOD_STORED) {
		if (entry.uncompressedSize !== 0 && entry.uncompressedSize !== compressed.length) {
			throw new Error("Unsupported .docx archive: a stored ZIP entry has inconsistent sizes.");
		}
		return compressed;
	}
	if (entry.compressionMethod !== ZIP_COMPRESSION_METHOD_DEFLATED) {
		throw new Error(`Unsupported .docx archive: ZIP compression method ${entry.compressionMethod} is not supported.`);
	}

	let inflated: Buffer;
	try {
		inflated = inflateRawSync(compressed, { maxOutputLength: DOCX_MAX_DOCUMENT_PART_BYTES });
	} catch {
		throw new Error("Unsupported .docx archive: the document part could not be decompressed.");
	}
	if (entry.uncompressedSize !== 0 && inflated.byteLength !== entry.uncompressedSize) {
		throw new Error("Unsupported .docx archive: the decompressed document part does not match the archive metadata.");
	}

	return inflated;
}

function decodeXmlEntities(value: string): string {
	if (!value.includes("&")) {
		return value;
	}

	return value.replace(/&(?:#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gu, (entity: string): string => {
		if (entity === "&amp;") return "&";
		if (entity === "&lt;") return "<";
		if (entity === "&gt;") return ">";
		if (entity === "&quot;") return "\"";
		if (entity === "&apos;") return "'";

		const isHex: boolean = entity.startsWith("&#x");
		const codePoint: number = Number.parseInt(entity.slice(isHex ? 3 : 2, -1), isHex ? 16 : 10);
		if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
			return entity;
		}

		return String.fromCodePoint(codePoint);
	});
}

function extractParagraphText(paragraphBody: string): string {
	let text: string = "";
	DOCX_RUN_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = DOCX_RUN_PATTERN.exec(paragraphBody)) !== null) {
		const runText: string | undefined = match[1];
		if (runText !== undefined) {
			text += decodeXmlEntities(runText);
			continue;
		}
		text += match[0].startsWith("<w:tab") ? "\t" : "\n";
	}

	// Word splits runs on formatting boundaries; only trailing spaces are noise.
	return text
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((line: string): string => line.replace(/[ \t]+$/u, ""))
		.join("\n");
}

/**
 * Extracts one entry per WordprocessingML paragraph (`w:p`), in document order.
 * Empty paragraphs are preserved so paragraph numbers stay stable for ranged reads.
 */
export function extractParagraphsFromDocumentXml(xml: string): string[] {
	const paragraphs: string[] = [];
	DOCX_PARAGRAPH_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = DOCX_PARAGRAPH_PATTERN.exec(xml)) !== null) {
		const paragraphBody: string | undefined = match[1];
		paragraphs.push(paragraphBody === undefined ? "" : extractParagraphText(paragraphBody));
	}

	return paragraphs;
}

/**
 * Reads the visible paragraph text of a .docx (OOXML) archive without external tools.
 * Only `word/document.xml` is parsed; headers, footers, footnotes and comments are ignored.
 */
export function extractDocxParagraphs(archive: Buffer): string[] {
	assertSupportedArchive(archive);
	const entry: ZipEntry | undefined = readCentralDirectoryEntries(archive).find(
		(candidate: ZipEntry): boolean => candidate.name.toLowerCase() === DOCX_DOCUMENT_PART_NAME
	);
	if (entry === undefined) {
		throw new Error(`Unsupported .docx file: the archive has no ${DOCX_DOCUMENT_PART_NAME} part.`);
	}

	return extractParagraphsFromDocumentXml(readEntryData(archive, entry).toString("utf8"));
}
