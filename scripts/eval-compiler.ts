// Spec-compiler eval: canned (name, intent, sketch) blueprints through the
// real pipeline, with the design invariants asserted per pair.
//
// TWO MODES.
//
//   replay (default) — free, deterministic, runs in `npm test`. Provider
//   responses come from fixtures/compiler/, recorded from real runs, and are
//   fed through the REAL orchestrator: real validation, real clamping, real
//   costing, every per-pair check. A prompt/schema/model change re-keys the
//   affected fixtures, so replay can never vouch for a prompt it hasn't seen
//   — those pairs show up as "no fixture" until the next live run.
//
//   --live — spends money (the user's paid-tier Gemini key), refreshes the
//   fixtures, and doubles as the model comparison table. Manual only, by the
//   user's explicit choice.
//
// Keys: GOOGLE_API_KEY / ANTHROPIC_API_KEY env vars (reads .env too).
//       A provider with no key is skipped, so it costs nothing by accident.

import { readFileSync } from "node:fs";
import { compileSpecWith } from "../shared/fabricator";
import type {
  CompileInput,
  CompilerConfig,
  FabricatedSpec,
  FabricatorProvider,
  ProviderResult,
} from "../shared/fabricator";
import { googleProvider } from "../shared/fabricator/providers/google";
import { anthropicProvider } from "../shared/fabricator/providers/anthropic";
import {
  appendHistory,
  listFixtures,
  loadFixture,
  replayProvider,
  saveFixture,
  type Fixture,
} from "./lib/fixtures";
import { sketchBase64, type SketchId } from "./lib/sketches";

// minimal .env loader so the script works without extra deps
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // no .env — rely on the environment
}

type Pair = {
  name: string;
  intent?: string;
  /** A canned drawing (scripts/lib/sketches.ts) — the multimodal path. */
  sketch?: SketchId;
  /** Display label, when several pairs share a name and differ by sketch. */
  label?: string;
  /** A modification of this existing spec, rather than a fresh invention. */
  parentSpec?: object;
  check: (s: FabricatedSpec) => string | null;
};

const ok = null;

/** A plain wheeled buggy, as a stored design's spec — the modification
 *  pairs' shared parent. */
const PARENT_BUGGY = {
  category: "vehicle",
  displayName: "Dune Buggy",
  size: { w: 80, h: 45 },
  locomotion: {
    type: "wheels",
    speed: 220,
    terrainModifiers: { grass: 0.95, sand: 1, swamp: 0.1, rock: 0.3, snow: 0.2, water: 0 },
  },
  seats: 1,
  flavor: "Kicks up sand and does not apologise.",
} as const;

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
    // Both real models answer "steam", which is more right than the "smoke"
    // this check originally demanded. The check was wrong, not the model.
    check: (s) =>
      (s.emission?.kind === "smoke" || s.emission?.kind === "steam") &&
      s.locomotion.type !== "none"
        ? ok
        : "expected a steam/smoke-emitting vehicle",
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
      s.weapon || s.nourish || s.ward || s.harvest || s.production
        ? `a bench should have no capabilities, got ${
            [
              s.weapon && "weapon",
              s.nourish && "nourish",
              s.ward && "ward",
              s.harvest && "harvest",
              s.production && "production",
            ]
              .filter(Boolean)
              .join("+")
          }`
        : ok,
  },
  {
    name: "Glass Kiln",
    intent: "Bakes stone into desert glass so nobody has to walk there.",
    check: (s) =>
      !s.production
        ? "expected production"
        : s.production.to !== "glass"
          ? `expected to=glass, got ${s.production.to}`
          : s.category !== "structure"
            ? "expected a structure"
            : ok,
  },
  {
    name: "Mining Pick",
    intent: "For breaking ore out of stone.",
    check: (s) =>
      s.weapon ? "a pick is a harvester, not a weapon" : s.harvest ? ok : "expected harvest",
  },
  // ── the sketch pairs ──
  //
  // Same name, different drawing. If these two compile to the same
  // locomotion, the sketch is not actually being read — the one thing the
  // multimodal path exists for, and the one thing no eval covered.
  {
    name: "Rover",
    sketch: "rover-wheels",
    label: "Rover (wheel sketch)",
    check: (s) => (s.locomotion.type === "wheels" ? ok : `expected wheels, got ${s.locomotion.type}`),
  },
  {
    name: "Rover",
    sketch: "rover-legs",
    label: "Rover (legs sketch)",
    check: (s) => (s.locomotion.type === "legs" ? ok : `expected legs, got ${s.locomotion.type}`),
  },
  {
    // The word "boat" appears nowhere — the hull has to come off the page.
    name: "Vessel",
    sketch: "hull-mast",
    label: "Vessel (hull sketch)",
    check: (s) =>
      s.locomotion.type === "float" || s.locomotion.terrainModifiers.water > 0
        ? ok
        : "the sketch is a boat and the spec cannot swim",
  },
  // ── the modification pairs ──
  //
  // Iterating on a design is the loop the Fabricator exists for: the parent
  // spec rides along and the model is told to change only what the new
  // blueprint implies. What matters is BOTH halves — the asked-for change
  // lands, and the rest survives.
  {
    name: "Dune Buggy Mk II",
    intent: "The same buggy, just faster.",
    parentSpec: PARENT_BUGGY,
    label: "Buggy + make it faster",
    check: (s) =>
      s.locomotion.type !== "wheels"
        ? `the wheels did not survive (got ${s.locomotion.type})`
        : s.locomotion.speed <= PARENT_BUGGY.locomotion.speed
          ? `no faster than the parent (${s.locomotion.speed} vs ${PARENT_BUGGY.locomotion.speed})`
          : s.category !== "vehicle"
            ? "stopped being a vehicle"
            : ok,
  },
  {
    name: "Mining Buggy",
    intent: "Bolt a stone drill onto the buggy.",
    parentSpec: PARENT_BUGGY,
    label: "Buggy + add a drill",
    check: (s) =>
      !s.harvest
        ? "the drill did not land"
        : s.locomotion.type !== "wheels"
          ? "the wheels did not survive"
          : ok,
  },
  {
    name: "Outpost",
    sketch: "tower-beam",
    label: "Outpost (tower sketch)",
    check: (s) =>
      s.category !== "structure"
        ? "expected a structure"
        : s.size.h >= s.size.w
          ? ok
          : `the sketch is tall, the spec is wide (${s.size.w}x${s.size.h})`,
  },
];

const CONFIGS: { config: CompilerConfig; keyVar: string; probe?: boolean }[] = [
  { config: { provider: "google", model: "gemini-3.6-flash" }, keyVar: "GOOGLE_API_KEY" },
  { config: { provider: "google", model: "gemini-3.5-flash-lite" }, keyVar: "GOOGLE_API_KEY" },
  // Probes: hung >25s in the 2026-08-24 probe, but that was free-tier
  // capacity gating and the account is on paid tier 1 now. Live runs measure
  // them; the scoring table is the instrument for choosing a new default.
  { config: { provider: "google", model: "gemini-3.7-flash" }, keyVar: "GOOGLE_API_KEY", probe: true },
  { config: { provider: "google", model: "gemini-flash-latest" }, keyVar: "GOOGLE_API_KEY", probe: true },
  { config: { provider: "anthropic", model: "claude-sonnet-5" }, keyVar: "ANTHROPIC_API_KEY" },
  { config: { provider: "anthropic", model: "claude-haiku-4-5" }, keyVar: "ANTHROPIC_API_KEY" },
];

const PROVIDERS: Record<string, FabricatorProvider> = {
  google: googleProvider,
  anthropic: anthropicProvider,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wraps the real provider so the raw response that ends the run is
 *  captured for the fixture — replay then re-validates that exact answer. */
function recording(inner: FabricatorProvider): {
  provider: FabricatorProvider;
  last: () => { raw: unknown; usage: ProviderResult["usage"] } | null;
} {
  let last: { raw: unknown; usage: ProviderResult["usage"] } | null = null;
  return {
    provider: {
      id: inner.id,
      async compileSpec(input, model, apiKey, signal) {
        const result = await inner.compileSpec(input, model, apiKey, signal);
        last = { raw: result.raw, usage: result.usage };
        return result;
      },
    },
    last: () => last,
  };
}

async function main() {
  const liveAll = process.argv.includes("--live");
  const liveMissing = process.argv.includes("--missing");
  const live = liveAll || liveMissing;
  console.log(
    liveAll
      ? "MODE: live — refreshing all fixtures"
      : liveMissing
        ? "MODE: live for pairs with no fixture only"
        : "MODE: replay (use --live to refresh, --missing to record only new pairs)",
  );

  // "Swamp Buggy swamp-modifier > Car's" is cross-pair; track per provider.
  const swampVsCar: Record<string, { car?: number; buggy?: number }> = {};
  let anyFailures = 0;

  for (const { config, keyVar, probe } of CONFIGS) {
    const apiKey = process.env[keyVar];
    const label = `${config.provider}/${config.model}`;
    if (live && !apiKey) {
      console.log(`\n─── ${label}: SKIPPED (no ${keyVar}) ───`);
      continue;
    }
    // Probes are for live model comparison only — and opt-in even then: the
    // 2026-08-25 probe verdict is that both hang ~30s per call even on paid
    // tier 1, so every routine --live would waste minutes re-confirming it.
    if (probe && !(live && process.argv.includes("--probe"))) continue;
    // A model with no fixtures at all (e.g. a provider we hold no key for)
    // is silence, not signal — skip it in replay rather than printing noise.
    if (!live && listFixtures(config.model).length === 0) continue;
    console.log(`\n─── ${label}${probe ? " (probe)" : ""} ───`);
    swampVsCar[label] = {};
    let totalIn = 0;
    let totalOut = 0;
    let passed = 0;
    let failed = 0;
    let missing = 0;
    let errorStreak = 0;

    for (const pair of PAIRS) {
      // Circuit breaker for live probes: a model that is simply unavailable
      // fails every pair the same way, and each failure costs up to three
      // 30s attempts. Three in a row is a verdict, not a sample.
      if (live && errorStreak >= 3) {
        console.log(`  … abandoning ${label}: ${errorStreak} consecutive errors`);
        break;
      }
      const display = pair.label ?? pair.name;
      const input: CompileInput = {
        name: pair.name,
        intent: pair.intent,
        imageBase64: pair.sketch ? sketchBase64(pair.sketch) : undefined,
        parentSpec: pair.parentSpec,
      };
      // --missing records only the pairs a full run has not covered — new
      // pairs get fixtures without re-buying the whole table.
      const useLive = liveAll || (liveMissing && !loadFixture(config, {
        name: pair.name,
        intent: pair.intent,
        imageBase64: pair.sketch ? sketchBase64(pair.sketch) : undefined,
        parentSpec: pair.parentSpec,
      }));
      try {
        let spec: FabricatedSpec;
        let attempts: number;
        let ms = 0;
        if (useLive) {
          const rec = recording(PROVIDERS[config.provider]);
          const t0 = Date.now();
          try {
            const outcome = await compileSpecWith(rec.provider, input, config, apiKey!);
            ms = Date.now() - t0;
            spec = outcome.spec;
            attempts = outcome.attempts;
            totalIn += outcome.usage.inputTokens;
            totalOut += outcome.usage.outputTokens;
            const fixture: Fixture = {
              meta: {
                name: pair.name,
                intent: pair.intent,
                hasSketch: !!pair.sketch,
                model: config.model,
                recordedAt: new Date().toISOString(),
                attempts,
              },
              raw: rec.last()!.raw,
              usage: rec.last()!.usage,
            };
            saveFixture(config, input, fixture);
          } catch (err) {
            // A failed live run is a recordable fact too: replay will
            // reproduce the failure until a later live run heals it.
            saveFixture(config, input, {
              meta: {
                name: pair.name,
                intent: pair.intent,
                hasSketch: !!pair.sketch,
                model: config.model,
                recordedAt: new Date().toISOString(),
                attempts: 0,
              },
              error: (err as Error).message.slice(0, 300),
            });
            throw err;
          } finally {
            await sleep(1000); // paid tier: modest pacing, not free-tier crawling
          }
        } else {
          const fixture = loadFixture(config, input);
          if (!fixture) {
            missing++;
            continue;
          }
          const t0 = Date.now();
          const outcome = await compileSpecWith(replayProvider(fixture), input, config, "replay");
          ms = Date.now() - t0;
          spec = outcome.spec;
          attempts = fixture.meta.attempts;
        }

        const problem = pair.check(spec);
        if (problem) failed++;
        else passed++;
        const t = spec.locomotion.terrainModifiers;
        const extras =
          (spec.harvest ? ` hv=${spec.harvest.rate.toFixed(1)}/${spec.harvest.materials.join("+")}` : "") +
          (spec.emission ? ` em=${spec.emission.kind}@${spec.emission.intensity.toFixed(1)}` : "");
        console.log(
          `${problem ? "✗" : "✓"} ${display.padEnd(22)} ${spec.category.padEnd(10)}` +
            ` ${spec.locomotion.type.padEnd(7)} v=${String(Math.round(spec.locomotion.speed)).padStart(3)}` +
            ` g/s/w=${t.grass.toFixed(2)}/${t.sand.toFixed(2)}/${t.swamp.toFixed(2)}` +
            ` cost=${spec.cost.total}${extras}${useLive ? ` ${ms}ms` : ""} atts=${attempts}` +
            (problem ? `  ← ${problem}` : ""),
        );
        if (pair.name === "Car") swampVsCar[label].car = t.swamp;
        if (pair.name === "Swamp Buggy") swampVsCar[label].buggy = t.swamp;
        errorStreak = 0;
      } catch (err) {
        failed++;
        errorStreak++;
        console.log(`✗ ${display.padEnd(22)} ERROR: ${(err as Error).message.slice(0, 120)}`);
      }
    }

    const sc = swampVsCar[label];
    if (sc.car !== undefined && sc.buggy !== undefined) {
      const okRel = sc.buggy > sc.car;
      if (!okRel) failed++;
      console.log(
        `${okRel ? "✓" : "✗"} invariant: Swamp Buggy swamp (${sc.buggy.toFixed(2)})` +
          ` > Car swamp (${sc.car.toFixed(2)})`,
      );
    }
    const ran = passed + failed;
    console.log(
      `score: ${passed}/${ran} passed` +
        (missing ? ` · ${missing} pair(s) have no fixture` : "") +
        (live ? ` · tokens in=${totalIn} out=${totalOut}` : ""),
    );
    if (ran > 0) {
      appendHistory({
        at: new Date().toISOString(),
        mode: live ? "live" : "replay",
        model: config.model,
        passed,
        failed,
        missing,
        tokensIn: totalIn,
        tokensOut: totalOut,
      });
    }
    anyFailures += failed;
  }

  // Replay is a regression gate: a recorded answer that stops passing means
  // OUR code changed the outcome, and that must fail loudly.
  process.exit(anyFailures > 0 ? 1 : 0);
}

main();
