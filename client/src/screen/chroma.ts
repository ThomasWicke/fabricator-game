// Chroma-key + crop for AI-generated body sprites — the browser wrapper.
//
// Gemini's image models can't output alpha, so the prompt asks for the body
// on a solid magenta field and this strips it. The trouble is that the model
// does not always comply — it comes back on white, on grey, on a little
// studio backdrop — and a keyer that only knows the word "magenta" hands back
// a fully opaque rectangle, which is the bug players actually saw.
//
// Every decision — learning the key from the border, refusing un-flat
// backgrounds, flood-filling from the edges, fading the fringe — lives in
// chroma-core.ts, which is pure RGBA-in/RGBA-out. This file only decodes the
// image, calls the core, and crops the result; the split is what lets the QA
// scripts run the exact production keyer in Node against generated art.

import { keyImage } from "./chroma-core";

const MAX_SIDE = 256;

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
        const outcome = keyImage(image.data, w, h);
        if (!outcome.applied) {
          // An opaque box is a bad sprite; a hole where the design was is no
          // sprite at all. Either way the original is the better fallback.
          console.warn(`chroma: keeping the sprite as-is (${outcome.reason})`);
          resolve(dataUrl);
          return;
        }
        ctx.putImageData(image, 0, 0);

        // crop to opaque bounds (+2px pad) so the body fills its box
        const { minX, minY, maxX, maxY } = outcome.bounds;
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
