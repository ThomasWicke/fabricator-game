// The write half of "just enough PNG".
//
// png-decode.ts exists because the Worker has to LOOK at pixels; this exists
// because it now has to HAND SOME BACK — the sketch is repainted into a solid
// silhouette (silhouette.ts) before it is uploaded to ComfyUI, and that
// repainted image has to leave here as a real PNG file.
//
// Deflation rides on CompressionStream, the mirror of the decoder's
// DecompressionStream: both speak zlib-wrapped deflate, which is exactly what
// an IDAT holds. Every scanline is written with filter 0 — the images this
// encodes are flat blocks of three colours, which deflate already squeezes
// far past anything a filter would buy us.
//
// ISOMORPHIC — no node imports, no canvas.

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Length + type + body + CRC, where the CRC covers the type and the body. */
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

// Uint8Array<ArrayBuffer> for the same reason the decoder wants it: the
// stream writer takes a BufferSource, which excludes SharedArrayBuffer views.
async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  const out: Uint8Array[] = [];
  let total = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value as Uint8Array);
    total += (value as Uint8Array).length;
  }
  await written; // surfaces a write-side failure rather than swallowing it
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of out) {
    merged.set(c, at);
    at += c.length;
  }
  return merged;
}

/** 8-bit RGBA, non-interlaced — the subset decodePngRgba reads back. */
export async function encodePngRgba(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array> {
  if (rgba.length < width * height * 4) throw new Error("encodePngRgba: short pixel buffer");
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay 0: deflate compression, adaptive filtering, no interlace.

  const parts = [
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw as Uint8Array<ArrayBuffer>)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
