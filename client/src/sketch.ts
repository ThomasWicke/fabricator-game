// The blueprint sketch pad, shared by the phone (finger) and the shared
// screen (mouse). Pointer events cover both, so the only real difference is
// how big the canvas is.

const STROKE = "#1c232e";

export type SketchPad = {
  /** True once anything has been drawn. */
  hasInk: () => boolean;
  /** Resize to the element's current box. Wipes the drawing — call it when
   *  the pad is opened, not while someone is using it. */
  fit: () => void;
  clear: () => void;
  /** Cropped, downscaled PNG data URL, or undefined if the pad is empty. */
  toDataUrl: (maxSide: number, padding: number) => string | undefined;
};

/** Wire a canvas for freehand drawing. */
export function createSketchPad(canvas: HTMLCanvasElement, lineWidth = 6): SketchPad {
  const ctx = canvas.getContext("2d")!;
  let drawing = false;
  let inked = false;

  const style = () => {
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = STROKE;
  };

  const at = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    // The canvas is laid out by CSS but drawn in its own pixel grid; without
    // this ratio a wide pad draws the stroke offset from the cursor.
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  };

  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    inked = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events (test harness) have no active pointer to capture
    }
    const p = at(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = at(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const end = () => {
    drawing = false;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", end);

  return {
    hasInk: () => inked,
    fit: () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      // Setting width/height wipes the canvas, so only touch them when the
      // box has actually changed. Otherwise a stray layout pass — the pad is
      // fitted from a rAF after opening — could erase a drawing in progress.
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      style();
      inked = false;
    },
    clear: () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      inked = false;
    },
    toDataUrl: (maxSide, padding) =>
      inked ? cropInkToDataUrl(canvas, maxSide, padding) : undefined,
  };
}

/**
 * Crop a sketch canvas to the bounding box of its non-transparent pixels
 * (plus a little padding) and downscale so the longest side is ≤ maxSide,
 * preserving aspect ratio. People draw in a small patch of the pad, so
 * sending the raw canvas wastes most of the frame on transparent margin —
 * which makes the body sprite render as a faint speck once stretched to the
 * spec size, and gives the compiler an image where the subject is tiny.
 * Returns undefined when the canvas holds no ink.
 */
export function cropInkToDataUrl(
  source: HTMLCanvasElement,
  maxSide: number,
  padding: number,
): string | undefined {
  const w = source.width;
  const h = source.height;
  if (!w || !h) return undefined;

  let pixels: Uint8ClampedArray;
  try {
    pixels = source.getContext("2d")!.getImageData(0, 0, w, h).data;
  } catch {
    return undefined; // tainted canvas — shouldn't happen, we only draw strokes
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (pixels[row + x * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y; // rows are scanned top-down, so this is always the lowest so far
    }
  }
  if (maxX < 0) return undefined; // fully transparent

  const sx = Math.max(0, minX - padding);
  const sy = Math.max(0, minY - padding);
  const sw = Math.min(w, maxX + 1 + padding) - sx;
  const sh = Math.min(h, maxY + 1 + padding) - sy;

  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  const outCtx = out.getContext("2d")!;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}
