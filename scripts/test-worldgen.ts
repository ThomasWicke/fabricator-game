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
  landmarkAt,
  regionAt,
  regionName,
  sample,
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

console.log("\n── rivers ──────────────────────────────────────────────────");

for (const seedStr of SEEDS.slice(0, 3)) {
  const seed = worldSeed(seedStr);
  let land = 0;
  let river = 0;
  let bank = 0;
  // Rivers are inland water: above sea level but still wet.
  for (let row = -110; row <= 110; row++) {
    for (let col = -110; col <= 110; col++) {
      const t = sample(col, row, seed);
      if (t.elevation < 0.418) continue;
      land++;
      if (t.biome === "water") river++;
      else if (t.biome === "sand" && t.elevation > 0.446) bank++;
    }
  }
  const pct = (river / land) * 100;
  console.log(
    `  ${seedStr.padEnd(14)} ${pct.toFixed(1)}% of land is river, ` +
      `${((bank / land) * 100).toFixed(1)}% is bank`,
  );
  // Present enough to meet, not so much that the map is a delta.
  check(`${seedStr}: rivers are a feature, not a flood`, pct > 0.8 && pct < 14, `${pct.toFixed(1)}%`);
  check(`${seedStr}: rivers carry banks`, bank > river * 0.3, `${bank} banks / ${river} water`);
}

console.log("\n── regions ────────────────────────────────────────────────");

{
  const seed = worldSeed("FABR");
  // The property that matters: a name is computed, never agreed. Two clients
  // that never speak must produce the same word for the same ground.
  let stable = true;
  const names = new Map<string, number>();
  for (let i = 0; i < 400; i++) {
    const col = ((i * 7919) % 600) - 300;
    const row = ((i * 104729) % 600) - 300;
    const a = regionName(regionAt(col, row, seed), seed);
    const b = regionName(regionAt(col, row, seed), seed);
    if (a !== b) stable = false;
    names.set(a, (names.get(a) ?? 0) + 1);
  }
  check("a region's name is the same every time it is asked", stable);

  // …and a different world names its ground differently.
  const other = worldSeed("FABS");
  let differs = 0;
  for (let i = 0; i < 200; i++) {
    const col = (i % 40) - 20;
    const row = Math.floor(i / 40) - 2;
    if (regionName(regionAt(col, row, seed), seed) !== regionName(regionAt(col, row, other), other)) {
      differs++;
    }
  }
  check("a different room code names its ground differently", differs > 150, `${differs}/200`);

  // Regions have to be big enough to be worth naming and small enough to cross.
  const counts = [...names.values()];
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`  ${names.size} distinct names over 400 samples, ~${avg.toFixed(1)} samples each`);
  console.log(`  e.g. ${[...names.keys()].slice(0, 6).join(" · ")}`);
  check("regions are neither one big place nor all different", names.size > 8 && names.size < 300, `${names.size}`);

  // Walking in a straight line should cross a few, not dozens.
  let crossings = 0;
  let prev = regionAt(0, 0, seed);
  for (let col = 0; col < 200; col++) {
    const r = regionAt(col, 0, seed);
    if (r.rx !== prev.rx || r.ry !== prev.ry) crossings++;
    prev = r;
  }
  console.log(`  walking 200 hexes east crosses ${crossings} regions`);
  check("a region takes a while to walk out of", crossings >= 3 && crossings <= 14, `${crossings}`);
}

console.log("\n── landmarks ──────────────────────────────────────────────");

for (const seedStr of SEEDS.slice(0, 3)) {
  const seed = worldSeed(seedStr);
  const kinds = new Map<string, number>();
  const centres = new Set<string>();
  let hexes = 0;
  for (let row = -110; row <= 110; row++) {
    for (let col = -110; col <= 110; col++) {
      hexes++;
      const l = landmarkAt(col, row, seed);
      if (!l) continue;
      kinds.set(l.mark.kind, (kinds.get(l.mark.kind) ?? 0) + 1);
      centres.add(`${l.mark.col},${l.mark.row}`);
    }
  }
  const per10k = (centres.size / hexes) * 10_000;
  console.log(
    `  ${seedStr.padEnd(14)} ${centres.size} landmarks (${per10k.toFixed(1)} per 10k hexes) · ` +
      [...kinds].map(([k, v]) => `${k} ${v}hex`).join(", "),
  );
  check(`${seedStr}: landmarks are rare but findable`, per10k > 2 && per10k < 40, per10k.toFixed(1));
  check(`${seedStr}: a landmark is a cluster, not one hex`, [...kinds.values()].every((v) => v > centres.size), "");
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
