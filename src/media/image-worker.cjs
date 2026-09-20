"use strict";
const sharp = require("sharp");
sharp.cache({ memory: 32, files: 0, items: 32 });
sharp.concurrency(1);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
async function open(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error("image_size_limit");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  // 在进入原生解码器之前拒绝 SVG 和动画容器
  if (!png && !jpeg && !webp) throw new Error("image_format_unsupported");
  if (png) for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") throw new Error("image_animation_unsupported");
    offset += length + 12;
  }
  if (webp && bytes.toString("ascii", 12, 16) === "VP8X" && (bytes[20] & 2)) throw new Error("image_animation_unsupported");
  const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "warning", animated: false });
  const meta = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(meta.format) || (meta.pages ?? 1) > 1) throw new Error("image_format_unsupported");
  return image.autoOrient().toColourspace("srgb");
}
process.once("message", async ({ bytes, overlay, operation }) => {
  try {
    let image = await open(bytes);
    const op = operation;
    if (op.kind === "resize") image = image.resize(op.width, op.height, { fit: op.fit, background: typeof op.background === "object" ? { r: Math.round(op.background.r * 255), g: Math.round(op.background.g * 255), b: Math.round(op.background.b * 255), alpha: op.background.a } : op.background });
    if (op.kind === "crop") image = image.extract({ left: op.x, top: op.y, width: op.width, height: op.height });
    if (op.kind === "rotate") image = image.rotate(op.angle).flip(op.flip).flop(op.flop);
    if (op.kind === "grayscale") image = image.greyscale();
    if (op.kind === "composite") {
      const layer = await (await open(overlay)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let offset = 3; offset < layer.data.length; offset += 4) layer.data[offset] = Math.round(layer.data[offset] * op.opacity);
      image = image.composite([{ input: layer.data, raw: { width: layer.info.width, height: layer.info.height, channels: 4 }, left: op.x, top: op.y }]);
    }
    const format = op.format ?? "png";
    const result = await image.toFormat(format, { quality: op.quality ?? 90 }).toBuffer({ resolveWithObject: true });
    if (result.data.length > MAX_BYTES || result.info.width * result.info.height > MAX_PIXELS) throw new Error("image_size_limit");
    process.send({ ok: true, bytes: result.data, mimeType: `image/${format}`, width: result.info.width, height: result.info.height, engine: `sharp:${sharp.versions.sharp}/vips:${sharp.versions.vips}` }, () => process.disconnect());
  } catch (error) {
    process.send({ ok: false, error: String(error.message ?? error) }, () => process.disconnect());
  }
});
