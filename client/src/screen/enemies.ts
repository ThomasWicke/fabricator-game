// Wildlife: what lives where, and where it lives.
//
// The whole design brief for these is "stress-free". They are a hazard to
// route around, not a combat system: every one of them is slower than a
// running player, they give up when you get clear, and they never stray far
// from home. Dying to one costs you the load on your back and a walk — see
// killPlayer in world.ts.
//
// Placement is deterministic like everything else in the world: a nest is a
// pure function of (hex, seed), so the bog that was full of slimes yesterday
// is full of slimes today, and two players see the same one.

import type { BiomeType } from "./worldgen";

/**
 * Player movement, and the chase geometry, live here rather than in world.ts.
 *
 * That looks like the wrong home for them until you try to check the one
 * promise this whole system makes — that you can always get away. The promise
 * is a *relationship* between two numbers, so the two numbers have to be
 * reviewable, and testable, side by side. world.ts imports these;
 * scripts/test-enemies.ts asserts the relationship, which it could not do if
 * they lived in a module that needs a browser to load.
 */
export const WALK_SPEED = 220;
export const SPRINT_MULT = 1.65;
/** Speed multiplier while hungry — the slowest a player can ever be. */
export const HUNGRY_SPEED = 0.72;

/** Aggro radius by day. Night widens it — the dark is when a bog gets nasty. */
export const AGGRO_RANGE = 210;
export const AGGRO_NIGHT_BONUS = 0.55;
/** Past this distance, the chase starts timing out. */
export const LOSE_RANGE = 430;
/** Seconds beyond LOSE_RANGE before they lose interest entirely. */
export const LOSE_TIME = 2.4;
/** However interesting you are, they will not follow further than this from
 *  their nest. This is the promise that you can always leave. */
export const LEASH_RANGE = 620;

export type SpeciesId = "spider" | "snake" | "mouse" | "bat" | "slime";

export type Species = {
  /** Idle texture, and the walk cycle (idle frame included where the pack
   *  only ships one walking pose). */
  idle: string;
  walk: string[];
  hit: string;
  dead: string;
  /** Pixels per second on ideal ground, before terrain modifiers.
   *
   *  Every one of these sits BELOW a walking player. Walking away has to be
   *  enough — that is the brief, and anything faster turns a hazard you route
   *  around into a chase you have to win. Terrain scales both sides equally,
   *  so the margin holds in the bog as well as on the plain. */
  speed: number;
  /** Contact damage per bite. */
  damage: number;
  /** Bare-handed shoves needed to see it off. */
  health: number;
  /** Display height in world pixels; art is scaled to it. */
  size: number;
  /** How many can be alive from one nest at a time. */
  brood: number;
};

export const SPECIES: Record<SpeciesId, Species> = {
  spider: {
    idle: "spider",
    walk: ["spider_walk1", "spider_walk2"],
    hit: "spider_hit",
    dead: "spider_dead",
    speed: 196,
    damage: 8,
    health: 3,
    size: 26,
    brood: 3,
  },
  snake: {
    idle: "snake",
    walk: ["snake", "snake_walk"],
    hit: "snake_hit",
    dead: "snake_dead",
    speed: 190,
    damage: 10,
    health: 3,
    size: 20,
    brood: 2,
  },
  mouse: {
    idle: "mouse",
    walk: ["mouse", "mouse_walk"],
    hit: "mouse_hit",
    dead: "mouse_dead",
    speed: 202,
    damage: 6,
    health: 2,
    size: 20,
    brood: 3,
  },
  bat: {
    idle: "bat",
    walk: ["bat", "bat_fly"],
    hit: "bat_hit",
    dead: "bat_dead",
    speed: 205,
    damage: 7,
    health: 2,
    size: 24,
    brood: 3,
  },
  slime: {
    idle: "slimeGreen",
    walk: ["slimeGreen", "slimeGreen_walk"],
    hit: "slimeGreen_hit",
    dead: "slimeGreen_dead",
    speed: 178,
    damage: 11,
    health: 4,
    size: 24,
    brood: 2,
  },
};

/** Every texture the enemies need, for preloading. */
export const ENEMY_KEYS = [
  ...new Set(
    Object.values(SPECIES).flatMap((s) => [s.idle, ...s.walk, s.hit, s.dead]),
  ),
];

/** Who lives on this ground. Biomes not listed are simply empty — the plains
 *  around the landing site are meant to be the safe part of the map. */
const NATIVE: Partial<Record<BiomeType, SpeciesId>> = {
  magic: "slime",
  autumn: "spider",
  dirt: "snake",
  sand: "snake",
  snow: "mouse",
  stone: "bat",
  rock: "bat",
};

export const nativeTo = (b: BiomeType): SpeciesId | null => NATIVE[b] ?? null;

/** Chance per eligible hex of holding a nest. Rare: a nest anchors a patch of
 *  territory, and territory you meet every few steps is just a corridor. */
const NEST_CHANCE = 0.006;

/** No nests within this many hexes of the landing site. The area around the
 *  Fabricator is where you learn the game and where you retreat to. */
export const SAFE_RADIUS = 16;

/** Hash a hex to [0,1) — same construction as worldgen's, salted apart so a
 *  nest never lands on the same roll that placed a boulder. */
function nestHash(ix: number, iy: number, seed: number): number {
  let h = (seed ^ 0x5bf03635) ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Is there a nest on this hex, and whose? Pure, so chunks can ask freely.
 *
 * The safe radius is enforced HERE rather than by whoever happens to be
 * spawning things. It is a guarantee about the world, not a rendering
 * detail — if it lived in the caller then a minimap, or a second spawner
 * added later, would happily show burrows in the one place the game promises
 * there are none.
 */
export function nestAt(
  col: number,
  row: number,
  seed: number,
  biome: BiomeType,
  spawn: { col: number; row: number },
): SpeciesId | null {
  const species = nativeTo(biome);
  if (!species) return null;
  // Rows sit closer together than columns, so the radius is measured in the
  // same squashed space the rest of the world uses.
  if (Math.hypot(col - spawn.col, (row - spawn.row) * 0.738) < SAFE_RADIUS) return null;
  return nestHash(col, row, seed) < NEST_CHANCE ? species : null;
}
