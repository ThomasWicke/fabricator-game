// Chroma-key + crop for AI-generated body sprites.
//
// Gemini's image models can't output alpha, so the prompt asks for the body
// on a solid magenta field and this strips it. The trouble is that the model
// does not always comply — it comes back on white, on grey, on a little
// studio backdrop — and a keyer that only knows the word "magenta" hands back
// a fully opaque rectangle, which is the bug players actually saw.
//
// So the key is LEARNED from the border rather than assumed, removal is a
// flood fill inward rather than a global colour test, and the result is
// sanity-checked before it is trusted. Each of those does a specific job:
//
//   learned key  — works whatever the model decided the background was.
//   flood fill   — a white background cannot punch holes through the white
//                  parts of the machine standing in front of it, because
//                  those pixels aren't reachable from the edge.
//   sanity check — if it goes wrong, hand back the untouched sprite. An
//                  opaque box is a bad sprite; a hole where the design was
//                  is no sprite at all.

const MAX_SIDE = 256;

/**
 * Colour distance at which a pixel is unambiguously background.
 *
 * Deliberately tight. A generous threshold looks better against magenta and
 * then eats the subject alive when the model returns a grey backdrop and the
 * machine happens to be grey too — measured at 58, a mid-grey background took
 * two thirds of the body with it. The flood fill means a tight threshold
 * costs little: background is removed because it is *connected to the edge*,
 * not because it is far enough from the subject in colour.
 */
const HARD = 46;
/** …and beyond which it is unambiguously subject. In between is fringe. */
const SOFT = 96;
/** How far the border colours may disagree before we decide the background
 *  isn't flat and refuse to key at all. */
const FLATNESS = 72;
/** Removing more than this much means the key matched the subject too. */
const MAX_REMOVED = 0.97;

type RGB = [number, number, number];

const dist = (r: number, g: number, b: number, k: RGB): number =>
  Math.sqrt((r - k[0]) ** 2 + (g - k[1]) ** 2 + (b - k[2]) ** 2);

/**
 * What colour is the background?
 *
 * Sampled from the border — corners and edge midpoints — and averaged. The
 * spread is returned too: a backdrop with a gradient or a horizon in it will
 * disagree with itself, and that is the signal to leave the image alone.
 */
function readKey(d: Uint8ClampedArray, w: number, h: number): { key: RGB; spread: number } {
  const at = (x: number, y: number): RGB => {
    const i = (y * w + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const m = 2; // inset, because edge pixels are often resampling mush
  const samples: RGB[] = [
    at(m, m),
    at(w - 1 - m, m),
    at(m, h - 1 - m),
    at(w - 1 - m, h - 1 - m),
    at((w >> 1), m),
    at((w >> 1), h - 1 - m),
    at(m, h >> 1),
    at(w - 1 - m, h >> 1),
  ];
  const key: RGB = [0, 0, 0];
  for (const s of samples) {
    key[0] += s[0] / samples.length;
    key[1] += s[1] / samples.length;
    key[2] += s[2] / samples.length;
  }
  let spread = 0;
  for (const s of samples) spread = Math.max(spread, dist(s[0], s[1], s[2], key));
  return { key, spread };
}

/**
 * Mark every background pixel reachable from the border.
 *
 * Scanline flood fill: a plain per-pixel stack overflows on a 256×256 field
 * of one colour, which is exactly the common case here.
 */
function floodBackground(
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

export function chromaKeyBodySprite(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);

        const image = ctx.getImageData(0, 0, w, h);
        const d = image.data;

        const { key, spread } = readKey(d, w, h);
        if (spread > FLATNESS) {
          // Not a flat backdrop — a scene, a gradient, a vignette. Keying it
          // would eat holes out of the artwork.
          console.warn(
            `chroma: background is not flat (spread ${spread.toFixed(0)}), keeping the sprite as-is`,
          );
          resolve(dataUrl);
          return;
        }

        const { mask, removed } = floodBackground(d, w, h, key);
        if (removed / (w * h) > MAX_REMOVED) {
          console.warn("chroma: key matched almost everything, keeping the sprite as-is");
          resolve(dataUrl);
          return;
        }

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const i = p * 4;
            if (mask[p]) {
              d[i + 3] = 0;
              continue;
            }
            // Fringe: a kept pixel touching the background, close enough to
            // the key to be part of the blend between them. Fade it out and
            // drain the colour cast — desaturating rather than subtracting a
            // named channel, so it works for any key, not just magenta.
            const touchesBg =
              (x > 0 && mask[p - 1]) ||
              (x < w - 1 && mask[p + 1]) ||
              (y > 0 && mask[p - w]) ||
              (y < h - 1 && mask[p + w]);
            if (!touchesBg) continue;
            const dk = dist(d[i], d[i + 1], d[i + 2], key);
            if (dk >= SOFT) continue;
            const t = Math.max(0, (dk - HARD) / (SOFT - HARD)); // 0 = key, 1 = subject
            d[i + 3] = Math.round(d[i + 3] * t);
            const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const pull = (1 - t) * 0.6;
            d[i] = Math.round(d[i] + (lum - d[i]) * pull);
            d[i + 1] = Math.round(d[i + 1] + (lum - d[i + 1]) * pull);
            d[i + 2] = Math.round(d[i + 2] + (lum - d[i + 2]) * pull);
          }
        }
        ctx.putImageData(image, 0, 0);

        // crop to opaque bounds (+2px pad) so the body fills its box
        let minX = w;
        let minY = h;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 24) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              maxY = y;
            }
          }
        }
        if (maxX < 0) {
          console.warn("chroma: nothing left after keying, keeping the sprite as-is");
          resolve(dataUrl);
          return;
        }
        const pad = 2;
        const sx = Math.max(0, minX - pad);
        const sy = Math.max(0, minY - pad);
        const sw = Math.min(w, maxX + 1 + pad) - sx;
        const sh = Math.min(h, maxY + 1 + pad) - sy;
        const out = document.createElement("canvas");
        out.width = sw;
        out.height = sh;
        out.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(out.toDataURL("image/png"));
      } catch (err) {
        reject(err as Error);
      }
    };
    img.onerror = () => reject(new Error("body sprite failed to decode"));
    img.src = dataUrl;
  });
}
