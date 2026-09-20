import { deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type), data]);
	let crc = 0xffffffff;
	for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
	const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([size, body, checksum]);
}

export function createMockPng(color: readonly number[], width = 32, height = 32): Buffer {
	const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
	const pixels = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 4; channel++) pixels[y * (width * 4 + 1) + 1 + x * 4 + channel] = color[channel] ?? 255;
	return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
