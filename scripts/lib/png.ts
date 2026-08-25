// Minimal PNG decode/encode on zlib alone — no image dependencies.
//
// Node has no canvas, and the QA scripts need to look at real pixels: the
// art eval measures whether generated bodies key cleanly, the sketch pairs
// are drawn programmatically, and the seam investigation that first needed
// this settled an argument by compositing actual tiles. Supports the subset
// the pipeline produces: 8-bit greyscale/RGB/RGBA/indexed, all filter types,
// no interlacing.

import { deflateSync, inflateSync } from "node:zlib";

export type Image = {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray;
};

export function decodePng(buf: Buffer): Image {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace) throw new Error("interlaced PNGs unsupported");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const bpp = channels;
  const stride = width * bpp;

  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[o++];
    const line = raw.subarray(o, o + stride);
    o += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }

  // Normalise every supported layout to RGBA.
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    const d = i * 4;
    if (colorType === 6) {
      data[d] = px[s];
      data[d + 1] = px[s + 1];
      data[d + 2] = px[s + 2];
      data[d + 3] = px[s + 3];
    } else if (colorType === 2) {
      data[d] = px[s];
      data[d + 1] = px[s + 1];
      data[d + 2] = px[s + 2];
      data[d + 3] = 255;
    } else if (colorType === 0) {
      data[d] = data[d + 1] = data[d + 2] = px[s];
      data[d + 3] = 255;
    } else if (colorType === 4) {
      data[d] = data[d + 1] = data[d + 2] = px[s];
      data[d + 3] = px[s + 1];
    } else {
      // indexed
      const idx = px[s] * 3;
      data[d] = palette![idx];
      data[d + 1] = palette![idx + 1];
      data[d + 2] = palette![idx + 2];
      data[d + 3] = trns && px[s] < trns.length ? trns[px[s]] : 255;
    }
  }
  return { width, height, data };
}

export function encodePng(img: Image): Buffer {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])), 8 + data.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A blank RGBA canvas, optionally filled with a solid colour. */
export function makeImage(
  width: number,
  height: number,
  fill: [number, number, number, number] = [0, 0, 0, 0],
): Image {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
}

/** Stamp `src` onto `dst` at (x,y) with source-over alpha. */
export function blit(dst: Image, src: Image, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (sy * src.width + sx) * 4;
      const a = src.data[s + 3] / 255;
      if (a === 0) continue;
      const d = (dy * dst.width + dx) * 4;
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round(src.data[s + c] * a + dst.data[d + c] * (1 - a));
      }
      dst.data[d + 3] = Math.max(dst.data[d + 3], src.data[s + 3]);
    }
  }
}
