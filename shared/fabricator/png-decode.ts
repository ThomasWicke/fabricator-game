// Just enough PNG to look at the pixels we were sent.
//
// The Worker has no canvas and scripts/lib/png.ts is Node-only (node:zlib,
// Buffer), but the art retry has to judge its own output before handing it
// to the game — so this decodes the narrow subset ComfyUI's SaveImage
// emits: 8-bit, non-interlaced, greyscale/RGB with or without alpha.
// Inflation rides on DecompressionStream, which Workers and browsers both
// have. Anything outside that subset throws rather than guessing.
//
// ISOMORPHIC — no node imports, no canvas.

export type DecodedImage = { width: number; height: number; rgba: Uint8Array };

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Channel count per PNG colour type; the gaps are the ones we reject. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

// Uint8Array<ArrayBuffer> rather than plain Uint8Array: the stream writer
// takes a BufferSource, which excludes SharedArrayBuffer-backed views.
async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // Written straight into the stream rather than wrapped in a Blob: Blob's
  // element type is DOM-only, and this module compiles for the Worker and
  // Node scripts as well as the browser. The write is deliberately not
  // awaited first — it resolves as the reader below drains the output.
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  const out: Uint8Array[] = [];
  let total = 0;
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value as Uint8Array);
    total += (value as Uint8Array).length;
  }
  await written; // surfaces a write-side failure rather than swallowing it
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of out) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  return merged;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export async function decodePngRgba(bytes: Uint8Array): Promise<DecodedImage> {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];

  for (let p = 8; p + 8 <= bytes.length; ) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const body = p + 8;
    if (type === "IHDR") {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      const bitDepth = bytes[body + 8];
      const colorType = bytes[body + 9];
      const interlace = bytes[body + 12];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
      if (interlace !== 0) throw new Error("interlaced PNG unsupported");
      channels = CHANNELS[colorType];
      if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(body, body + length));
    } else if (type === "IEND") break;
    p = body + length + 4; // skip the CRC
  }
  if (!width || !height || !channels) throw new Error("PNG missing IHDR");

  const merged = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of idat) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  const raw = await inflate(merged);

  // Undo the per-scanline filters in place, then widen to RGBA.
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? px[dst + i - channels] : 0;
      const b = y > 0 ? px[up + i] : 0;
      const c = y > 0 && i >= channels ? px[up + i - channels] : 0;
      px[dst + i] =
        filter === 0
          ? x
          : filter === 1
            ? x + a
            : filter === 2
              ? x + b
              : filter === 3
                ? x + ((a + b) >> 1)
                : filter === 4
                  ? x + paeth(a, b, c)
                  : (() => {
                      throw new Error(`unknown PNG filter ${filter}`);
                    })();
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels <= 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = channels === 2 ? px[s + 1] : 255;
    } else {
      rgba[d] = px[s];
      rgba[d + 1] = px[s + 1];
      rgba[d + 2] = px[s + 2];
      rgba[d + 3] = channels === 4 ? px[s + 3] : 255;
    }
  }
  return { width, height, rgba };
}
