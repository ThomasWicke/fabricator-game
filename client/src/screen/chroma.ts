// Chroma-key + crop for AI-generated body sprites. Gemini's image models
// can't output alpha, so sprites arrive on a solid magenta (#FF00FF)
// background; this strips it, despills the edge fringe, crops to the
// content bounds (so the body fills its display box like the sketch-crop
// does), and downscales to texture size.

const MAX_SIDE = 256;

/** How magenta a pixel is: 0 = not at all, higher = closer to the key. */
function magentaness(r: number, g: number, b: number): number {
  // magenta = red+blue high, green low; score the gap
  return Math.min(r, b) - g;
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
        for (let i = 0; i < d.length; i += 4) {
          const m = magentaness(d[i], d[i + 1], d[i + 2]);
          if (m > 96) {
            d[i + 3] = 0; // solidly background
          } else if (m > 40) {
            // edge fringe: fade out and despill (pull the magenta cast down)
            d[i + 3] = Math.round(d[i + 3] * (1 - (m - 40) / 56));
            const g = d[i + 1];
            d[i] = Math.min(d[i], g + 60);
            d[i + 2] = Math.min(d[i + 2], g + 60);
          }
        }
        ctx.putImageData(image, 0, 0);

        // crop to opaque bounds (+2px pad) so the body fills its box
        let minX = w,
          minY = h,
          maxX = -1,
          maxY = -1;
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
          reject(new Error("chroma key removed everything"));
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
