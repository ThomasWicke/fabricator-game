// Continuous world generation. Phaser-free and stateless: everything here is
// a pure function of (col, row, seed), so there is no map array, no bounds,
// and no "generate the world" step — the world simply *is*, and the renderer
// asks it about whichever hexes it currently needs.
//
// That is what makes the world endless. It also means the lobby's preview,
// the in-game minimap, and the ground you walk on are literally the same
// function, so they can never disagree.
//
// Three low-frequency noise fields decide everything:
//   elevation  — sea, shore, lowland, foothill, mountain
//   temperature— tundra ⇢ temperate ⇢ desert (very low frequency, so climate
//                bands are big enough to walk across and notice)
//   moisture   — desert ⇢ steppe ⇢ plain ⇢ woodland ⇢ bog
//
// Those pick from all ten biomes in the Kenney hexagon pack. Ten *biomes*,
// but only six movement classes (schema.ts's TerrainType) — the Fabricator
// reasons about ground it can cross, not about scenery.

import type { TerrainType } from "../../../shared/fabricator/schema";
import { HEX_W, ROW_H } from "./hexgrid";

// ── biomes ──────────────────────────────────────────────────────────────────

export type BiomeType =
  | "water"
  | "sand"
  | "grass"
  | "autumn"
  | "dirt"
  | "magic"
  | "stone"
  | "rock"
  | "snow"
  | "lava";

export type BiomeInfo = {
  /** Texture key of the hex tile. */
  tile: string;
  /** Movement class the Fabricator's terrainModifiers are keyed by. */
  terrain: TerrainType;
  /** Minimap colour. */
  color: string;
  /** Nothing on foot crosses this — only a machine designed for it. */
  liquid?: boolean;
  /** Human name, for the HUD's "you are here". */
  label: string;
};

export const BIOMES: Record<BiomeType, BiomeInfo> = {
  water: { tile: "tileWater", terrain: "water", color: "#2d5c86", liquid: true, label: "Open water" },
  sand: { tile: "tileSand", terrain: "sand", color: "#d8c07a", label: "Dunes" },
  grass: { tile: "tileGrass", terrain: "grass", color: "#4a8b3f", label: "Plains" },
  autumn: { tile: "tileAutumn", terrain: "grass", color: "#a4762f", label: "Old woodland" },
  dirt: { tile: "tileDirt", terrain: "sand", color: "#8b6f4c", label: "Steppe" },
  magic: { tile: "tileMagic", terrain: "swamp", color: "#4d5a3a", label: "The bog" },
  stone: { tile: "tileStone", terrain: "rock", color: "#7f7e79", label: "Scree" },
  rock: { tile: "tileRock", terrain: "rock", color: "#5c5a57", label: "Bare rock" },
  snow: { tile: "tileSnow", terrain: "snow", color: "#e2ebf1", label: "Snowfield" },
  lava: { tile: "tileLava", terrain: "rock", color: "#c2451c", liquid: true, label: "Lava" },
};

/** Every tile texture the world can ask for — the scene preloads these. */
export const BIOME_TILE_KEYS = [...new Set(Object.values(BIOMES).map((b) => b.tile))];

export const terrainOf = (b: BiomeType): TerrainType => BIOMES[b].terrain;
export const isLiquid = (b: BiomeType): boolean => !!BIOMES[b].liquid;

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

// ── the field ───────────────────────────────────────────────────────────────

/** Hex rows sit closer together than columns and odd rows are staggered, so
 *  noise sampled straight off (col,row) would come out sheared and squashed.
 *  Sampling in this space keeps continents round. */
const ROW_SQUASH = ROW_H / HEX_W; // ≈ 0.738

function geo(col: number, row: number): { gx: number; gy: number } {
  return { gx: col + (row % 2 !== 0 ? 0.5 : 0), gy: row * ROW_SQUASH };
}

/** Feature sizes, in hexes-per-cycle. Climate is deliberately the coarsest:
 *  a snowfield you can see the far side of doesn't read as a climate. */
const F_CONTINENT = 1 / 62;
const F_RELIEF = 1 / 17;
const F_TEMP = 1 / 95;
const F_MOISTURE = 1 / 34;

export type WorldSample = {
  biome: BiomeType;
  terrain: TerrainType;
  elevation: number;
  temperature: number;
  moisture: number;
};

/** Seeds derived once per world, so callers pass a number not a string. */
export function worldSeed(seedStr: string): number {
  return hashString(seedStr);
}

/** The whole world, at one hex. Pure, and cheap enough to call per tile. */
export function sample(col: number, row: number, seed: number): WorldSample {
  const { gx, gy } = geo(col, row);

  // Continent shape, roughened by a higher-frequency relief field so coasts
  // are ragged and mountains form ridges rather than domes.
  const base = fbm(gx * F_CONTINENT, gy * F_CONTINENT, seed, 5);
  const relief = fbm(gx * F_RELIEF, gy * F_RELIEF, seed + 7717, 3);
  const elevation = base * 0.76 + relief * 0.24;

  const temperature = fbm(gx * F_TEMP, gy * F_TEMP, seed + 3313, 3);
  const moisture = fbm(gx * F_MOISTURE, gy * F_MOISTURE, seed + 5591, 4);

  const biome = classify(elevation, temperature, moisture);
  return { biome, terrain: terrainOf(biome), elevation, temperature, moisture };
}

// Thresholds are tuned against measured coverage, not guessed: fbm clusters
// hard around 0.5, so a band that reads as "a bit cold" on paper turns a
// quarter of the planet into tundra. scripts/test-worldgen.ts prints the mix.
function classify(elev: number, temp: number, moist: number): BiomeType {
  if (elev < 0.418) return "water";
  if (elev < 0.446) return "sand"; // beach

  // High ground overrides climate — you get the mountain, not the biome.
  if (elev > 0.635) {
    if (elev > 0.72 && temp > 0.63) return "lava";
    if (temp < 0.44 || elev > 0.715) return "snow";
    return elev > 0.675 ? "rock" : "stone";
  }

  if (temp < 0.375) return "snow"; // tundra
  if (temp > 0.625 && moist < 0.46) return "sand"; // desert
  if (moist > 0.62) return "magic"; // bog
  if (moist < 0.42) return "dirt"; // steppe
  return moist > 0.54 ? "autumn" : "grass";
}

/** Just the biome — the hot path, called once per tile per chunk build. */
export function biomeAt(col: number, row: number, seed: number): BiomeType {
  const { gx, gy } = geo(col, row);
  const base = fbm(gx * F_CONTINENT, gy * F_CONTINENT, seed, 5);
  const relief = fbm(gx * F_RELIEF, gy * F_RELIEF, seed + 7717, 3);
  return classify(
    base * 0.76 + relief * 0.24,
    fbm(gx * F_TEMP, gy * F_TEMP, seed + 3313, 3),
    fbm(gx * F_MOISTURE, gy * F_MOISTURE, seed + 5591, 4),
  );
}

export function terrainAtHex(col: number, row: number, seed: number): TerrainType {
  return terrainOf(biomeAt(col, row, seed));
}

// ── scatter: resource nodes ─────────────────────────────────────────────────

export type NodeKind = "tree" | "rock" | "bogiron" | "food";

export type ScatterEntry = {
  kind: NodeKind;
  /** Texture key for the prop. */
  texture: string;
  /** Three art conventions in the pack; they anchor differently. A "bush" is
   *  a low prop you can walk through — food should never wall you in. */
  art: "boulder" | "pine" | "bush";
  /** Units of material in the node. */
  units: number;
  tint?: number;
};

/** Per-biome scatter tables. Weights are absolute probabilities per hex, so
 *  the totals here are also the density of the biome — bare rock is littered
 *  with stone, the steppe is nearly empty. */
type ScatterRule = { p: number; make: (r: number) => ScatterEntry };

const pine = (t: string, units = 5): ScatterEntry => ({
  kind: "tree",
  texture: t,
  art: "pine",
  units,
});
const boulder = (t: string, units = 4): ScatterEntry => ({
  kind: "rock",
  texture: t,
  art: "boulder",
  units,
});
/** Forage. Every walkable biome has something growing on it, because a
 *  biome you cannot eat in is a biome you cannot cross. */
const forage = (t: string, units = 3): ScatterEntry => ({
  kind: "food",
  texture: t,
  art: "bush",
  units,
});
const pick = <T>(r: number, xs: T[]): T => xs[Math.min(xs.length - 1, Math.floor(r * xs.length))];

const SCATTER: Record<BiomeType, ScatterRule[]> = {
  grass: [
    { p: 0.1, make: (r) => pine(pick(r, ["pineGreen_low", "pineGreen_mid", "pineGreen_high"])) },
    { p: 0.04, make: (r) => boulder(pick(r, ["rockStone", "rockStone_moss1", "rockStone_moss2"])) },
    { p: 0.05, make: () => forage("bushGrass", 3) },
  ],
  autumn: [
    { p: 0.15, make: (r) => pine(pick(r, ["treeAutumn_low", "treeAutumn_mid", "treeAutumn_high"]), 6) },
    { p: 0.03, make: (r) => boulder(pick(r, ["rockDirt_moss1", "rockDirt_moss3"])) },
    { p: 0.06, make: () => forage("bushAutumn", 4) },
  ],
  magic: [
    {
      p: 0.085,
      make: (r) => ({ ...boulder(pick(r, ["rockStone", "rockStone_moss3"]), 3), kind: "bogiron", tint: 0xd9813f }),
    },
    { p: 0.05, make: (r) => pine(pick(r, ["pineBlue_low", "pineBlue_mid"]), 4) },
    { p: 0.035, make: () => forage("bushMagic", 2) },
  ],
  dirt: [
    { p: 0.05, make: (r) => boulder(pick(r, ["rockDirt", "rockDirt_moss2"])) },
    { p: 0.02, make: (r) => pine(pick(r, ["treeBlue_low", "treeBlue_mid"]), 3) },
    { p: 0.03, make: () => forage("bushDirt", 2) },
  ],
  sand: [
    { p: 0.045, make: (r) => pine(pick(r, ["treeCactus_1", "treeCactus_2", "treeCactus_3"]), 3) },
    { p: 0.015, make: () => boulder("rockDirt", 3) },
    { p: 0.025, make: () => forage("bushSand", 2) },
  ],
  stone: [{ p: 0.11, make: (r) => boulder(pick(r, ["rockStone", "rockStone_moss1"]), 5) }],
  rock: [{ p: 0.13, make: () => boulder("rockStone", 6) }],
  snow: [
    { p: 0.06, make: (r) => pine(pick(r, ["pineBlue_low", "pineBlue_mid", "pineBlue_high"]), 4) },
    { p: 0.055, make: (r) => boulder(pick(r, ["rockSnow_1", "rockSnow_2", "rockSnow_3"]), 5) },
    { p: 0.025, make: () => forage("bushSnow", 2) },
  ],
  water: [],
  lava: [],
};

/** Resource node at this hex, or null. Deterministic and independent of every
 *  other hex, so a chunk can be built (and rebuilt) in isolation. */
export function scatterAt(
  col: number,
  row: number,
  seed: number,
  biome: BiomeType,
): ScatterEntry | null {
  const rules = SCATTER[biome];
  if (!rules.length) return null;
  const roll = hash2(col, row, seed ^ 0x9e3779b9);
  let acc = 0;
  for (const rule of rules) {
    acc += rule.p;
    if (roll < acc) {
      // A second, independent hash picks the variant, so raising a rule's
      // probability doesn't reshuffle which trees the earlier rules chose.
      return rule.make(hash2(col, row, seed ^ 0x85ebca6b));
    }
  }
  return null;
}

// ── decoration: flat props stamped into the ground ──────────────────────────

const DECOR: Record<BiomeType, string[]> = {
  grass: ["bushGrass", "flowerRed", "flowerBlue", "flowerWhite", "hillGrass", "smallRockGrass"],
  autumn: ["bushAutumn", "flowerYellow", "hillAutumn"],
  magic: ["bushMagic", "hillMagic", "flowerGreen"],
  dirt: ["bushDirt", "hillDirt", "smallRockDirt"],
  sand: ["bushSand", "hillSand"],
  stone: ["smallRockStone", "hillDirt"],
  rock: ["smallRockStone"],
  snow: ["bushSnow", "hillSnow", "smallRockSnow"],
  water: ["waveWater"],
  lava: ["waveLava"],
};

/** Every decor texture, for preloading. */
export const DECOR_KEYS = [...new Set(Object.values(DECOR).flat())];

/** Every scatter prop texture, for preloading. Enumerated by running each
 *  biome's rules rather than hand-listing, so the two can't drift apart. */
export const SCATTER_KEYS = [
  ...new Set(
    Object.values(SCATTER).flatMap((rules) =>
      rules.flatMap((rule) => [0, 0.34, 0.67, 0.99].map((r) => rule.make(r).texture)),
    ),
  ),
];

const DECOR_CHANCE = 0.14;

/** Flat prop for this hex, or null. Water and lava get their wave trim at a
 *  higher rate — a still sea looks dead. */
export function decorAt(col: number, row: number, seed: number, biome: BiomeType): string | null {
  const options = DECOR[biome];
  if (!options.length) return null;
  const roll = hash2(col, row, seed ^ 0xc2b2ae35);
  const chance = biome === "water" || biome === "lava" ? 0.3 : DECOR_CHANCE;
  if (roll > chance) return null;
  return options[Math.floor((roll / chance) * options.length) % options.length];
}

// ── spawn ───────────────────────────────────────────────────────────────────

/** Hexes around the Fabricator kept clear of resource nodes, so the landing
 *  site is always walkable and the pad is always visible. */
export const CLEARING_RADIUS = 5;

/**
 * Where the expedition lands. Spirals out from the origin for the first hex
 * whose whole two-hex neighbourhood is dry, walkable, temperate ground — so
 * you never wake up on a one-tile island or halfway up a mountain.
 */
export function findSpawn(seed: number): { col: number; row: number } {
  const good = (c: number, r: number) => {
    const b = biomeAt(c, r, seed);
    return b === "grass" || b === "autumn" || b === "dirt";
  };
  const clear = (c: number, r: number) => {
    if (!good(c, r)) return false;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (isLiquid(biomeAt(c + dc, r + dr, seed))) return false;
      }
    }
    return true;
  };
  // Square rings outward, walking only each ring's PERIMETER.
  //
  // The obvious version scans the whole square and skips the interior, which
  // costs (2r+1)² per ring and O(R⁴) overall — for a seed whose first good
  // ground is sixty rings out that is millions of noise evaluations, and the
  // game simply hangs on a black screen before it ever reaches create().
  // Walking the edge is 8r per ring, and the whole search is O(R²).
  if (clear(0, 0)) return { col: 0, row: 0 };
  for (let ring = 1; ring < 400; ring++) {
    for (let d = -ring; d <= ring; d++) {
      if (clear(d, -ring)) return { col: d, row: -ring };
      if (clear(d, ring)) return { col: d, row: ring };
      // Corners belong to the rows above, so the columns skip them.
      if (d > -ring && d < ring) {
        if (clear(-ring, d)) return { col: -ring, row: d };
        if (clear(ring, d)) return { col: ring, row: d };
      }
    }
  }
  return { col: 0, row: 0 };
}

/** True inside the landing clearing, where scatter is suppressed. */
export function inClearing(
  col: number,
  row: number,
  spawn: { col: number; row: number },
): boolean {
  const dc = col - spawn.col;
  const dr = row - spawn.row;
  return Math.hypot(dc, dr * ROW_SQUASH) < CLEARING_RADIUS;
}

// ── preview / minimap ───────────────────────────────────────────────────────

/**
 * Paint the biome field around a hex onto a canvas — used by the lobby to
 * show the landing region and by the in-game minimap. `hexPerPixel` trades
 * detail for coverage; both callers want a wide view, not a sharp one.
 */
export function drawBiomeMap(
  canvas: HTMLCanvasElement,
  seed: number,
  centre: { col: number; row: number },
  hexPerPixel: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  // Cache parsed colours — biomeAt is the expensive part, but re-parsing a hex
  // string per pixel is a pointless second cost.
  const rgb = new Map<BiomeType, [number, number, number]>();
  for (const [name, info] of Object.entries(BIOMES)) {
    const n = parseInt(info.color.slice(1), 16);
    rgb.set(name as BiomeType, [(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  }

  for (let py = 0; py < h; py++) {
    const row = Math.round(centre.row + (py - h / 2) * hexPerPixel / ROW_SQUASH);
    for (let px = 0; px < w; px++) {
      const col = Math.round(centre.col + (px - w / 2) * hexPerPixel);
      const [r, g, b] = rgb.get(biomeAt(col, row, seed))!;
      const i = (py * w + px) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
