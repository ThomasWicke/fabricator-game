// Spec-compiler eval: runs canned (name, intent) pairs through each provider
// with a configured key, asserts the design invariants, and prints a
// comparison table with measured token usage (doubles as the cost meter).
//
// This is the ONE script here that spends money — 22 pairs per configured
// provider, sequential. Everything else under scripts/ is free and runs in
// CI; this is opt-in, on purpose.
//
// Run:  npx tsx scripts/eval-compiler.ts
// Keys: GOOGLE_API_KEY / ANTHROPIC_API_KEY env vars (reads .env too).
//       A provider with no key is skipped, so it costs nothing by accident.
// Throttles itself (sequential, 6s apart) to stay under Gemini free-tier
// rate limits. No sketch images in the canned set — the name is the strong
// semantic signal; sketch interpretation is evaluated interactively in-game.

import { readFileSync } from "node:fs";
import { compileSpec } from "../shared/fabricator";
import type { CompilerConfig, FabricatedSpec } from "../shared/fabricator";

// minimal .env loader so the script works without extra deps
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // no .env — rely on the environment
}

type Pair = { name: string; intent?: string; check: (s: FabricatedSpec) => string | null };

const ok = null;
const PAIRS: Pair[] = [
  {
    name: "Car",
    check: (s) =>
      s.category === "vehicle" && s.locomotion.type !== "none" ? ok : "expected drivable vehicle",
  },
  {
    name: "Swamp Buggy",
    intent: "A vehicle for crossing swamps.",
    check: (s) => (s.locomotion.terrainModifiers.swamp >= 0.4 ? ok : "swamp modifier too low"),
  },
  {
    name: "Stone Hut",
    check: (s) => (s.locomotion.type === "none" && s.locomotion.speed === 0 ? ok : "should be static"),
  },
  {
    name: "Racing Buggy",
    intent: "As fast as possible on firm ground.",
    check: (s) => (s.locomotion.speed >= 250 ? ok : "expected high speed"),
  },
  {
    name: "Mud Raft",
    check: (s) => (s.locomotion.type === "float" || s.locomotion.terrainModifiers.swamp >= 0.5 ? ok : "expected float/swamp-capable"),
  },
  {
    name: "Spider Walker",
    check: (s) => (s.locomotion.type === "legs" ? ok : "expected legs"),
  },
  {
    name: "Cargo Hauler",
    intent: "Slow but big, for moving resources.",
    check: (s) => (s.size.w >= 100 ? ok : "expected large body"),
  },
  {
    name: "Beach Cruiser",
    check: (s) => (s.locomotion.terrainModifiers.sand >= 0.6 ? ok : "sand modifier too low"),
  },
  {
    name: "Watchtower",
    check: (s) => (s.category === "structure" ? ok : "expected structure"),
  },
  {
    name: "All-Terrain Tank",
    check: (s) => {
      const t = s.locomotion.terrainModifiers;
      return Math.min(t.grass, t.sand, t.swamp) >= 0.3 ? ok : "expected all-terrain capability";
    },
  },
  // ── v1 primitives: harvest + emission ──
  {
    name: "Sturdy Axe",
    intent: "For chopping trees.",
    check: (s) =>
      s.category === "tool" && s.harvest?.materials.includes("wood")
        ? ok
        : "expected wood-harvesting tool",
  },
  {
    name: "Mining Drill",
    intent: "A handheld drill for extracting ore from rock.",
    check: (s) =>
      s.harvest && (s.harvest.materials.includes("stone") || s.harvest.materials.includes("bogiron"))
        ? ok
        : "expected stone/bogiron harvest",
  },
  {
    name: "Logging Truck",
    intent: "Drives around cutting down trees.",
    check: (s) =>
      s.category === "vehicle" && s.harvest?.materials.includes("wood")
        ? ok
        : "expected wood-harvesting vehicle",
  },
  {
    name: "Lantern",
    check: (s) => (s.emission?.kind === "light" ? ok : "expected light emission"),
  },
  {
    name: "Steam Tractor",
    check: (s) =>
      s.emission?.kind === "smoke" && s.locomotion.type !== "none"
        ? ok
        : "expected smoking vehicle",
  },
  // ── weapon / storage / nourish / ward ──
  //
  // These four shipped after this eval was written, so nothing was checking
  // that the prompt actually reached them. Each pair below is one primitive
  // the compiler must select, plus the two ways it most plausibly gets it
  // wrong: reaching for a primitive that was not asked for, and confusing a
  // mining pick for a weapon.
  {
    name: "Iron Spear",
    intent: "For fighting off animals.",
    check: (s) =>
      s.weapon && s.category === "tool"
        ? s.weapon.reach >= 40
          ? ok
          : `weapon reach ${s.weapon.reach} is shorter than bare hands`
        : "expected a handheld weapon",
  },
  {
    name: "Heavy Maul",
    intent: "A huge two-handed hammer. Slow, and it hits like a falling tree.",
    check: (s) =>
      !s.weapon
        ? "expected a weapon"
        : s.weapon.damage >= 14 && s.weapon.cooldown >= 0.5
          ? ok
          : `expected slow and heavy, got ${s.weapon.damage} dmg / ${s.weapon.cooldown}s`,
  },
  {
    name: "Grain Silo",
    check: (s) => (s.storage && s.storage.capacity >= 4 ? ok : "expected storage capacity"),
  },
  {
    name: "Pack Frame",
    intent: "A harness that lets you carry far more than your arms can.",
    check: (s) =>
      s.category === "tool" && s.storage ? ok : "expected a tool that enlarges the pack",
  },
  {
    name: "Greenhouse",
    intent: "Grows food under glass.",
    check: (s) =>
      s.nourish && s.category === "structure" ? ok : "expected a food-producing structure",
  },
  {
    name: "Scarecrow",
    intent: "Keeps the creatures off the crops.",
    check: (s) =>
      s.ward && s.category === "structure" ? ok : "expected a warding structure",
  },
  // The discipline cases. Most things have none of these primitives, and a
  // compiler that reaches for them anyway inflates every bill in the game.
  {
    name: "Wooden Bench",
    intent: "Somewhere to sit.",
    check: (s) =>
      s.weapon || s.nourish || s.ward || s.harvest
        ? `a bench should have no capabilities, got ${
            [
              s.weapon && "weapon",
              s.nourish && "nourish",
              s.ward && "ward",
              s.harvest && "harvest",
            ]
              .filter(Boolean)
              .join("+")
          }`
        : ok,
  },
  {
    name: "Mining Pick",
    intent: "For breaking ore out of stone.",
    check: (s) =>
      s.weapon ? "a pick is a harvester, not a weapon" : s.harvest ? ok : "expected harvest",
  },
];

const CONFIGS: { config: CompilerConfig; keyVar: string }[] = [
  { config: { provider: "google", model: "gemini-3.6-flash" }, keyVar: "GOOGLE_API_KEY" },
  { config: { provider: "google", model: "gemini-3.5-flash-lite" }, keyVar: "GOOGLE_API_KEY" },
  { config: { provider: "anthropic", model: "claude-sonnet-5" }, keyVar: "ANTHROPIC_API_KEY" },
  { config: { provider: "anthropic", model: "claude-haiku-4-5" }, keyVar: "ANTHROPIC_API_KEY" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // "Swamp Buggy swamp-modifier > Car's" is cross-pair; track per provider.
  const swampVsCar: Record<string, { car?: number; buggy?: number }> = {};

  for (const { config, keyVar } of CONFIGS) {
    const apiKey = process.env[keyVar];
    const label = `${config.provider}/${config.model}`;
    if (!apiKey) {
      console.log(`\n─── ${label}: SKIPPED (no ${keyVar}) ───`);
      continue;
    }
    console.log(`\n─── ${label} ───`);
    swampVsCar[label] = {};
    let totalIn = 0;
    let totalOut = 0;

    for (const pair of PAIRS) {
      try {
        const t0 = Date.now();
        const { spec, usage, attempts } = await compileSpec(
          { name: pair.name, intent: pair.intent },
          config,
          apiKey,
        );
        totalIn += usage.inputTokens;
        totalOut += usage.outputTokens;
        const problem = pair.check(spec);
        const t = spec.locomotion.terrainModifiers;
        const extras =
          (spec.harvest ? ` hv=${spec.harvest.rate.toFixed(1)}/${spec.harvest.materials.join("+")}` : "") +
          (spec.emission ? ` em=${spec.emission.kind}@${spec.emission.intensity.toFixed(1)}` : "");
        console.log(
          `${problem ? "✗" : "✓"} ${pair.name.padEnd(18)} ${spec.category.padEnd(10)}` +
            ` ${spec.locomotion.type.padEnd(7)} v=${String(Math.round(spec.locomotion.speed)).padStart(3)}` +
            ` g/s/w=${t.grass.toFixed(2)}/${t.sand.toFixed(2)}/${t.swamp.toFixed(2)}` +
            ` cost=${spec.cost.total}(${spec.cost.wood}w/${spec.cost.stone}s/${spec.cost.bogiron}b)` +
            `${extras} ${Date.now() - t0}ms atts=${attempts}` +
            (problem ? `  ← ${problem}` : ""),
        );
        if (pair.name === "Car") swampVsCar[label].car = t.swamp;
        if (pair.name === "Swamp Buggy") swampVsCar[label].buggy = t.swamp;
      } catch (err) {
        console.log(`✗ ${pair.name.padEnd(18)} ERROR: ${(err as Error).message.slice(0, 120)}`);
      }
      await sleep(6000);
    }

    const sc = swampVsCar[label];
    if (sc.car !== undefined && sc.buggy !== undefined) {
      console.log(
        `${sc.buggy > sc.car ? "✓" : "✗"} invariant: Swamp Buggy swamp (${sc.buggy.toFixed(2)})` +
          ` > Car swamp (${sc.car.toFixed(2)})`,
      );
    }
    console.log(`tokens: in=${totalIn} out=${totalOut} across ${PAIRS.length} fabrications`);
  }
}

main();
