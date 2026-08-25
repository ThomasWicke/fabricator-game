// Checks on the wildlife. No rendering, no API — the balance and the
// placement are both pure data.
//
// The point of this file is one promise: you can always get away. That is not
// a feeling, it is an inequality between two numbers, and it is exactly the
// kind of thing that quietly stops being true when somebody nudges a speed to
// make a chase feel more exciting.
//
// Run: npx tsx scripts/test-enemies.ts

import {
  AGGRO_RANGE,
  HUNGRY_SPEED,
  LEASH_RANGE,
  LOSE_RANGE,
  SAFE_RADIUS,
  SPECIES,
  SPRINT_MULT,
  WALK_SPEED,
  nativeTo,
  nestAt,
  type SpeciesId,
} from "../client/src/screen/enemies";
import { biomeAt, worldSeed, findSpawn, type BiomeType } from "../client/src/screen/worldgen";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

console.log("\n── you can always get away ─────────────────────────────────");

const sprint = WALK_SPEED * SPRINT_MULT;
const hungryWalk = WALK_SPEED * HUNGRY_SPEED;
const hungrySprint = WALK_SPEED * HUNGRY_SPEED * SPRINT_MULT;
console.log(
  `  player: walk ${WALK_SPEED} · sprint ${sprint.toFixed(0)} · ` +
    `hungry walk ${hungryWalk.toFixed(0)} · hungry sprint ${hungrySprint.toFixed(0)}\n`,
);

for (const [id, s] of Object.entries(SPECIES) as [SpeciesId, (typeof SPECIES)[SpeciesId]][]) {
  console.log(`  ${id.padEnd(7)} speed ${String(s.speed).padStart(4)}  dmg ${s.damage}  hp ${s.health}`);
  // The brief was "a little slower than the player so I can outrun them".
  // Slower than a WALK, so strolling away is enough and running is a luxury.
  check(`${id} is slower than a walking player`, s.speed < WALK_SPEED, `${s.speed} < ${WALK_SPEED}`);
  // And with real headroom against the worst case a player can be in.
  check(
    `${id} is well clear of a hungry sprint`,
    s.speed < hungrySprint * 0.85,
    `${s.speed} < ${(hungrySprint * 0.85).toFixed(0)}`,
  );
  // Not so slow it can never touch you, or it stops being a hazard at all.
  check(`${id} is faster than a hungry walk`, s.speed > hungryWalk, `${s.speed} > ${hungryWalk.toFixed(0)}`);
  check(`${id} cannot one-shot a full-health player`, s.damage < 100, `${s.damage}`);
  check(`${id} dies to a handful of bare-handed shoves`, s.health <= 4, `${s.health}`);
}

console.log("\n── they give up ────────────────────────────────────────────");
check("noticing you is closer than losing you", AGGRO_RANGE < LOSE_RANGE, `${AGGRO_RANGE} < ${LOSE_RANGE}`);
check("the leash is longer than the chase", LOSE_RANGE < LEASH_RANGE, `${LOSE_RANGE} < ${LEASH_RANGE}`);
// At the slowest species, how long does outrunning one actually take?
const slowest = Math.min(...Object.values(SPECIES).map((s) => s.speed));
const fastest = Math.max(...Object.values(SPECIES).map((s) => s.speed));
const gain = sprint - fastest;
console.log(
  `  sprinting gains ${gain.toFixed(0)} px/s on the fastest (${fastest}); ` +
    `breaking from ${AGGRO_RANGE} to ${LOSE_RANGE} takes ~${((LOSE_RANGE - AGGRO_RANGE) / gain).toFixed(1)}s`,
);
check("a sprint breaks contact in a few seconds", (LOSE_RANGE - AGGRO_RANGE) / gain < 5);
check("even a walk slowly gains ground", WALK_SPEED > fastest, `${WALK_SPEED} > ${fastest}`);
void slowest;

console.log("\n── where they live ─────────────────────────────────────────");

const SEEDS = ["FABR", "SOLO", "SURV", "room-7", "XKCD"];
for (const seedStr of SEEDS) {
  const seed = worldSeed(seedStr);
  const spawn = findSpawn(seed);
  let hexes = 0;
  let nests = 0;
  let nearSpawn = 0;
  const byKind = new Map<SpeciesId, number>();

  for (let row = spawn.row - 90; row <= spawn.row + 90; row++) {
    for (let col = spawn.col - 90; col <= spawn.col + 90; col++) {
      hexes++;
      const biome = biomeAt(col, row, seed) as BiomeType;
      const n = nestAt(col, row, seed, biome, spawn);
      if (!n) continue;
      const d = Math.hypot(col - spawn.col, (row - spawn.row) * 0.738);
      if (d < SAFE_RADIUS) nearSpawn++;
      nests++;
      byKind.set(n, (byKind.get(n) ?? 0) + 1);
    }
  }
  const per1000 = (nests / hexes) * 1000;
  console.log(
    `  ${seedStr.padEnd(8)} ${String(nests).padStart(3)} nests in ${hexes} hexes ` +
      `(${per1000.toFixed(1)}/1000) · ${[...byKind].map(([k, v]) => `${k} ${v}`).join(", ")}`,
  );
  // Nests are a destination, not scenery: common enough to meet, rare enough
  // that meeting one means something.
  check(`${seedStr}: nests are rare but present`, per1000 > 0.4 && per1000 < 12, per1000.toFixed(1));
  // The one hard guarantee — the landing site is safe ground.
  check(`${seedStr}: none within the safe radius of spawn`, nearSpawn === 0, `${nearSpawn} found`);
}

console.log("\n── the plains are safe ─────────────────────────────────────");
// Grass is where you land and where you learn; nothing should live there.
check("nothing is native to plains", nativeTo("grass") === null);
check("nothing is native to open water", nativeTo("water") === null);
check("something is native to the bog", nativeTo("magic") !== null, String(nativeTo("magic")));

console.log(
  failures === 0 ? "\n✓ all enemy checks passed\n" : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
