// Deterministic checks for clampSpec + computeCost. No API calls — run it
// freely: npx tsx scripts/test-cost.ts
//
// Guards the "balance is computable" thesis: a spec's cost must depend only
// on meaningful capability, never on fields the compiler fills in
// arbitrarily — and the material split must never deadlock progression.

import { SYSTEM_PROMPT } from "../shared/fabricator/prompt";
import {
  EMISSION_KINDS,
  RANGES,
  LOCOMOTION_TYPES,
  MATERIALS,
  SPEC_JSON_SCHEMA,
  TERRAINS,
  clampSpec,
  type MaterialType,
  type RawSpec,
} from "../shared/fabricator/schema";
import { computeCost, formatCost } from "../shared/fabricator/cost";
import { mockCompile } from "../shared/fabricator/mock";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures++;
}

const structure = (mods: RawSpec["locomotion"]["terrainModifiers"]): RawSpec => ({
  category: "structure",
  displayName: "Hut",
  size: { w: 120, h: 100 },
  locomotion: { type: "none", speed: 0, terrainModifiers: mods },
  seats: 0,
  flavor: "x",
});

// Observed in the eval: one structure came back 1/1/1, another 0/0/0. Those
// modifiers are dead weight on something that cannot move, so they must not
// reach the cost function.
const ones = clampSpec(structure({ grass: 1, sand: 1, swamp: 1, rock: 1, snow: 1, water: 1 }));
const zeros = clampSpec(structure({ grass: 0, sand: 0, swamp: 0, rock: 0, snow: 0, water: 0 }));
check(
  "immobile terrain modifiers are zeroed",
  Object.values(ones.locomotion.terrainModifiers).every((v) => v === 0),
);
check(
  "identical structures cost the same regardless of dead fields",
  computeCost(ones).total === computeCost(zeros).total,
  `${computeCost(ones).total} vs ${computeCost(zeros).total}`,
);

// A vehicle claiming locomotion "none" is immobile too.
const stalled = clampSpec({
  ...structure({ grass: 1, sand: 1, swamp: 1, rock: 1, snow: 1, water: 1 }),
  category: "vehicle",
});
check("vehicle with locomotion 'none' gets speed 0", stalled.locomotion.speed === 0);

// Versatility must still be priced for things that actually move.
const vehicle = (
  type: RawSpec["locomotion"]["type"],
  mods: RawSpec["locomotion"]["terrainModifiers"],
): RawSpec => ({
  category: "vehicle",
  displayName: "V",
  size: { w: 84, h: 48 },
  locomotion: { type, speed: 180, terrainModifiers: mods },
  seats: 1,
  flavor: "x",
});
const car = computeCost(clampSpec(vehicle("wheels", { grass: 1, sand: 0.8, swamp: 0.15, rock: 0.35, snow: 0.2, water: 0 })));
const tank = computeCost(clampSpec(vehicle("tracks", { grass: 0.85, sand: 0.8, swamp: 0.6, rock: 0.7, snow: 0.65, water: 0 })));
check(
  "all-terrain costs more than a specialist",
  tank.total > car.total,
  `tank ${tank.total} > car ${car.total}`,
);

// Speed is bounded even if the compiler ignores the stated range.
const absurd = vehicle("wheels", { grass: 1, sand: 1, swamp: 1, rock: 1, snow: 1, water: 1 });
absurd.locomotion.speed = 9999;
check("absurd speed is clamped", clampSpec(absurd).locomotion.speed === 360);

// ── v1: material split ──

for (const [label, cost] of [["car", car], ["tank", tank]] as const) {
  check(
    `${label} material split sums to total`,
    cost.wood + cost.stone + cost.bogiron === cost.total,
    `${cost.wood}+${cost.stone}+${cost.bogiron}=${cost.total}`,
  );
}

// Swamp capability is the bogiron sink; a road car costs none.
check("road car needs no bogiron", car.bogiron === 0);
check("swamp-capable tank needs bogiron", tank.bogiron > 0, `${tank.bogiron}`);
const raft = computeCost(clampSpec(vehicle("float", { grass: 0.2, sand: 0.3, swamp: 0.9, rock: 0.15, snow: 0.3, water: 0.95 })));
check("float locomotion needs bogiron", raft.bogiron > 0);

// Water is the new gated capability: only a hull crosses it, and crossing it
// has to cost bogiron the same way the bog does.
const amphibian = computeCost(
  clampSpec(vehicle("wheels", { grass: 0.9, sand: 0.8, swamp: 0.3, rock: 0.4, snow: 0.3, water: 0.6 })),
);
check("water capability needs bogiron", amphibian.bogiron > 0, `${amphibian.bogiron}`);
check(
  "water capability costs more than the same machine without it",
  amphibian.total > car.total,
  `${amphibian.total} > ${car.total}`,
);

// NO CHICKEN-AND-EGG: the tool that unlocks bogiron gathering must itself
// never cost bogiron (tools are immobile → swamp capability is zeroed).
const drillTool = clampSpec({
  category: "tool",
  displayName: "Drill",
  size: { w: 36, h: 28 },
  locomotion: { type: "none", speed: 0, terrainModifiers: { grass: 1, sand: 1, swamp: 1, rock: 1, snow: 1, water: 1 } },
  harvest: { rate: 3, materials: ["stone", "bogiron"] },
  seats: 0,
  flavor: "x",
});
const drillCost = computeCost(drillTool);
check("bogiron-harvesting tool costs zero bogiron", drillCost.bogiron === 0, `${drillCost.bogiron}`);

// Harvest and emission add cost.
const plain = computeCost(clampSpec(vehicle("wheels", { grass: 0.9, sand: 0.8, swamp: 0.1, rock: 0.3, snow: 0.2, water: 0 })));
const harvester = clampSpec(vehicle("wheels", { grass: 0.9, sand: 0.8, swamp: 0.1, rock: 0.3, snow: 0.2, water: 0 }));
harvester.harvest = { rate: 3, materials: ["wood", "stone"] };
check(
  "harvest capability costs extra",
  computeCost(harvester).total > plain.total,
  `${computeCost(harvester).total} > ${plain.total}`,
);
const glowing = clampSpec(vehicle("wheels", { grass: 0.9, sand: 0.8, swamp: 0.1, rock: 0.3, snow: 0.2, water: 0 }));
glowing.emission = { kind: "light", intensity: 1 };
check("emission costs extra", computeCost(glowing).total > plain.total);

// Mock compiler must keep the offline progression loop intact.
const mockDrill = mockCompile({ name: "Mining Drill" });
check(
  "mock: 'Mining Drill' is a bogiron-capable tool",
  mockDrill.category === "tool" && (mockDrill.harvest?.materials.includes("bogiron") ?? false),
);
check("mock: drill tool affordable without bogiron", mockDrill.cost.bogiron === 0);
const mockBuggy = mockCompile({ name: "Swamp Buggy" });
check("mock: 'Swamp Buggy' costs bogiron", mockBuggy.cost.bogiron > 0);
const mockLantern = mockCompile({ name: "Lantern" });
check("mock: 'Lantern' emits light", mockLantern.emission?.kind === "light");

// ── the exotic gates ───────────────────────────────────────────────
//
// Each of the four materials is the price of one capability, and the shape of
// the whole progression is that wanting a thing sends you somewhere.

/** Immobile things have their modifiers zeroed anyway; naming it says so. */
const DRY = { grass: 0, sand: 0, swamp: 0, rock: 0, snow: 0, water: 0 };

const weaponised = clampSpec(structure(DRY));
weaponised.weapon = { damage: 20, reach: 90, cooldown: 0.6 };
const wcost = computeCost(weaponised);
check("a weapon is priced in basalt", wcost.basalt > 0, `${wcost.basalt}`);
check("…and nothing else exotic", wcost.glass === 0 && wcost.rime === 0 && wcost.bogiron === 0);

const farm = clampSpec(structure(DRY));
farm.nourish = { rate: 8 };
check("a farm is priced in glass", computeCost(farm).glass > 0);

const fence = clampSpec(structure(DRY));
fence.ward = { radius: 200 };
check("a ward is priced in rime", computeCost(fence).rime > 0);

// The campfire case, which shipped wrong: a structure that throws light,
// cooks a little, and keeps animals off the spot you sleep on is the FIRST
// thing anyone builds. Charging ore for the presence of ward and nourish
// priced one at 6 glass + 8 rime — a trek across a desert and a snowfield to
// light a fire. Ore prices the strong version of a capability now, so the
// whole plausible range of campfires has to come out clean.
for (const [rate, radius] of [
  [1, 60],
  [2, 80],
  [3, 120],
  [4, 150],
] as [number, number][]) {
  const fire = clampSpec(structure(DRY));
  fire.emission = { kind: "light", intensity: 0.7 };
  fire.nourish = { rate };
  fire.ward = { radius };
  const c = computeCost(fire);
  check(
    `a campfire (cooks ${rate}/min, wards ${radius}px) needs no ore`,
    c.bogiron + c.basalt + c.glass + c.rime === 0,
    formatCost(c),
  );
}

// Light is never gated at all. Lamps and fires are turn one.
const beacon = clampSpec(structure(DRY));
beacon.emission = { kind: "light", intensity: 1 };
const bc = computeCost(beacon);
check("emission alone costs no ore", bc.glass === 0 && bc.rime === 0, formatCost(bc));

// …and the strong versions still send you somewhere, which is the whole point
// of the ores existing. If these ever come out free, the map's edges are
// scenery again.
const spear = clampSpec(structure(DRY));
spear.category = "tool";
spear.weapon = { damage: 10, reach: 70, cooldown: 0.6 };
check("a crude spear is free of basalt", computeCost(spear).basalt === 0);

const maul = clampSpec(structure(DRY));
maul.category = "tool";
maul.weapon = { damage: 30, reach: 90, cooldown: 0.9 };
check("a real weapon still costs basalt", computeCost(maul).basalt >= 4, formatCost(computeCost(maul)));

const bigFarm = clampSpec(structure(DRY));
bigFarm.nourish = { rate: 9 };
check("a real farm still costs glass", computeCost(bigFarm).glass >= 3, formatCost(computeCost(bigFarm)));

const pylon = clampSpec(structure(DRY));
pylon.ward = { radius: 240 };
check("a settlement-sized ward still costs rime", computeCost(pylon).rime >= 4, formatCost(computeCost(pylon)));

// Nothing may ever ask for a single unit of an ore: one rime is still a trek
// across a snowfield, and being sent on it by a rounding error is worse than
// the unit being free.
{
  let ok = true;
  for (let dmg = 4; dmg <= 40; dmg++) {
    for (const radius of [60, 100, 140, 180, 220, 260]) {
      const spec = clampSpec(structure(DRY));
      spec.weapon = { damage: dmg, reach: 80, cooldown: 0.7 };
      spec.ward = { radius };
      const c = computeCost(spec);
      if ([c.bogiron, c.basalt, c.glass, c.rime].some((n) => n === 1)) ok = false;
    }
  }
  check("no bill ever asks for exactly one unit of an ore", ok);
}

// ── production: expensive in the target ore, by design ─────────────
//
// The user's chosen gate for automation: one big trek buys permanent local
// supply. A converter must always cost a serious amount of what it makes —
// and no wording may talk it out of paying.
{
  const kiln = clampSpec(structure(DRY));
  kiln.production = { from: "stone", to: "glass", rate: 1.5 };
  const c = computeCost(kiln);
  check("a glass kiln costs glass, heavily", c.glass >= Math.round(c.total * 0.3), formatCost(c));
  check("…and no other ore", c.rime === 0 && c.basalt === 0 && c.bogiron === 0);

  // The collision with the digs-zero rule, pinned: digs-zero prevents a
  // harvest deadlock, but the converter gate is deliberate — a kiln that
  // claims to also MINE glass must still pay the production share.
  const sly = clampSpec(structure(DRY));
  sly.production = { from: "stone", to: "glass", rate: 1.5 };
  sly.harvest = { rate: 2, materials: ["glass"] };
  check(
    "wording a kiln as also-a-glass-miner does not dodge the gate",
    computeCost(sly).glass >= Math.round(computeCost(sly).total * 0.25),
    formatCost(computeCost(sly)),
  );

  // Converting to a common is legal and needs no ore — a charcoal-style
  // wood-maker is gated by its own throughput cost alone.
  const chipper = clampSpec(structure(DRY));
  chipper.production = { from: "stone", to: "wood", rate: 1 };
  const cc = computeCost(chipper);
  check("a to-commons converter needs no ore", cc.glass + cc.rime + cc.basalt + cc.bogiron === 0, formatCost(cc));

  // Category discipline, same as nourish/ward: a "mobile refinery" vehicle
  // does not get the primitive.
  const truck = clampSpec({
    ...structure(DRY),
    category: "vehicle",
    locomotion: {
      type: "wheels",
      speed: 100,
      terrainModifiers: { grass: 0.9, sand: 0.8, swamp: 0.1, rock: 0.3, snow: 0.2, water: 0 },
    },
  });
  truck.production = { from: "stone", to: "glass", rate: 2 };
  check("production is clamp-dropped off vehicles", clampSpec(truck).production === undefined);

  // from === to is refused at clamp time too, not just validation.
  const loop = clampSpec(structure(DRY));
  loop.production = { from: "glass", to: "glass", rate: 2 };
  check("a from==to converter is dropped", clampSpec(loop).production === undefined);
}

// The one that must never break. Every exotic sits behind a harvester that
// can dig it; if a harvester ever cost an exotic, the first gate would close
// the door behind it and the world would be unplayable past that point.
for (const ore of ["wood", "stone", "bogiron", "basalt", "glass", "rime"] as MaterialType[]) {
  const digger = clampSpec(structure(DRY));
  digger.category = "tool";
  digger.harvest = { rate: 4, materials: [ore] };
  const c = computeCost(digger);
  check(
    `a ${ore} harvester is buildable from wood and stone alone`,
    c.bogiron === 0 && c.basalt === 0 && c.glass === 0 && c.rime === 0,
    formatCost(c),
  );
}

// …and the version of that check that actually bites.
//
// The one above passes trivially: a harvester on its own has no weapon, no
// farm and no ward, so nothing charges it an ore and the rule looks safe. But
// the compiler is free to decide a heavy pick also swings well, and a BASALT
// pick that picked up a weapon was billed 6 basalt — a locked door with the
// key behind it. What saves it cannot be "the model usually does not do that",
// so pile every capability on and check the one thing that must hold.
for (const ore of ["bogiron", "basalt", "glass", "rime"] as MaterialType[]) {
  const kitchenSink = clampSpec(structure(DRY));
  kitchenSink.category = "tool";
  kitchenSink.harvest = { rate: 4, materials: [ore] };
  kitchenSink.weapon = { damage: 38, reach: 140, cooldown: 0.3 };
  kitchenSink.emission = { kind: "sparks", intensity: 1 };
  kitchenSink.storage = { capacity: 30 };
  const c = computeCost(kitchenSink);
  check(
    `a ${ore} harvester never costs ${ore}, whatever else it can do`,
    c[ore] === 0,
    formatCost(c),
  );
}

// Structures can harvest too — an automatic extractor is not a tool.
for (const ore of ["bogiron", "basalt", "glass", "rime"] as MaterialType[]) {
  const rig = clampSpec(structure(DRY));
  rig.harvest = { rate: 3, materials: [ore] };
  rig.nourish = { rate: 10 };
  rig.ward = { radius: 250 };
  check(`a ${ore} extractor never costs ${ore} either`, computeCost(rig)[ore] === 0, formatCost(computeCost(rig)));
}

// A rig that digs several ores pays for none of them.
{
  const multi = clampSpec(structure(DRY));
  multi.category = "vehicle";
  multi.harvest = { rate: 4, materials: ["basalt", "glass", "rime", "bogiron"] };
  multi.weapon = { damage: 30, reach: 100, cooldown: 0.5 };
  const c = computeCost(multi);
  check(
    "a rig that digs everything owes nothing to any of it",
    c.basalt === 0 && c.glass === 0 && c.rime === 0 && c.bogiron === 0,
    formatCost(c),
  );
}

// A machine that wants everything is expensive, not unbuildable.
const everything = clampSpec(
  vehicle("float", { grass: 0.3, sand: 0.3, swamp: 0.9, rock: 0.3, snow: 0.3, water: 1 }),
);
everything.weapon = { damage: 30, reach: 120, cooldown: 0.5 };
everything.emission = { kind: "light", intensity: 1 };
const ec = computeCost(everything);
const exoticSum = ec.bogiron + ec.basalt + ec.glass + ec.rime;
check("a do-everything machine still needs wood and stone", ec.wood > 0 && ec.stone > 0, formatCost(ec));
check("the exotics never take the whole bill", exoticSum < ec.total * 0.65, `${exoticSum}/${ec.total}`);

// Every bill must add up, or the stockpile drifts against what was charged.
for (const spec of [harvester, glowing, weaponised, farm, fence, everything]) {
  const c = computeCost(spec);
  const sum = c.wood + c.stone + c.bogiron + c.basalt + c.glass + c.rime;
  check(`${spec.displayName || "spec"}: parts sum to the total`, sum === c.total, `${sum} vs ${c.total}`);
}

// ── the grammar the model is actually held to ──────────────────────
//
// The prompt is advice; the JSON schema is a grammar, and when they disagree
// the grammar wins silently. The materials enum was hand-written and went
// stale the moment there were six materials, so a Glass Miner was forbidden
// from saying "glass" and picked the nearest thing it was allowed to say —
// which reads, in game, as the compiler not understanding what you asked for.
{
  const props = SPEC_JSON_SCHEMA.properties as Record<string, any>;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  check(
    "the provider may name every material",
    same(props.harvest.properties.materials.items.enum, MATERIALS),
    props.harvest.properties.materials.items.enum.join(","),
  );
  check(
    "…every terrain class",
    same(Object.keys(props.locomotion.properties.terrainModifiers.properties), TERRAINS),
    Object.keys(props.locomotion.properties.terrainModifiers.properties).join(","),
  );
  check("…every locomotion type", same(props.locomotion.properties.type.enum, LOCOMOTION_TYPES));
  check("…and every emission kind", same(props.emission.properties.kind.enum, EMISSION_KINDS));

  // Every primitive the game simulates must be reachable from the grammar.
  for (const key of ["harvest", "emission", "weapon", "storage", "nourish", "ward"]) {
    check(`the grammar has a '${key}'`, key in props);
  }

  // The prose the model reads and the clamps the code enforces are built
  // from the same RANGES table — this asserts nobody re-hardcodes a number
  // into the prompt and lets the two drift apart again.
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    check(`the prompt states the ${k} range`, SYSTEM_PROMPT.includes(`${lo}-${hi}`));
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
