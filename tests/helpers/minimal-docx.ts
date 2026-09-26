import { deflateRawSync } from "node:zlib";

export type MinimalDocxEntry = {
	name: string;
	content: string | Buffer;
	compressionMethod?: number | undefined;
};

export type MinimalDocxOptions = {
	/** ZIP compression method for the document part. Defaults to 8 (deflate). */
	compressionMethod?: number | undefined;
	/** Overrides the document part name, for example to simulate a broken archive. */
	documentPartName?: string | undefined;
	/** Additional archive entries such as [Content_Types].xml. */
	extraEntries?: MinimalDocxEntry[] | undefined;
};

type ZipEntryInput = {
	name: string;
	content: Buffer;
	compressionMethod: number;
};

const ZIP_COMPRESSION_METHOD_DEFLATED: number = 8;
const LOCAL_FILE_HEADER_BYTES: number = 30;
const CENTRAL_DIRECTORY_ENTRY_BYTES: number = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES: number = 22;

const CRC32_TABLE: Uint32Array = createCrc32Table();

function createCrc32Table(): Uint32Array {
	const table: Uint32Array = new Uint32Array(256);
	for (let index: number = 0; index < 256; index += 1) {
		let value: number = index;
		for (let bit: number = 0; bit < 8; bit += 1) {
			value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
		}
		table[index] = value >>> 0;
	}

	return table;
}

function crc32(buffer: Buffer): number {
	let checksum: number = 0xffffffff;
	for (const byte of buffer) {
		checksum = (checksum >>> 8) ^ (CRC32_TABLE[(checksum ^ byte) & 0xff] ?? 0);
	}

	return (checksum ^ 0xffffffff) >>> 0;
}

function createZip(entries: ZipEntryInput[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset: number = 0;

	for (const entry of entries) {
		const name: Buffer = Buffer.from(entry.name, "utf8");
		const data: Buffer = entry.compressionMethod === ZIP_COMPRESSION_METHOD_DEFLATED
			? deflateRawSync(entry.content)
			: entry.content;
		const checksum: number = crc32(entry.content);

		const localHeader: Buffer = Buffer.alloc(LOCAL_FILE_HEADER_BYTES);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0, 6);
		localHeader.writeUInt16LE(entry.compressionMethod, 8);
		localHeader.writeUInt16LE(0, 10);
		localHeader.writeUInt16LE(0, 12);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(data.length, 18);
		localHeader.writeUInt32LE(entry.content.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localHeader.writeUInt16LE(0, 28);

		const centralHeader: Buffer = Buffer.alloc(CENTRAL_DIRECTORY_ENTRY_BYTES);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0, 8);
		centralHeader.writeUInt16LE(entry.compressionMethod, 10);
		centralHeader.writeUInt16LE(0, 12);
		centralHeader.writeUInt16LE(0, 14);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(entry.content.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(0, 38);
		centralHeader.writeUInt32LE(offset, 42);

		localParts.push(localHeader, name, data);
		centralParts.push(centralHeader, name);
		offset += localHeader.length + name.length + data.length;
	}

	const centralDirectory: Buffer = Buffer.concat(centralParts);
	const endRecord: Buffer = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_BYTES);
	endRecord.writeUInt32LE(0x06054b50, 0);
	endRecord.writeUInt16LE(0, 4);
	endRecord.writeUInt16LE(0, 6);
	endRecord.writeUInt16LE(entries.length, 8);
	endRecord.writeUInt16LE(entries.length, 10);
	endRecord.writeUInt32LE(centralDirectory.length, 12);
	endRecord.writeUInt32LE(offset, 16);
	endRecord.writeUInt16LE(0, 20);

	return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

/** Wraps body XML in the minimal WordprocessingML document shell. */
export function createDocumentXml(bodyXml: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
}

/** Builds a minimal but structurally valid .docx archive for read_docx tests. */
export function createMinimalDocx(documentXml: string, options: MinimalDocxOptions = {}): Buffer {
	const entries: ZipEntryInput[] = [{
		name: options.documentPartName ?? "word/document.xml",
		content: Buffer.from(documentXml, "utf8"),
		compressionMethod: options.compressionMethod ?? ZIP_COMPRESSION_METHOD_DEFLATED
	}];
	for (const extra of options.extraEntries ?? []) {
		entries.push({
			name: extra.name,
			content: typeof extra.content === "string" ? Buffer.from(extra.content, "utf8") : extra.content,
			compressionMethod: extra.compressionMethod ?? ZIP_COMPRESSION_METHOD_DEFLATED
		});
	}

	return createZip(entries);
}

/** Locates the ZIP end-of-central-directory record so tests can corrupt specific fields. */
export function findEndOfCentralDirectoryOffset(archive: Buffer): number {
	for (let offset: number = archive.length - END_OF_CENTRAL_DIRECTORY_BYTES; offset >= 0; offset -= 1) {
		if (archive.readUInt32LE(offset) === 0x06054b50) {
			return offset;
		}
	}

	throw new Error("Test archive has no end-of-central-directory record.");
}
