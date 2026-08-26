// Turn the player's scribble into the SHAPE they meant.
//
// The sketch pad exports strokes on a fully transparent field
// (client/src/sketch.ts, cropInkToDataUrl — it never paints a background),
// and ComfyUI's LoadImage does `convert("RGB")`, which DISCARDS alpha rather
// than compositing it. So the file that reached the sampler was #1c232e lines
// on pure black: about 35/255 of contrast, and no filled region anywhere.
// img2img did exactly what it was asked and returned thin dark marks on
// nothing — the "hollow wireframe" bodies Thomas hit on 2026-08-26.
//
// The fix is upstream of the model. A player drawing a boat draws its
// OUTLINE and means the mass inside it; so close the strokes, flood the
// outside, and whatever the flood cannot reach is the object. What leaves
// here is a solid grey body on a white ground with the original strokes still
// faintly on top — a silhouette the sampler can read as volume, with the
// interior detail kept as a hint rather than as the entire subject.
//
// An open scribble encloses nothing, and eroding it would ship the wire all
// over again. That case is detected (`thickened`) and the strokes are fattened
// into a mass instead: a stick-figure bike becomes a chunky bike-ish blob,
// which is a far better prior than four lines.
//
// ISOMORPHIC — pure pixels in, pixels out. The Worker calls it per
// fabrication; scripts/test-silhouette.ts calls it with synthetic drawings.

import { decodePngRgba } from "./png-decode";
import { encodePngRgba } from "./png-encode";

type Pixels = Uint8Array | Uint8ClampedArray;
export type RGB = [number, number, number];

export type SilhouetteOptions = {
  /** Stroke-closing radius, as a fraction of the longer side. Big enough to
   *  bridge the gaps a finger leaves between strokes, small enough not to
   *  swallow a drawn notch. */
  closeFraction?: number;
  /** Filled share of the ink's bounding box below which the drawing is
   *  treated as open line-work and thickened rather than filled. A drawn
   *  outline lands well above this; a stick figure well below. */
  minSolidity?: number;
  /** Stroke thickening radius for the open-scribble case, as a fraction of
   *  the longer side. */
  thickenFraction?: number;
  ground?: RGB;
  body?: RGB;
  ink?: RGB;
};

const DEFAULTS: Required<Omit<SilhouetteOptions, "ground" | "body" | "ink">> & {
  ground: RGB;
  body: RGB;
  ink: RGB;
} = {
  closeFraction: 0.03,
  minSolidity: 0.3,
  thickenFraction: 0.07,
  // White ground, mid-grey body, dark strokes. Deliberately colourless: the
  // palette is the prompt's job, and a coloured prior would bias every
  // fabrication toward whatever colour we picked here.
  ground: [255, 255, 255],
  body: [145, 152, 160],
  ink: [74, 80, 88],
};

export type SilhouetteResult = {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Did the drawing have any ink at all? False means there is nothing to
   *  condition on and the caller should skip the init image entirely. */
  inked: boolean;
  /** Filled share of the ink's bounding box, after filling. Exceeds 1 in the
   *  thickened case, where the fattened strokes grow past what was drawn. */
  solidity: number;
  /** True when the strokes enclosed nothing and were fattened into a mass. */
  thickened: boolean;
};

/**
 * Ink = the marks the player made. Alpha says so directly when the sketch
 * still carries it; a flattened sketch (anything that has been through a
 * JPEG or a compositing step) has none, so fall back to "darker than the
 * border", which is what a drawing on paper looks like.
 */
function inkMask(rgba: Pixels, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  let translucent = 0;
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] < 250) translucent++;

  if (translucent > w * h * 0.02) {
    for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] >= 32) mask[i] = 1;
    return mask;
  }

  const luma = (i: number) =>
    0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const corners = [0, w - 1, (h - 1) * w, h * w - 1].map(luma).sort((a, b) => a - b);
  const ground = (corners[1] + corners[2]) / 2;
  for (let i = 0; i < w * h; i++) if (luma(i) < ground - 40) mask[i] = 1;
  return mask;
}

/**
 * Chebyshev dilation, separable: a pixel is set when a set pixel lies within
 * `r` along the row, then within `r` along the column. Each sweep only tracks
 * the last set index, so the cost is independent of the radius.
 */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) last = x;
      if (x - last <= r) tmp[row + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[row + x]) last = x;
      if (last - x <= r) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Erosion is dilation of the complement — the frame counts as outside, so a
 *  shape touching the border erodes away from it like any other edge. */
function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = mask[i] ? 0 : 1;
  const grown = dilate(inv, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = grown[i] ? 0 : 1;
  return out;
}

/** 4-connected flood from every border pixel, over everything unblocked. */
function floodOutside(blocked: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (n: number) => {
    if (!out[n] && !blocked[n]) {
      out[n] = 1;
      stack.push(n);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  return out;
}

export function fillSilhouette(
  rgba: Pixels,
  w: number,
  h: number,
  options: SilhouetteOptions = {},
): SilhouetteResult {
  const opts = { ...DEFAULTS, ...options };
  const ink = inkMask(rgba, w, h);

  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const paint = (body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c = ink[i] && body[i] ? opts.ink : body[i] ? opts.body : opts.ground;
      out[i * 4] = c[0];
      out[i * 4 + 1] = c[1];
      out[i * 4 + 2] = c[2];
      out[i * 4 + 3] = 255;
    }
    return out;
  };
  if (maxX < 0) {
    return { width: w, height: h, rgba: paint(new Uint8Array(w * h)), inked: false, solidity: 0, thickened: false };
  }
  const bboxArea = (maxX - minX + 1) * (maxY - minY + 1);
  const longer = Math.max(w, h);

  // Close the strokes, flood the outside, keep what the flood could not
  // reach — then erode by the same radius so the shape returns to the size
  // that was actually drawn rather than the closed-up one.
  const r = Math.max(2, Math.round(longer * opts.closeFraction));
  const closed = dilate(ink, w, h, r);
  const outside = floodOutside(closed, w, h);
  const enclosed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) enclosed[i] = outside[i] ? 0 : 1;
  let body = erode(enclosed, w, h, r);
  // The strokes are part of the object whatever the erosion did to them.
  for (let i = 0; i < w * h; i++) if (ink[i]) body[i] = 1;

  const share = (m: Uint8Array) => {
    let n = 0;
    for (let i = 0; i < w * h; i++) if (m[i]) n++;
    return n / bboxArea;
  };
  let solidity = share(body);
  let thickened = false;

  if (solidity < opts.minSolidity) {
    // Open line-work: there was no interior to speak of, so filling found
    // nothing and shipping this would be the wireframe again. Fatten the
    // strokes into a mass, then fill whatever the fattened strokes enclose.
    thickened = true;
    const fat = dilate(ink, w, h, Math.max(r, Math.round(longer * opts.thickenFraction)));
    const stillOutside = floodOutside(fat, w, h);
    body = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) body[i] = stillOutside[i] ? 0 : 1;
    solidity = share(body);
  }

  return { width: w, height: h, rgba: paint(body), inked: true, solidity, thickened };
}

/** base64 PNG in, base64 PNG out — null when the drawing held no ink. */
export async function silhouetteFromPngBase64(
  base64: string,
  options: SilhouetteOptions = {},
): Promise<{ base64: string; solidity: number; thickened: boolean } | null> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const img = await decodePngRgba(bytes);
  const filled = fillSilhouette(img.rgba, img.width, img.height, options);
  if (!filled.inked) return null;
  const png = await encodePngRgba(filled.width, filled.height, filled.rgba);
  let out = "";
  for (let i = 0; i < png.length; i += 0x8000) out += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return { base64: btoa(out), solidity: filled.solidity, thickened: filled.thickened };
}
