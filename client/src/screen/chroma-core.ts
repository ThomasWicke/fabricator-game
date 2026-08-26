// The chroma keyer's decision-making, on raw RGBA — no canvas, no DOM.
//
// Split from chroma.ts so the QA scripts can run the exact production keyer
// against generated art in Node: the browser wrapper decodes the image and
// crops the result, but every judgement — what the background is, whether it
// is flat enough to trust, which pixels go, how edges fade — lives here.
// Testing a re-implementation of the keyer would test nothing.

export type RGB = [number, number, number];

/** Colour distance at which a pixel is unambiguously background.
 *
 * Deliberately tight. A generous threshold looks better against magenta and
 * then eats the subject alive when the model returns a grey backdrop and the
 * machine happens to be grey too — measured at 58, a mid-grey background took
 * two thirds of the body with it. The flood fill means a tight threshold
 * costs little: background is removed because it is *connected to the edge*,
 * not because it is far enough from the subject in colour. */
export const HARD = 46;
/** …and beyond which it is unambiguously subject. In between is fringe. */
export const SOFT = 96;
/** How far the border colours may disagree before we decide the background
 *  isn't flat and refuse to key at all. */
export const FLATNESS = 72;
/** Removing more than this much means the key matched the subject too. */
export const MAX_REMOVED = 0.97;

/** When the learned background IS magenta, keying can afford to be global
 *  and generous: no real machine is magenta, so pixels near the key are
 *  background wherever they sit — including ENCLOSED regions the border
 *  flood can never reach, which is how cars shipped with magenta windows.
 *  The flood-only, tight-threshold path stays for every other background,
 *  where "looks like the background" and "is the background" genuinely
 *  differ (the grey machine on the grey backdrop). */
export const MAGENTA: RGB = [255, 0, 255];
export const MAGENTA_KEY_DIST = 90;
export const MAGENTA_HARD = 74;
export const MAGENTA_SOFT = 118;

export const dist = (r: number, g: number, b: number, k: RGB): number =>
  Math.sqrt((r - k[0]) ** 2 + (g - k[1]) ** 2 + (b - k[2]) ** 2);

/**
 * What colour is the background?
 *
 * Sampled around the border and reduced by MEDIAN, not mean — because the
 * border is not reliably background. A generated sprite often fills its
 * frame, and the browser keys a ~3.5x downscale, so a subject ending 8px
 * from the edge lands directly on a sample point. Measured on a real
 * failure (an all-terrain bike): one contaminated sample out of eight
 * dragged the averaged key to rgb(239,2,240) and the spread to 157 — past
 * the flatness threshold — so a perfectly clean magenta background was
 * refused and the sprite shipped unkeyed.
 *
 * The median ignores that sample entirely. What replaces "spread" as the
 * refusal signal is AGREEMENT: on a flat backdrop nearly every sample sits
 * on the key, while a gradient or a scene disagrees with itself everywhere.
 * A few outliers are the subject touching an edge; a majority of outliers
 * means there is no single background colour to key.
 */
const BORDER_SAMPLES = 32;
/** Fraction of border samples that must agree before the key is trusted. */
const MIN_AGREEMENT = 0.6;

export function readKey(
  d: Uint8ClampedArray,
  w: number,
  h: number,
): { key: RGB; spread: number } {
  const m = 2; // inset, because edge pixels are often resampling mush
  const at = (x: number, y: number): RGB => {
    const i = (Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const samples: RGB[] = [];
  const per = Math.max(2, Math.floor(BORDER_SAMPLES / 4));
  for (let i = 0; i < per; i++) {
    const fx = Math.round((i / (per - 1)) * (w - 1 - 2 * m)) + m;
    const fy = Math.round((i / (per - 1)) * (h - 1 - 2 * m)) + m;
    samples.push(at(fx, m), at(fx, h - 1 - m), at(m, fy), at(w - 1 - m, fy));
  }

  const median = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const key: RGB = [
    median(samples.map((s) => s[0])),
    median(samples.map((s) => s[1])),
    median(samples.map((s) => s[2])),
  ];

  // "Spread" is now the disagreement RATE, rescaled onto the old threshold so
  // FLATNESS keeps its meaning: below it the border agrees on one colour.
  const off = samples.filter((s) => dist(s[0], s[1], s[2], key) >= HARD).length;
  const agreement = 1 - off / samples.length;
  const spread = agreement >= MIN_AGREEMENT ? (1 - agreement) * FLATNESS : FLATNESS * 2;
  return { key, spread };
}

/**
 * Mark every background pixel reachable from the border.
 *
 * Scanline flood fill: a plain per-pixel stack overflows on a 256×256 field
 * of one colour, which is exactly the common case here.
 */
export function floodBackground(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  key: RGB,
): { mask: Uint8Array; removed: number } {
  const mask = new Uint8Array(w * h);
  const isBg = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return dist(d[i], d[i + 1], d[i + 2], key) < HARD;
  };
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    stack.push(x, 0, x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    stack.push(0, y, w - 1, y);
  }

  let removed = 0;
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    if (mask[y * w + x] || !isBg(x, y)) continue;

    let left = x;
    while (left > 0 && !mask[y * w + left - 1] && isBg(left - 1, y)) left--;
    let right = x;
    while (right < w - 1 && !mask[y * w + right + 1] && isBg(right + 1, y)) right++;

    for (x = left; x <= right; x++) {
      mask[y * w + x] = 1;
      removed++;
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        if (!mask[ny * w + x] && isBg(x, ny)) stack.push(x, ny);
      }
    }
  }
  return { mask, removed };
}

export type KeyOutcome =
  | { applied: false; reason: "not-flat" | "ate-everything" | "nothing-left"; spread: number }
  | {
      applied: true;
      spread: number;
      /** Fraction of the image that was background. */
      removedFraction: number;
      /** Opaque bounding box after keying. */
      bounds: { minX: number; minY: number; maxX: number; maxY: number };
    };

/**
 * The full keying decision, mutating `d` in place when it applies.
 *
 * Mirrors the browser flow exactly: learn the key, refuse un-flat
 * backgrounds, flood from the border, fade the fringe, then sanity-check
 * that something survived. When it does not apply, `d` is left untouched —
 * the caller keeps the original image, which is the production fallback.
 */
export function keyImage(d: Uint8ClampedArray, w: number, h: number): KeyOutcome {
  const { key, spread } = readKey(d, w, h);
  if (spread > FLATNESS) return { applied: false, reason: "not-flat", spread };

  const { mask, removed } = floodBackground(d, w, h, key);
  if (removed / (w * h) > MAX_REMOVED) {
    return { applied: false, reason: "ate-everything", spread };
  }

  // Magenta backgrounds also key GLOBALLY: windows, wheel arches and other
  // enclosed openings that the model painted background-colour are not
  // reachable from the border, and they shipped as magenta patches inside
  // otherwise clean sprites.
  const magenta = dist(key[0], key[1], key[2], MAGENTA) < MAGENTA_KEY_DIST;
  if (magenta) {
    for (let p = 0; p < w * h; p++) {
      if (mask[p]) continue;
      const i = p * 4;
      if (dist(d[i], d[i + 1], d[i + 2], key) < MAGENTA_HARD) mask[p] = 1;
    }
  }

  // Fringe pass runs on a copy so a late refusal leaves the input pristine.
  const out = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      if (mask[p]) {
        out[i + 3] = 0;
        continue;
      }
      // Fringe: a kept pixel touching the background, close enough to the
      // key to be part of the blend between them. Fade it out and drain the
      // colour cast — desaturating rather than subtracting a named channel,
      // so it works for any key, not just magenta.
      const touchesBg =
        (x > 0 && mask[p - 1]) ||
        (x < w - 1 && mask[p + 1]) ||
        (y > 0 && mask[p - w]) ||
        (y < h - 1 && mask[p + w]);
      if (!touchesBg && !magenta) continue;
      const soft = magenta ? MAGENTA_SOFT : SOFT;
      const hard = magenta ? MAGENTA_HARD : HARD;
      const dk = dist(out[i], out[i + 1], out[i + 2], key);
      if (dk >= soft) continue;
      if (!touchesBg && !magenta) continue;
      const t = Math.max(0, (dk - hard) / (soft - hard)); // 0 = key, 1 = subject
      out[i + 3] = Math.round(out[i + 3] * t);
      const lum = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
      const pull = (1 - t) * 0.6;
      out[i] = Math.round(out[i] + (lum - out[i]) * pull);
      out[i + 1] = Math.round(out[i + 1] + (lum - out[i + 1]) * pull);
      out[i + 2] = Math.round(out[i + 2] + (lum - out[i + 2]) * pull);
    }
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (out[(y * w + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return { applied: false, reason: "nothing-left", spread };

  d.set(out);
  return {
    applied: true,
    spread,
    removedFraction: removed / (w * h),
    bounds: { minX, minY, maxX, maxY },
  };
}
