import { inflateSync, deflateSync } from "node:zlib";
import { HttpError } from "./http.js";
export const MAX_PHOTO_BYTES = 1_000_000;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function pngCrc(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type),
    out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(pngCrc(Buffer.concat([name, data])), data.length + 8);
  return out;
}
// Canvas RGB/RGBA 8-bit PNG only. Parse, CRC-check, bound decompression and rebuild
// an allowlisted stream; EXIF, text, profiles, location and all other metadata are discarded.
export function sanitizePhotoPng(input: Buffer) {
  const bad = () => {
    throw new HttpError(400, "INVALID_PNG");
  };
  if (input.length > MAX_PHOTO_BYTES)
    throw new HttpError(413, "PHOTO_TOO_LARGE");
  if (input.length < 45 || !input.subarray(0, 8).equals(signature)) bad();
  let pos = 8,
    header: Buffer | undefined,
    width = 0,
    height = 0,
    channels = 0,
    ended = false,
    seenIDAT = false,
    idatEnded = false;
  const idats: Buffer[] = [];
  while (pos < input.length) {
    if (pos + 12 > input.length) bad();
    const length = input.readUInt32BE(pos);
    if (length > MAX_PHOTO_BYTES || pos + 12 + length > input.length) bad();
    const type = input.toString("ascii", pos + 4, pos + 8),
      data = input.subarray(pos + 8, pos + 8 + length);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      input.readUInt32BE(pos + 8 + length) !==
        pngCrc(input.subarray(pos + 4, pos + 8 + length))
    )
      bad();
    if (!header && type !== "IHDR") bad();
    if (type === "IHDR") {
      if (header || length !== 13) bad();
      header = Buffer.from(data);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (!width || !height || width > 1600 || height > 1600)
        throw new HttpError(400, "PHOTO_DIMENSIONS");
      if (
        data[8] !== 8 ||
        ![2, 6].includes(data[9]) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        bad();
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      if (idatEnded) bad();
      seenIDAT = true;
      idats.push(data);
    } else if (type === "IEND") {
      if (length || !seenIDAT) bad();
      ended = true;
      pos += 12;
      break;
    } else {
      if (seenIDAT) idatEnded = true;
      if (
        ["acTL", "fcTL", "fdAT"].includes(type) ||
        type[0] === type[0].toUpperCase()
      )
        bad();
    }
    pos += 12 + length;
  }
  if (!ended || pos !== input.length || !header) bad();
  const expected = (width * channels + 1) * height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idats), { maxOutputLength: expected });
  } catch {
    bad();
  }
  if (raw!.length !== expected) bad();
  for (let y = 0; y < height; y++)
    if (raw![y * (width * channels + 1)] > 4) bad();
  const bytes = Buffer.concat([
    signature,
    pngChunk("IHDR", header!),
    pngChunk("IDAT", deflateSync(raw!)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (bytes.length > MAX_PHOTO_BYTES)
    throw new HttpError(413, "PHOTO_TOO_LARGE");
  return { bytes, width, height };
}
