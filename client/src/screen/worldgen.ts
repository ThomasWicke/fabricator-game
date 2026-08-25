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
const F_RIVER = 1 / 40;

/**
 * Rivers, without flow.
 *
 * A real river is found by pouring water downhill and seeing where it goes,
 * which is a stateful simulation over the whole map — exactly the thing this
 * world cannot have. So instead: a river is where a noise field crosses its
 * own midline. That gives long winding ribbons that close on themselves and
 * branch, which is what a river network looks like from above, and it stays a
 * pure function of the hex.
 *
 * It is gated on elevation so water runs in valleys rather than over peaks,
 * and it widens as the land falls — a stream in the hills, a river near the
 * coast.
 */
function riverAt(gx: number, gy: number, seed: number, elev: number): "water" | "bank" | null {
  // Above the treeline there is nothing to carry; below sea level it is sea.
  if (elev < 0.42 || elev > 0.7) return null;
  const r = Math.abs(fbm(gx * F_RIVER, gy * F_RIVER, seed + 9127, 3) - 0.5);
  // Falling land, wider water: 1 at the coast, 0 at the headwaters.
  const fall = Math.max(0, Math.min(1, (0.7 - elev) / 0.24));
  // The floor matters: below about this the water band is narrower than a
  // hex, and the upper reaches come out as bare tan banks with nothing
  // running between them — a towpath with no canal.
  const water = 0.007 + fall * 0.011;
  if (r < water) return "water";
  return r < water + 0.009 ? "bank" : null;
}

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

  const biome = classify(elevation, temperature, moisture, gx, gy, seed);
  return { biome, terrain: terrainOf(biome), elevation, temperature, moisture };
}

// Thresholds are tuned against measured coverage, not guessed: fbm clusters
// hard around 0.5, so a band that reads as "a bit cold" on paper turns a
// quarter of the planet into tundra. scripts/test-worldgen.ts prints the mix.
function classify(
  elev: number,
  temp: number,
  moist: number,
  gx: number,
  gy: number,
  seed: number,
): BiomeType {
  if (elev < 0.418) return "water";
  if (elev < 0.446) return "sand"; // beach

  // Rivers cut through whatever biome they run past, and carry their own
  // banks — a strip of sand either side, which is what makes them read as a
  // watercourse rather than a blue stripe painted across a field.
  const river = riverAt(gx, gy, seed, elev);
  if (river === "water") return "water";
  if (river === "bank") return "sand";

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

/**
 * Vertical relief, in pixels. Positive sinks a tile, negative raises it.
 *
 * Keyed to ELEVATION, not to biome, and that distinction is the whole point.
 * Biome-keyed relief looks right until you notice that `snow` covers both
 * lowland tundra and mountain peaks: a tundra hex beside a foothill then gets
 * a step it has no business having, and since both are pale grey it reads as
 * a row of little dark spikes rather than as terrain. Elevation is continuous,
 * so a step now appears only where the ground genuinely rises, and the steps
 * line up into contours instead of jagged mismatches at colour boundaries.
 */
function reliefFor(elev: number): number {
  if (elev < 0.446) return 3; // beach, a touch below the land behind it
  if (elev < 0.55) return 0;
  if (elev < 0.635) return -4;
  if (elev < 0.7) return -9;
  return -14;
}

/** The bog is a hollow you step down into, and liquid sits lower still —
 *  relief these two carry on top of whatever their elevation says. */
const BIOME_SINK: Partial<Record<BiomeType, number>> = {
  magic: 5,
  water: 8,
  lava: 8,
};

export type TileInfo = { biome: BiomeType; drop: number };

/**
 * Biome and relief together, from one pass of the noise.
 *
 * Cheaper than asking for them separately: biomeAt already computes elevation
 * and throws it away, so a caller that needs both was paying for it twice.
 */
export function tileAt(col: number, row: number, seed: number): TileInfo {
  const { gx, gy } = geo(col, row);
  const base = fbm(gx * F_CONTINENT, gy * F_CONTINENT, seed, 5);
  const relief = fbm(gx * F_RELIEF, gy * F_RELIEF, seed + 7717, 3);
  const elevation = base * 0.76 + relief * 0.24;
  const biome = classify(
    elevation,
    fbm(gx * F_TEMP, gy * F_TEMP, seed + 3313, 3),
    fbm(gx * F_MOISTURE, gy * F_MOISTURE, seed + 5591, 4),
    gx,
    gy,
    seed,
  );
  return { biome, drop: reliefFor(elevation) + (BIOME_SINK[biome] ?? 0) };
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
    gx,
    gy,
    seed,
  );
}

export function terrainAtHex(col: number, row: number, seed: number): TerrainType {
  return terrainOf(biomeAt(col, row, seed));
}

// ── regions ─────────────────────────────────────────────────────────────────
//
// Ground you can name, so two players can arrange to meet at one.
//
// A region is a Voronoi cell over a jittered lattice: for a hex, the nearest
// of the nine candidate centres around it wins. That is a pure function of
// (hex, seed) — no stored map, no allocation of names at world creation, and
// nothing to synchronise. Both screens name the same ground the same way
// because they compute it, not because they agreed on it. The same seed a
// year from now still calls it the Ashen Reach.

/** Hexes across, roughly. Big enough that walking out of one is an event. */
const REGION_SIZE = 30;

export type Region = { rx: number; ry: number };

/** Jittered centre of a lattice cell, in geo space. */
function regionCentre(ix: number, iy: number, seed: number): { x: number; y: number } {
  const jx = hash2(ix, iy, seed ^ 0x2545f491);
  const jy = hash2(ix, iy, seed ^ 0x9e3779b1);
  return { x: (ix + 0.15 + jx * 0.7) * REGION_SIZE, y: (iy + 0.15 + jy * 0.7) * REGION_SIZE };
}

/** Which region a hex belongs to. */
export function regionAt(col: number, row: number, seed: number): Region {
  const { gx, gy } = geo(col, row);
  const cx = Math.floor(gx / REGION_SIZE);
  const cy = Math.floor(gy / REGION_SIZE);
  let best = Infinity;
  let rx = cx;
  let ry = cy;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = regionCentre(cx + dx, cy + dy, seed);
      const d = (c.x - gx) ** 2 + (c.y - gy) ** 2;
      if (d < best) {
        best = d;
        rx = cx + dx;
        ry = cy + dy;
      }
    }
  }
  return { rx, ry };
}

export const sameRegion = (a: Region, b: Region): boolean => a.rx === b.rx && a.ry === b.ry;

const REGION_ADJ = [
  "Ashen", "Pale", "Bitter", "Quiet", "Sunken", "Broken", "Long", "Cold",
  "Amber", "Iron", "Salt", "Grey", "Far", "Old", "Still", "Hollow",
  "Rust", "Low", "Wide", "Hushed", "Weeping", "Glass", "Ember", "Thin",
];

/** Nouns by movement class, so a name fits the ground it is stuck to. */
const REGION_NOUN: Record<TerrainType, string[]> = {
  grass: ["Reach", "Meadows", "Weald", "Downs", "Green"],
  sand: ["Waste", "Dunes", "Flats", "Sands", "Pan"],
  swamp: ["Mire", "Fen", "Marsh", "Bog", "Sump"],
  rock: ["Scarp", "Crags", "Spine", "Bluffs", "Teeth"],
  snow: ["Drifts", "Barrens", "Whites", "Silence", "Shelf"],
  water: ["Shallows", "Straits", "Sound", "Narrows", "Deep"],
};

/**
 * What this region is called.
 *
 * The noun comes from the ground at the region's own centre rather than from
 * wherever the player happens to be standing — one region, one name, however
 * varied the terrain inside it.
 */
export function regionName(region: Region, seed: number): string {
  const c = regionCentre(region.rx, region.ry, seed);
  // Back out of geo space to a hex to ask what the ground is there.
  const row = Math.round(c.y / ROW_SQUASH);
  const col = Math.round(c.x - (row % 2 !== 0 ? 0.5 : 0));
  const terrain = terrainOf(biomeAt(col, row, seed));

  const h = hash2(region.rx, region.ry, seed ^ 0x27d4eb2f);
  const h2v = hash2(region.ry, region.rx, seed ^ 0x165667b1);
  const adj = REGION_ADJ[Math.floor(h * REGION_ADJ.length) % REGION_ADJ.length];
  const nouns = REGION_NOUN[terrain];
  const noun = nouns[Math.floor(h2v * nouns.length) % nouns.length];
  // "the" on about half of them, which stops a long list reading as a form.
  return h2v < 0.5 ? `the ${adj} ${noun}` : `${adj} ${noun}`;
}

// ── scatter: resource nodes ─────────────────────────────────────────────────

/** The four materials that only one biome makes. Kept in step with
 *  schema.ts's ExoticMaterial by the typecheck in world.ts, which assigns a
 *  node's kind straight into a pack keyed by MaterialType. */
export type ExoticNode = "bogiron" | "basalt" | "glass" | "rime";
export type NodeKind = "tree" | "rock" | ExoticNode | "food";

/** Which ground holds which seam, and what colour it shows as. One table, so
 *  the ordinary scatter and the landmark pits cannot drift apart — a snow pit
 *  full of bogiron would be a lie the player has no way to check. */
export const SEAMS: Record<ExoticNode, { tint: number; biomes: BiomeType[] }> = {
  bogiron: { tint: 0xd9813f, biomes: ["magic"] },
  basalt: { tint: 0x4d4a63, biomes: ["stone", "rock"] },
  glass: { tint: 0x7fe4d8, biomes: ["sand"] },
  rime: { tint: 0x9fc7ff, biomes: ["snow"] },
};

/** Is this node one of the four one-biome ores? */
export const isSeam = (k: NodeKind): k is ExoticNode =>
  k !== "tree" && k !== "rock" && k !== "food";

/** The seam a biome holds, if it holds one. */
export function seamOf(biome: BiomeType): ExoticNode | null {
  for (const k of Object.keys(SEAMS) as ExoticNode[]) {
    if (SEAMS[k].biomes.includes(biome)) return k;
  }
  return null;
}

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

/**
 * A seam of one of the four one-biome materials.
 *
 * Same boulder silhouette, different colour: the pack has no art for any of
 * these, and a tinted rock reads as "ore in stone" far better than a made-up
 * sprite would. The tint is the only thing telling the player this hex is
 * worth a trip, so they are pitched well away from the greys around them.
 */
const seam = (kind: ExoticNode, texture: string, units = 4): ScatterEntry => ({
  ...boulder(texture, units),
  kind,
  tint: SEAMS[kind].tint,
});

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
      make: (r) => seam("bogiron", pick(r, ["rockStone", "rockStone_moss3"]), 3),
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
    // Desert glass, where the sand has been fused. Rarer than bogiron: the
    // desert is a big biome and a common seam would make it a quarry.
    { p: 0.03, make: () => seam("glass", "rockDirt", 3) },
  ],
  // Bare highlands. Nothing grows, so the seam is the only reason to be here
  // and it can afford to be generous.
  stone: [
    { p: 0.11, make: (r) => boulder(pick(r, ["rockStone", "rockStone_moss1"]), 5) },
    { p: 0.035, make: () => seam("basalt", "rockStone", 4) },
  ],
  rock: [
    { p: 0.13, make: () => boulder("rockStone", 6) },
    { p: 0.055, make: () => seam("basalt", "rockStone", 5) },
  ],
  snow: [
    { p: 0.06, make: (r) => pine(pick(r, ["pineBlue_low", "pineBlue_mid", "pineBlue_high"]), 4) },
    { p: 0.055, make: (r) => boulder(pick(r, ["rockSnow_1", "rockSnow_2", "rockSnow_3"]), 5) },
    { p: 0.025, make: () => forage("bushSnow", 2) },
    { p: 0.035, make: (r) => seam("rime", pick(r, ["rockSnow_2", "rockSnow_3"]), 4) },
  ],
  water: [],
  lava: [],
};

// ── landmarks ───────────────────────────────────────────────────────────────
//
// Somewhere to be going. A landmark is a small cluster of nodes arranged on
// purpose rather than scattered — a ring of stones, a thick grove, a pit of
// bogiron — placed on a coarse lattice so finding out whether a hex belongs
// to one costs nine hashes instead of a neighbourhood scan.

export type LandmarkKind = "stones" | "grove" | "pit";

/** Lattice pitch, in hexes. */
const LANDMARK_CELL = 30;
/** Fraction of cells that hold one. */
const LANDMARK_CHANCE = 0.4;
/** How far the set piece reaches from its middle. */
const LANDMARK_RADIUS = 2.6;

export type Landmark = {
  kind: LandmarkKind;
  /** For a pit: which seam it is a rich pocket of. */
  ore: ExoticNode | null;
  col: number;
  row: number;
};

function landmarkInCell(ix: number, iy: number, seed: number): Landmark | null {
  if (hash2(ix, iy, seed ^ 0x7f4a7c15) > LANDMARK_CHANCE) return null;
  const jx = hash2(ix, iy, seed ^ 0x1b873593);
  const jy = hash2(iy, ix, seed ^ 0xcc9e2d51);
  const col = Math.round((ix + 0.2 + jx * 0.6) * LANDMARK_CELL);
  const row = Math.round((iy + 0.2 + jy * 0.6) * LANDMARK_CELL);

  // The ground decides what stands on it: no groves on bare rock, and a pit is
  // always a pocket of whatever that biome's seam already is. Ground that
  // holds nothing gets a ring of stones — a place, but not a payday.
  const biome = biomeAt(col, row, seed);
  if (biome === "water" || biome === "lava") return null;
  const ore = seamOf(biome);
  // Ground with a seam under it USUALLY gets the pit — but not always, or the
  // ring of stones would only ever appear on dirt, and the one set piece that
  // reads as built by somebody would vanish from four fifths of the map.
  const kind: LandmarkKind =
    ore && hash2(col, row, seed ^ 0x2545f491) < 0.6
      ? "pit"
      : biome === "grass" || biome === "autumn"
        ? "grove"
        : "stones";
  return { kind, ore: kind === "pit" ? ore : null, col, row };
}

/** The landmark this hex belongs to, if any, with how far out it is. */
export function landmarkAt(
  col: number,
  row: number,
  seed: number,
): { mark: Landmark; dist: number } | null {
  const cx = Math.floor(col / LANDMARK_CELL);
  const cy = Math.floor(row / LANDMARK_CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const mark = landmarkInCell(cx + dx, cy + dy, seed);
      if (!mark) continue;
      const d = Math.hypot(col - mark.col, (row - mark.row) * ROW_SQUASH);
      if (d <= LANDMARK_RADIUS) return { mark, dist: d };
    }
  }
  return null;
}

/** What a landmark puts on a given hex of itself, if anything. */
function landmarkScatter(
  mark: Landmark,
  dist: number,
  variant: number,
): ScatterEntry | null {
  switch (mark.kind) {
    case "stones":
      // A ring, not a heap: the middle is left clear so it reads as built.
      if (dist < 1.4 || dist > LANDMARK_RADIUS) return null;
      return boulder(pick(variant, ["rockStone", "rockStone_moss1", "rockStone_moss2"]), 7);
    case "grove":
      // Dense at the middle, thinning out — a wood, not a hedge.
      if (variant > 1 - dist / (LANDMARK_RADIUS + 1)) return null;
      return pine(pick(variant, ["treeGreen_low", "treeGreen_mid", "treeGreen_high"]), 8);
    case "pit":
      if (dist > LANDMARK_RADIUS - 0.6) return null;
      // Richer than the seams scattered around it — that is what makes the
      // walk worth it rather than just further.
      return seam(mark.ore!, pick(variant, ["rockStone", "rockStone_moss3"]), 8);
  }
}

/** Resource node at this hex, or null. Deterministic and independent of every
 *  other hex, so a chunk can be built (and rebuilt) in isolation. */
export function scatterAt(
  col: number,
  row: number,
  seed: number,
  biome: BiomeType,
): ScatterEntry | null {
  if (biome === "water" || biome === "lava") return null;

  // A landmark overrides the ordinary scatter for its own hexes: whatever the
  // ground would have grown, this is a place, and it looks arranged.
  const here = landmarkAt(col, row, seed);
  if (here) {
    const entry = landmarkScatter(here.mark, here.dist, hash2(col, row, seed ^ 0x632be59b));
    // A pit is centred on its biome but reaches 2.6 hexes out, which is
    // enough to cross a border — and ore lying one hex into the grass would
    // break the only promise the whole economy makes, that a material means a
    // place. Past the edge the pit is spoil: the rock, without the seam in it.
    if (entry && isSeam(entry.kind) && seamOf(biome) !== entry.kind) {
      return { ...entry, kind: "rock", tint: undefined };
    }
    return entry;
  }

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

/**
 * Flat props scattered on the ground.
 *
 * NOT the pack's `hill*` sprites, which look like they belong here and don't:
 * they are flat-bottomed silhouettes with a hard straight edge, meant to sit
 * BEHIND a tile as the far side of rising ground. Dropped onto open ground
 * they read as a hard triangular spike sitting on nothing — and at 27% of all
 * decor, one every twenty-five hexes, they were everywhere. Everything below
 * is a real prop: shaded, with a base that meets the ground.
 */
const DECOR: Record<BiomeType, string[]> = {
  grass: ["bushGrass", "flowerRed", "flowerBlue", "flowerWhite", "smallRockGrass"],
  autumn: ["bushAutumn", "flowerYellow", "smallRockDirt"],
  magic: ["bushMagic", "flowerGreen"],
  dirt: ["bushDirt", "smallRockDirt"],
  sand: ["bushSand", "smallRockDirt"],
  stone: ["smallRockStone"],
  rock: ["smallRockStone"],
  snow: ["bushSnow", "smallRockSnow"],
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

/**
 * Every texture a LANDMARK can put down.
 *
 * Enumerated separately because landmarks do not go through SCATTER — they
 * replace it — so a texture only a landmark uses was never preloaded. That is
 * not hypothetical: the grove is the one thing that asks for treeGreen, and
 * every grove in the world rendered as a grid of Phaser's missing-texture
 * squares until this existed.
 */
export const LANDMARK_KEYS = [
  ...new Set(
    (["stones", "grove", "pit"] as LandmarkKind[]).flatMap((kind) =>
      (Object.keys(SEAMS) as ExoticNode[]).flatMap((ore) =>
        // Across the whole radius and every variant: the rules vary what they
        // place with distance from the middle, so one sample would miss some.
        [0, 0.5, 1, 1.5, 2, 2.5].flatMap((dist) =>
          [0, 0.34, 0.67, 0.99].map(
            (v) => landmarkScatter({ kind, ore, col: 0, row: 0 }, dist, v)?.texture,
          ),
        ),
      ),
    ),
  ),
].filter((k): k is string => !!k);

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
