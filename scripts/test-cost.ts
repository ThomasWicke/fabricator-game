// Deterministic checks for clampSpec + computeCost. No API calls — run it
// freely: npx tsx scripts/test-cost.ts
//
// Guards the "balance is computable" thesis: a spec's cost must depend only
// on meaningful capability, never on fields the compiler fills in
// arbitrarily — and the material split must never deadlock progression.

import { clampSpec, type MaterialType, type RawSpec } from "../shared/fabricator/schema";
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

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
