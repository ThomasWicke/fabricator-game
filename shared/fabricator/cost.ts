// Resource cost as a pure function of capability — the "balance is
// computable" thesis. The LLM has no say in this.
//
// v1: cost is a per-material bill. Four of the six materials come from one
// biome each, and each is charged for the capability you would want in order
// to survive the place it comes from — so wanting a thing is what sends you
// somewhere, rather than a quest marker saying go there.
//
//   bogiron  bog     swamp and water movement
//   basalt   rock    weapons that beat a sharpened stick
//   glass    desert  growing food at more than a windowbox scale
//   rime     snow    wards that cover more than a camp
//
// Note what those say. Ore is the price of the STRONG version of a capability,
// not of the capability existing — a campfire throws light, cooks, and keeps
// things at bay, and it has to be buildable on the first evening out of wood
// and stone. It was not: charging for the mere presence of ward and nourish
// priced a campfire at 6 glass and 8 rime, which is a trek across a desert and
// a snowfield to light a fire. Emission is not gated at all any more; fire and
// lamps are the earliest things anyone builds.
//
// The one invariant that must hold: a HARVESTER is always buildable from wood
// and stone alone. Every exotic is gated behind a tool that can dig it, so if
// any of them were charged for harvesting, the first such gate would close the
// door behind it permanently. Immobile things also never pay for movement
// (clampSpec zeroes their terrain modifiers), which keeps a mining drill cheap.
//
// ISOMORPHIC — no env access, no platform imports.

import {
  EXOTICS,
  MATERIALS,
  TERRAINS,
  normalizeModifiers,
  type ExoticMaterial,
  type MaterialCost,
  type MaterialType,
  type RawSpec,
} from "./schema";

/** Most of a bill that the exotics may claim between them. The remainder is
 *  always wood and stone, so nothing is ever built from exotics alone — and a
 *  machine that wants everything is expensive rather than unbuildable. */
const EXOTIC_CEILING = 0.6;

/** Below this many units, an ore requirement is dropped entirely. A bill
 *  asking for one rime is still a trek across a snowfield, and being sent on
 *  it by a rounding error is worse than the unit being free. */
const MIN_ORE = 2;

/**
 * How far a capability reaches past the point where wood and stone stop being
 * enough: 0 at `free` and below, 1 at `full` and above.
 *
 * This is the difference between gating a capability and gating its strength.
 * Gating the capability is what made a campfire cost two expeditions.
 */
const past = (value: number, free: number, full: number): number =>
  Math.max(0, Math.min(1, (value - free) / (full - free)));

export function computeCost(spec: RawSpec): MaterialCost {
  const area = (spec.size.w * spec.size.h) / 400;
  const mobility = spec.locomotion.speed / 20;
  const t = normalizeModifiers(spec.locomotion.terrainModifiers, spec.locomotion.type);
  // Averaged, not summed: adding rock/snow/water as movement classes must not
  // silently double the price of every machine that already existed.
  const versatility =
    (TERRAINS.reduce((sum, k) => sum + t[k], 0) / TERRAINS.length) * 12;
  const harvest = spec.harvest
    ? spec.harvest.rate * 3 + spec.harvest.materials.length * 2
    : 0;
  const emission = spec.emission ? spec.emission.intensity * 3 : 0;
  // Each new capability is priced on what it saves you. A weapon is reach
  // times damage per second; storage is trips you don't make; a farm is food
  // you don't forage; a ward is the area it keeps quiet.
  const weapon = spec.weapon
    ? (spec.weapon.damage / spec.weapon.cooldown) * 0.5 + spec.weapon.reach / 12
    : 0;
  const storage = spec.storage ? spec.storage.capacity * 0.5 : 0;
  const nourish = spec.nourish ? spec.nourish.rate * 2.5 : 0;
  const ward = spec.ward ? spec.ward.radius / 12 : 0;
  // Seats are the one thing left that scales with "how much machine is this":
  // the parts list used to carry that weight, and dropping it without a
  // replacement would have made every vehicle several units cheaper overnight.
  const chassis = spec.category === "vehicle" ? 4 + spec.seats * 2 : 0;
  const total = Math.max(
    1,
    Math.round(
      area + mobility + versatility + chassis + harvest + emission + weapon + storage + nourish + ward,
    ),
  );

  // Material split. Each exotic claims a share of the bill when the capability
  // it gates is present; wood and stone divide whatever is left.
  const wetCapable =
    spec.category === "vehicle" &&
    (t.swamp > 0.45 || t.water > 0.2 || spec.locomotion.type === "float");
  const share: Record<ExoticMaterial, number> = {
    bogiron: wetCapable ? 0.35 : 0,
    // Bare hands already do 6 damage, so a crude spear is not an achievement;
    // basalt is what a real weapon is made of.
    basalt: spec.weapon ? 0.3 * past(spec.weapon.damage, 12, 34) : 0,
    // A fire you can cook on is not a farm.
    glass: spec.nourish ? 0.25 * past(spec.nourish.rate, 4, 12) : 0,
    // Keeping the animals off one camp is not keeping them off a settlement.
    // 140px is a bit over two hexes — a fire and the ground you sleep on.
    rime: spec.ward ? 0.3 * past(spec.ward.radius, 140, 260) : 0,
  };

  // A thing can want several at once — a warded greenhouse with a gun on it —
  // and the shares must not add up to the whole bill.
  const demanded = EXOTICS.reduce((sum, m) => sum + share[m], 0);
  const scale = demanded > EXOTIC_CEILING ? EXOTIC_CEILING / demanded : 1;

  const bill = { wood: 0, stone: 0, bogiron: 0, basalt: 0, glass: 0, rime: 0, total };
  let spent = 0;
  for (const m of EXOTICS) {
    // Round each in turn against what is left rather than independently, so
    // the parts always sum to the total exactly.
    const want = Math.round(total * share[m] * scale);
    const take = want < MIN_ORE ? 0 : Math.min(want, total - spent);
    bill[m] = take;
    spent += take;
  }
  bill.stone = Math.round((total - spent) * 0.4);
  bill.wood = total - spent - bill.stone;
  return bill;
}

export function canAfford(
  stock: Record<MaterialType, number>,
  cost: MaterialCost,
): boolean {
  return MATERIALS.every((m) => (stock[m] ?? 0) >= cost[m]);
}

export function formatCost(cost: MaterialCost): string {
  // Only what it actually costs: a bill listing four zeroes reads as a tax
  // form, and most things are still wood and stone.
  const parts = MATERIALS.filter((m) => cost[m]).map((m) => `${cost[m]} ${m}`);
  return parts.join(" + ") || "free";
}
