// Resource cost as a pure function of capability — the "balance is
// computable" thesis. The LLM has no say in this.
//
// v1: cost is a per-material bill. Swamp capability is priced in bogiron,
// a material that only spawns in the swamp — so the first swamp-capable
// machine requires a hand-gathering trek (or a bogiron-capable harvester).
// Immobile things never cost bogiron (clampSpec zeroes their terrain
// modifiers), which keeps the loop free of chicken-and-egg deadlocks:
// a mining drill TOOL is always buildable from wood + stone.
//
// ISOMORPHIC — no env access, no platform imports.

import { TERRAINS, normalizeModifiers, type MaterialCost, type RawSpec } from "./schema";

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

  // Material split. Going where bare legs can't is the bogiron sink: the bog
  // and the sea are both gated behind a trek into the bog for the iron.
  const wetCapable =
    spec.category === "vehicle" &&
    (t.swamp > 0.45 || t.water > 0.2 || spec.locomotion.type === "float");
  const bogiron = wetCapable ? Math.round(total * 0.35) : 0;
  const stone = Math.round((total - bogiron) * 0.4);
  const wood = total - bogiron - stone;
  return { wood, stone, bogiron, total };
}

export function canAfford(
  stock: Record<"wood" | "stone" | "bogiron", number>,
  cost: MaterialCost,
): boolean {
  return (
    stock.wood >= cost.wood &&
    stock.stone >= cost.stone &&
    stock.bogiron >= cost.bogiron
  );
}

export function formatCost(cost: MaterialCost): string {
  const parts: string[] = [];
  if (cost.wood) parts.push(`${cost.wood} wood`);
  if (cost.stone) parts.push(`${cost.stone} stone`);
  if (cost.bogiron) parts.push(`${cost.bogiron} bogiron`);
  return parts.join(" + ") || "free";
}
