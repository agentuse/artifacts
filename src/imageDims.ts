// Header-only natural-dimension probes for the three image types we accept.
// Pure functions over a Buffer; no decoding, no deps. Returns undefined when
// the bytes don't look like the claimed format — callers fall back to layout
// defaults rather than throwing, so a malformed image still ingests.

export interface ImageDims {
  width: number;
  height: number;
}

export function readImageDims(
  type: "png" | "jpg" | "webp",
  buf: Buffer,
): ImageDims | undefined {
  try {
    if (type === "png") return readPng(buf);
    if (type === "jpg") return readJpeg(buf);
    if (type === "webp") return readWebp(buf);
  } catch {
    // Any out-of-bounds read on a truncated/garbage file: give up silently.
    return undefined;
  }
  return undefined;
}

// PNG: 8-byte signature, then IHDR chunk whose data starts at byte 16:
// width (BE u32) at 16, height (BE u32) at 20.
function readPng(buf: Buffer): ImageDims | undefined {
  if (buf.length < 24) return undefined;
  const sig = "\x89PNG\r\n\x1a\n";
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig.charCodeAt(i)) return undefined;
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

// JPEG: FFD8 SOI, then variable-length marker segments. Walk segments until
// we hit a Start-Of-Frame (SOF0..SOF15 except DHT=C4, JPG=C8, DAC=CC) and
// read precision(1) | height(2 BE) | width(2 BE) from its payload.
function readJpeg(buf: Buffer): ImageDims | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return undefined;
    // Skip fill bytes (multiple 0xFF allowed between segments).
    while (i < buf.length && buf[i] === 0xff) i++;
    const marker = buf[i++];
    if (marker === undefined) return undefined;
    // Standalone markers with no length: SOI, EOI, RSTn, TEM.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (i + 2 > buf.length) return undefined;
    const segLen = buf.readUInt16BE(i);
    // SOFn markers: 0xC0–0xCF excluding 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC).
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (i + 7 > buf.length) return undefined;
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      if (width <= 0 || height <= 0) return undefined;
      return { width, height };
    }
    i += segLen;
  }
  return undefined;
}

// WebP: RIFF/WEBP container with three possible chunks at offset 12: "VP8 "
// (lossy), "VP8L" (lossless), or "VP8X" (extended). Each encodes width/height
// at a different offset and packing.
function readWebp(buf: Buffer): ImageDims | undefined {
  if (buf.length < 30) return undefined;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return undefined;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const fourcc = buf.toString("ascii", 12, 16);
  if (fourcc === "VP8 ") {
    // Frame tag (3 bytes) + start code (3 bytes) at offsets 20–25; the next
    // 4 bytes are width, height with the top 2 bits as scale and the low 14
    // bits as the dimension.
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    if (width <= 0 || height <= 0) return undefined;
    return { width, height };
  }
  if (fourcc === "VP8L") {
    // Signature byte 0x2F at offset 20, then 4 bytes encoding (width-1) in
    // bits 0–13 and (height-1) in bits 14–27.
    if (buf[20] !== 0x2f) return undefined;
    const packed = buf.readUInt32LE(21);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (fourcc === "VP8X") {
    // Canvas width/height stored as 24-bit LE values minus 1 at offsets
    // 24–26 and 27–29.
    const w0 = buf[24];
    const w1 = buf[25];
    const w2 = buf[26];
    const h0 = buf[27];
    const h1 = buf[28];
    const h2 = buf[29];
    if (
      w0 === undefined ||
      w1 === undefined ||
      w2 === undefined ||
      h0 === undefined ||
      h1 === undefined ||
      h2 === undefined
    ) {
      return undefined;
    }
    const width = (w0 | (w1 << 8) | (w2 << 16)) + 1;
    const height = (h0 | (h1 << 8) | (h2 << 16)) + 1;
    return { width, height };
  }
  return undefined;
}
