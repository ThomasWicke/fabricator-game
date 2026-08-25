// Deterministic sketch PNGs for the eval — the multimodal path's first
// test coverage.
//
// The interesting cases are pairs that share a NAME and differ only in the
// drawing: a "Rover" sketched with wheels versus with legs should compile to
// different locomotion, or the sketch isn't actually being read. Drawn in
// code so they are reproducible and nothing binary needs checking in; same
// ink colour as the real pad (#1c232e), same transparent ground, same ≤256px
// envelope the phones send.

import { encodePng, makeImage, type Image } from "./png";

const INK: [number, number, number, number] = [0x1c, 0x23, 0x2e, 255];

function px(img: Image, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  img.data.set(INK, (y * img.width + x) * 4);
}

/** A chunky line, roughly the pad's 7px brush. */
function line(img: Image, x0: number, y0: number, x1: number, y1: number, w = 5): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    const r = Math.floor(w / 2);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) px(img, x + dx, y + dy);
      }
    }
  }
}

function circle(img: Image, cx: number, cy: number, radius: number, w = 5): void {
  const steps = Math.ceil(radius * 8);
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI * 2;
    const a1 = ((i + 1) / steps) * Math.PI * 2;
    line(
      img,
      Math.round(cx + Math.cos(a0) * radius),
      Math.round(cy + Math.sin(a0) * radius),
      Math.round(cx + Math.cos(a1) * radius),
      Math.round(cy + Math.sin(a1) * radius),
      w,
    );
  }
}

function rect(img: Image, x: number, y: number, w: number, h: number): void {
  line(img, x, y, x + w, y);
  line(img, x + w, y, x + w, y + h);
  line(img, x + w, y + h, x, y + h);
  line(img, x, y + h, x, y);
}

const DRAWINGS: Record<string, (img: Image) => void> = {
  /** A box body on two big circles: unambiguous wheels. */
  "rover-wheels": (img) => {
    rect(img, 40, 60, 140, 60);
    circle(img, 75, 140, 24);
    circle(img, 150, 140, 24);
  },
  /** The same box body on four bent stick legs: unambiguous legs. */
  "rover-legs": (img) => {
    rect(img, 40, 50, 140, 60);
    for (const x of [55, 90, 130, 165]) {
      line(img, x, 110, x - 12, 140);
      line(img, x - 12, 140, x - 4, 165);
    }
  },
  /** A hull with a mast — a boat, without the word "boat" anywhere. */
  "hull-mast": (img) => {
    line(img, 30, 120, 60, 160);
    line(img, 60, 160, 170, 160);
    line(img, 170, 160, 200, 120);
    line(img, 30, 120, 200, 120);
    line(img, 115, 120, 115, 40);
    line(img, 115, 45, 175, 85);
    line(img, 175, 85, 115, 95);
  },
  /** A tall narrow thing with a light on top. */
  "tower-beam": (img) => {
    rect(img, 90, 60, 50, 160);
    line(img, 90, 60, 115, 30);
    line(img, 115, 30, 140, 60);
    circle(img, 115, 20, 8, 4);
  },
};

export type SketchId = keyof typeof DRAWINGS;
export const SKETCH_IDS = Object.keys(DRAWINGS) as SketchId[];

const cache = new Map<string, string>();

/** The sketch as raw base64 PNG — the exact form a phone submits. */
export function sketchBase64(id: SketchId): string {
  let b64 = cache.get(id);
  if (!b64) {
    const img = makeImage(230, 230);
    DRAWINGS[id](img);
    b64 = encodePng(img).toString("base64");
    cache.set(id, b64);
  }
  return b64;
}
