// Does the generated frame hold ONE object?
//
// Diffusion models asked for game art like to answer with a sprite SHEET —
// twelve little variations in a grid — and every check we had called that a
// pass. The background is flat magenta, the keyer is happy, the spread is
// zero. Nothing was counting the objects, so a 3x4 contact sheet could end
// up bolted onto a vehicle chassis.
//
// Counting them is cheap: the non-background pixels form connected blobs,
// and `unity` — the largest blob's share of them — separates the cases
// without any per-subject tuning. One object with a detached mast still
// scores ~0.9; a grid of eight cannot clear ~0.3.
//
// ISOMORPHIC — pure pixels in, numbers out. The Worker uses it to reject and
// re-roll its own art; the Node evals use it to score a run.

export type UnityResult = {
  /** Largest blob's share of all foreground pixels, 0..1. */
  unity: number;
  /** Blobs holding at least 2% of the foreground each. */
  blobs: number;
  /** Foreground share of the whole frame. */
  coverage: number;
  /** How much of the frame's width and height the main subject spans. A
   *  sprite is an object with air around it; something that reaches both
   *  edges in both directions is a backdrop. */
  spanX: number;
  spanY: number;
  /** Main blob's pixels over its own bounding-box area, 0..1. Volume, in one
   *  number: a solid machine packs its box, an outline drawing rattles around
   *  inside one. This is the check that separates a body from a wireframe
   *  when every other number is happy — unity cannot, because an outline is
   *  perfectly connected and scores ~1. */
  solidity: number;
};

/**
 * A subject spanning nearly the whole frame in BOTH axes is not a sprite —
 * it is a scene, a card, or a screenshot with a border, and the object we
 * wanted is somewhere inside it. Thomas caught one of these by eye when
 * every number said the frame was clean: a hut with trees behind it and a
 * window-like frame around the lot, keyed against magenta and scored 0.99
 * unity, because a scene is perfectly connected.
 *
 * Calibrated against that one rejection and nine accepted sprites — the
 * scene spanned 98% x 98%, the widest real subject 80% x 79% — so the gap is
 * wide but the sample is small. Revisit if a legitimately edge-filling
 * subject ever gets turned away.
 */
export const SPAN_LIMIT = 0.95;

export const isFramedScene = (r: UnityResult): boolean =>
  r.spanX >= SPAN_LIMIT && r.spanY >= SPAN_LIMIT;

const MIN_BLOB_SHARE = 0.02;

/**
 * 4-connected labelling over a foreground mask, with an explicit stack —
 * recursion overflows on a 900px subject.
 */
export function measureUnity(mask: Uint8Array, w: number, h: number): UnityResult {
  const seen = new Uint8Array(w * h);
  const sizes: number[] = [];
  let total = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) total++;
  if (total === 0) return { unity: 0, blobs: 0, coverage: 0, spanX: 0, spanY: 0, solidity: 0 };

  const stack: number[] = [];
  const push = (n: number) => {
    if (!seen[n] && mask[n]) {
      seen[n] = 1;
      stack.push(n);
    }
  };
  let largest = { size: 0, spanX: 0, spanY: 0, solidity: 0 };
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !mask[start]) continue;
    let size = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    push(start);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    sizes.push(size);
    if (size > largest.size) {
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      largest = { size, spanX: bw / w, spanY: bh / h, solidity: size / (bw * bh) };
    }
  }
  sizes.sort((a, b) => b - a);
  return {
    unity: sizes[0] / total,
    blobs: sizes.filter((s) => s / total >= MIN_BLOB_SHARE).length,
    coverage: total / (w * h),
    spanX: largest.spanX,
    spanY: largest.spanY,
    solidity: largest.solidity,
  };
}

/** RGBA pixels from either decoder — the Worker's returns Uint8Array, the
 *  Node scripts' returns Uint8ClampedArray. */
type Pixels = Uint8Array | Uint8ClampedArray;

/** Foreground = anything that isn't the magenta backdrop. Matches the
 *  client keyer's own magenta tolerance so the two agree on what survives. */
export function magentaMask(rgba: Pixels, w: number, h: number, tolerance = 90): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4] - 255;
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2] - 255;
    if (Math.sqrt(r * r + g * g + b * b) > tolerance) mask[i] = 1;
  }
  return mask;
}

/** Foreground = opaque, for images that already carry alpha. */
export function alphaMask(rgba: Pixels, w: number, h: number, cutoff = 128): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] >= cutoff) mask[i] = 1;
  return mask;
}
