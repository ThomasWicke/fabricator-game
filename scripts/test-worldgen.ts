// Sanity checks for the continuous world generator. No API, no rendering —
// it samples the biome field directly, which is the whole point of keeping
// worldgen.ts a pure function.
//
// Run: npx tsx scripts/test-worldgen.ts

import {
  BIOMES,
  type BiomeType,
  biomeAt,
  decorAt,
  findSpawn,
  isLiquid,
  scatterAt,
  worldSeed,
} from "../client/src/screen/worldgen";

const SEEDS = ["FABR", "amber-glade", "XKCD", "room-7", "willow-silt"];
const SPAN = 260; // hexes sampled per axis — several continents wide

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const pct = (n: number, total: number) => `${((n / total) * 100).toFixed(1)}%`;

console.log("\n── biome distribution ──────────────────────────────────────");

const totals = Object.fromEntries(
  Object.keys(BIOMES).map((b) => [b, 0]),
) as Record<BiomeType, number>;
let sampled = 0;

for (const seedStr of SEEDS) {
  const seed = worldSeed(seedStr);
  const counts = Object.fromEntries(
    Object.keys(BIOMES).map((b) => [b, 0]),
  ) as Record<BiomeType, number>;
  for (let row = -SPAN / 2; row < SPAN / 2; row += 2) {
    for (let col = -SPAN / 2; col < SPAN / 2; col += 2) {
      counts[biomeAt(col, row, seed)]++;
    }
  }
  const n = (SPAN / 2) ** 2;
  sampled += n;
  for (const b of Object.keys(counts) as BiomeType[]) totals[b] += counts[b];

  const land = n - counts.water - counts.lava;
  console.log(
    `  ${seedStr.padEnd(14)} land ${pct(land, n).padStart(6)} · ` +
      (Object.keys(BIOMES) as BiomeType[])
        .map((b) => `${b} ${pct(counts[b], n)}`)
        .join(" · "),
  );
  check(`${seedStr}: land is a majority`, land / n > 0.55, pct(land, n));
}

console.log("\n  overall:");
for (const b of Object.keys(BIOMES) as BiomeType[]) {
  console.log(`    ${b.padEnd(8)} ${pct(totals[b], sampled).padStart(6)}`);
}

// Every biome must actually occur, or the art for it is dead weight and the
// classifier has an unreachable branch.
for (const b of Object.keys(BIOMES) as BiomeType[]) {
  check(`${b} occurs`, totals[b] > 0, pct(totals[b], sampled));
}
check(
  "water is present but not dominant",
  totals.water / sampled > 0.08 && totals.water / sampled < 0.42,
  pct(totals.water, sampled),
);
check(
  "bog is reachable but not everywhere",
  totals.magic / sampled > 0.02 && totals.magic / sampled < 0.25,
  pct(totals.magic, sampled),
);
check("lava is rare", totals.lava / sampled < 0.02, pct(totals.lava, sampled));

console.log("\n── spawn ───────────────────────────────────────────────────");

for (const seedStr of SEEDS) {
  const seed = worldSeed(seedStr);
  const spawn = findSpawn(seed);
  let wet = 0;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (isLiquid(biomeAt(spawn.col + dc, spawn.row + dr, seed))) wet++;
    }
  }
  const b = biomeAt(spawn.col, spawn.row, seed);
  console.log(
    `  ${seedStr.padEnd(14)} (${spawn.col},${spawn.row}) on ${b}, ${wet} wet neighbours`,
  );
  check(`${seedStr}: spawn is dry`, wet === 0);
  check(
    `${seedStr}: spawn is walkable ground`,
    b === "grass" || b === "autumn" || b === "dirt",
    b,
  );
  check(
    `${seedStr}: spawn is near the origin`,
    Math.max(Math.abs(spawn.col), Math.abs(spawn.row)) < 60,
  );
}

console.log("\n── determinism ─────────────────────────────────────────────");

{
  const seed = worldSeed("FABR");
  const twice = (fn: (c: number, r: number) => unknown) => {
    for (let i = 0; i < 500; i++) {
      const c = ((i * 7919) % 800) - 400;
      const r = ((i * 104729) % 800) - 400;
      if (JSON.stringify(fn(c, r)) !== JSON.stringify(fn(c, r))) return false;
    }
    return true;
  };
  check("biomeAt is stable", twice((c, r) => biomeAt(c, r, seed)));
  check(
    "scatterAt is stable",
    twice((c, r) => scatterAt(c, r, seed, biomeAt(c, r, seed))),
  );
  check(
    "decorAt is stable",
    twice((c, r) => decorAt(c, r, seed, biomeAt(c, r, seed))),
  );

  // A different room code must be a different world, or the room code isn't
  // doing the one job it has.
  const other = worldSeed("FABS");
  let same = 0;
  for (let i = 0; i < 2000; i++) {
    const c = (i % 100) - 50;
    const r = Math.floor(i / 100) - 10;
    if (biomeAt(c, r, seed) === biomeAt(c, r, other)) same++;
  }
  check("a different room code is a different world", same / 2000 < 0.6, pct(same, 2000));
}

console.log("\n── scatter density ─────────────────────────────────────────");

{
  const seed = worldSeed("FABR");
  const perBiome = new Map<BiomeType, { hexes: number; nodes: number; bogiron: number }>();
  for (let row = -200; row < 200; row++) {
    for (let col = -200; col < 200; col++) {
      const b = biomeAt(col, row, seed);
      const e = perBiome.get(b) ?? { hexes: 0, nodes: 0, bogiron: 0 };
      e.hexes++;
      const s = scatterAt(col, row, seed, b);
      if (s) {
        e.nodes++;
        if (s.kind === "bogiron") e.bogiron++;
      }
      perBiome.set(b, e);
    }
  }
  for (const [b, e] of [...perBiome].sort((a, x) => x[1].hexes - a[1].hexes)) {
    console.log(
      `  ${b.padEnd(8)} ${String(e.hexes).padStart(6)} hexes · ` +
        `${pct(e.nodes, e.hexes).padStart(6)} carry a node`,
    );
    if (!isLiquid(b)) {
      check(`${b}: node density is playable`, e.nodes / e.hexes > 0.01 && e.nodes / e.hexes < 0.3);
    } else {
      check(`${b}: liquid carries nothing`, e.nodes === 0);
    }
  }
  const bog = perBiome.get("magic");
  check("bogiron exists in the bog", !!bog && bog.bogiron > 0, `${bog?.bogiron ?? 0} deposits`);
}

console.log(
  failures === 0
    ? "\n✓ all worldgen checks passed\n"
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
