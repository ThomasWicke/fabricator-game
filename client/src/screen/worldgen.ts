// World generation, decoupled from Phaser so the lobby can draw a live
// minimap preview of exactly the world the expedition will land in.
//
// Terrain vocabulary is fixed by the Fabricator schema (grass/sand/swamp) —
// the generator's job is to lay those three out in a way that makes the
// "Swamp Buggy ≠ Car" contrast reachable from spawn without being a set of
// straight bands. Layout: a grass interior with a sand rim (the shore of the
// landmass), swamp blobs from a moisture field, and a guaranteed grass
// clearing around the Fabricator pad at the centre.

import type { TerrainType } from "../../../shared/fabricator/schema";
import {
  DEFAULT_SETTINGS,
  ROW_RATIO,
  SIZE_COLS,
  rowsFor,
  type Amount,
  type Density,
  type WorldSettings,
  type WorldSize,
} from "../../../shared/world-settings";

export {
  DEFAULT_SETTINGS,
  SIZE_COLS,
  rowsFor,
  type Amount,
  type Density,
  type WorldSettings,
  type WorldSize,
};



/** Fraction of eligible hexes that get a resource node. Retuned upward when
 *  this landed on the hex grid: the original rates were set against a square
 *  tile map and left the hex world about half as dense as the hand-placed
 *  scatter it replaced. "normal" now measures ~130 nodes on a medium world. */
const SCATTER_RATE: Record<Density, number> = {
  sparse: 0.025,
  normal: 0.05,
  dense: 0.09,
};

/** Moisture threshold above which a hex turns to swamp. Higher = less swamp.
 *  Measured on the hex grid: "some" ≈ 10% of the map, "lots" ≈ 20% (lower
 *  than the square-grid figures this was first tuned against, since the
 *  shore and the spawn clearing eat into it). */
const SWAMP_THRESHOLD: Record<Amount, number> = {
  none: 2, // unreachable — no swamp at all
  some: 0.62,
  lots: 0.55,
};

/** How far in from the rim the shore reaches, as a fraction of the half-width.
 *  Measured coverage: ~15% / ~28% of the map. */
const SHORE_WIDTH: Record<Amount, number> = {
  none: 0,
  some: 0.05,
  lots: 0.12,
};

/** Bogiron density relative to the grass scatter rate. Swamp covers less of
 *  the map than grass, so deposits need a higher rate to stay findable. */
const BOGIRON_RATIO = 1.6;

/** Hexes of guaranteed clear grass around the spawn/Fabricator pad. */
export const CLEARING_RADIUS = 7;

export const TERRAIN_COLORS: Record<TerrainType, string> = {
  grass: "#3f7d3a",
  sand: "#d8c07a",
  swamp: "#4a5236",
};


/** Resource nodes the generator places. Bogiron post-dates the original
 *  generator; it only appears in swamp, which is what gates swamp-capable
 *  machines behind a trek. */
export type NodeKind = "tree" | "rock" | "bogiron";

export type GeneratedWorld = {
  /** [row][col] */
  tiles: TerrainType[][];
  cols: number;
  rows: number;
  /** Spawn hex (centre of the clearing). */
  spawn: { tx: number; ty: number };
  /** Resource nodes in hex coordinates. */
  scatter: { tx: number; ty: number; kind: NodeKind }[];
};

// ── noise ───────────────────────────────────────────────────────────────────

/** Deterministic RNG from a string seed (mulberry32, same as textures.ts). */
export function mulberry32(seedStr: string): () => number {
  let a = hashString(seedStr);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** Hash a lattice point to [0,1) — the value-noise corner values. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = seed ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Fractal brownian motion — a few octaves is plenty at this scale. */
function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 8191) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ── generation ──────────────────────────────────────────────────────────────

export function generateWorld(settings: WorldSettings): GeneratedWorld {
  const cols = SIZE_COLS[settings.size];
  const rows = rowsFor(settings.size);
  const seed = hashString(`${settings.seed}|${settings.size}`);
  const rng = mulberry32(`${settings.seed}|scatter`);

  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const shoreWidth = SHORE_WIDTH[settings.shore];
  const swampAt = SWAMP_THRESHOLD[settings.swamp];
  // Noise sampled in world-relative units so the same seed reads as the same
  // landscape at every world size, just with more or less of it visible.
  const scale = 7 / Math.max(cols, rows);
  // Hex rows sit closer together than columns, so distance measured in hexes
  // is squashed vertically; correcting keeps the clearing round on screen.
  const rowAspect = 1 / ROW_RATIO;
  const fromCentre = (x: number, y: number) =>
    Math.hypot(x - cx, (y - cy) * rowAspect);

  const tiles: TerrainType[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: TerrainType[] = [];
    for (let x = 0; x < cols; x++) {
      // Distance to the rim: mostly square (so the shore frames the map
      // evenly instead of eating the corners) with a touch of radial to round
      // the corners off, plus noise so the coastline isn't a clean edge.
      const dx = Math.abs(x - cx) / (cols / 2);
      const dy = Math.abs(y - cy) / (rows / 2);
      const dist = 0.75 * Math.max(dx, dy) + 0.25 * Math.hypot(dx, dy);
      const coast = dist + (fbm(x * scale * 1.6, y * scale * 1.6, seed + 101) - 0.5) * 0.16;

      let terrain: TerrainType = "grass";
      if (shoreWidth > 0 && coast > 1 - shoreWidth) {
        terrain = "sand";
      } else {
        const moisture = fbm(x * scale, y * scale, seed);
        if (moisture > swampAt) terrain = "swamp";
      }

      // The pad and the first few steps out of it are always walkable grass.
      if (fromCentre(x, y) < CLEARING_RADIUS) terrain = "grass";
      row.push(terrain);
    }
    tiles.push(row);
  }

  // Resource nodes, never in the clearing: trees and rocks on grass, bogiron
  // in the swamp.
  const scatter: GeneratedWorld["scatter"] = [];
  const rate = SCATTER_RATE[settings.scatter];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = tiles[y][x];
      if (fromCentre(x, y) < CLEARING_RADIUS + 1) continue;
      if (t === "grass") {
        if (rng() > rate) continue;
        scatter.push({ tx: x, ty: y, kind: rng() < 0.7 ? "tree" : "rock" });
      } else if (t === "swamp") {
        if (rng() > rate * BOGIRON_RATIO) continue;
        scatter.push({ tx: x, ty: y, kind: "bogiron" });
      }
    }
  }

  return {
    tiles,
    cols,
    rows,
    spawn: { tx: Math.round(cx), ty: Math.round(cy) },
    scatter,
  };
}

/** Terrain mix, for the lobby to describe a world in words. */
export function terrainMix(world: GeneratedWorld): Record<TerrainType, number> {
  const counts: Record<TerrainType, number> = { grass: 0, sand: 0, swamp: 0 };
  for (const row of world.tiles) {
    for (const t of row) counts[t]++;
  }
  const total = world.cols * world.rows;
  return {
    grass: counts.grass / total,
    sand: counts.sand / total,
    swamp: counts.swamp / total,
  };
}

/** Draw a world to a canvas at whatever resolution it currently has. */
export function drawWorldPreview(
  canvas: HTMLCanvasElement,
  world: GeneratedWorld,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const px = canvas.width / world.cols;
  const py = canvas.height / world.rows;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < world.rows; y++) {
    for (let x = 0; x < world.cols; x++) {
      ctx.fillStyle = TERRAIN_COLORS[world.tiles[y][x]];
      ctx.fillRect(
        Math.floor(x * px),
        Math.floor(y * py),
        Math.ceil(px),
        Math.ceil(py),
      );
    }
  }

  // Obstacles as darker flecks, so density is legible at a glance.
  ctx.fillStyle = "rgba(20, 40, 20, 0.65)";
  for (const s of world.scatter) {
    ctx.fillRect(Math.floor(s.tx * px), Math.floor(s.ty * py), Math.ceil(px), Math.ceil(py));
  }

  // Spawn marker: the Fabricator pad.
  const cx = (world.spawn.tx + 0.5) * px;
  const cy = (world.spawn.ty + 0.5) * py;
  ctx.strokeStyle = "#6c9ef8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(4, canvas.width * 0.022), 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#8fc1ff";
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.5, canvas.width * 0.008), 0, Math.PI * 2);
  ctx.fill();
}

// ── settings persistence ────────────────────────────────────────────────────

const SETTINGS_KEY = "fab.world";

const isOneOf = <T extends string>(v: unknown, opts: readonly T[]): v is T =>
  typeof v === "string" && (opts as readonly string[]).includes(v);

export function loadSettings(fallbackSeed: string): WorldSettings {
  const base: WorldSettings = { ...DEFAULT_SETTINGS, seed: fallbackSeed };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<WorldSettings>;
    return {
      // The seed defaults to the room code so a fresh room is a fresh world;
      // only the knobs are remembered between sessions.
      seed: fallbackSeed,
      size: isOneOf(p.size, ["small", "medium", "large"] as const) ? p.size : base.size,
      swamp: isOneOf(p.swamp, ["none", "some", "lots"] as const) ? p.swamp : base.swamp,
      shore: isOneOf(p.shore, ["none", "some", "lots"] as const) ? p.shore : base.shore,
      scatter: isOneOf(p.scatter, ["sparse", "normal", "dense"] as const)
        ? p.scatter
        : base.scatter,
    };
  } catch {
    return base;
  }
}

export function saveSettings(s: WorldSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage disabled — settings just won't persist
  }
}

const SEED_WORDS = [
  "amber", "basalt", "cinder", "delta", "ember", "fern", "glade", "hollow",
  "iris", "jetty", "kelp", "loam", "marsh", "nettle", "onyx", "pollen",
  "quarry", "reed", "silt", "thicket", "umber", "verge", "willow", "zephyr",
];

/** Human-readable random seed — nicer to read back to a friend than hex. */
export function randomSeed(): string {
  const pick = () => SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
  return `${pick()}-${pick()}`;
}
