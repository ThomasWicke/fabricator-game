// Resource cost as a pure function of capability — the "balance is
// computable" thesis. The LLM has no say in this.
// ISOMORPHIC — no env access, no platform imports.

import type { RawSpec } from "./schema";

export function computeCost(spec: RawSpec): number {
  const area = (spec.size.w * spec.size.h) / 400;
  const mobility = spec.locomotion.speed / 20;
  const t = spec.locomotion.terrainModifiers;
  const versatility = (t.grass + t.sand + t.swamp) * 4;
  const parts = spec.anchors.length * 2;
  return Math.max(1, Math.round(area + mobility + versatility + parts));
}
