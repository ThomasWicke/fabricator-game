// Offline fallback: crude keyword heuristics so the whole game loop works
// with no API key at all (used by the test harness and keyless dev).
// ISOMORPHIC — no env access, no platform imports.

import { clampSpec, type FabricatedSpec, type RawSpec } from "./schema";
import { computeCost } from "./cost";
import type { CompileInput } from "./provider";

export function mockCompile(input: CompileInput): FabricatedSpec {
  const text = `${input.name} ${input.intent ?? ""}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => text.includes(w));

  let locoType: RawSpec["locomotion"]["type"] = "wheels";
  let mods = { grass: 0.95, sand: 0.85, swamp: 0.1 };
  if (has("boat", "float", "raft", "hover")) {
    locoType = "float";
    mods = { grass: 0.25, sand: 0.3, swamp: 0.9 };
  } else if (has("swamp", "bog", "mud")) {
    locoType = "wheels";
    mods = { grass: 0.7, sand: 0.6, swamp: 0.65 };
  } else if (has("walker", "legs", "spider", "mech")) {
    locoType = "legs";
    mods = { grass: 0.6, sand: 0.6, swamp: 0.55 };
  } else if (has("tank", "tracks", "tractor")) {
    locoType = "tracks";
    mods = { grass: 0.7, sand: 0.7, swamp: 0.45 };
  }

  const isStructure = has("house", "hut", "shelter", "tower", "wall", "base");
  const part: RawSpec["anchors"][number]["part"] =
    locoType === "legs" ? "leg" : locoType === "float" ? "float" : "wheel";

  const raw: RawSpec = {
    category: isStructure ? "structure" : "vehicle",
    displayName: input.name.slice(0, 32) || "Thing",
    size: isStructure ? { w: 120, h: 100 } : { w: 84, h: 48 },
    locomotion: isStructure
      ? { type: "none", speed: 0, terrainModifiers: { grass: 0, sand: 0, swamp: 0 } }
      : {
          type: locoType,
          speed: has("fast", "racer", "speed") ? 300 : 200,
          terrainModifiers: mods,
        },
    anchors: isStructure
      ? []
      : [
          { part, x: -0.32, y: 0.42 },
          { part, x: 0.32, y: 0.42 },
        ],
    seats: isStructure ? 0 : 1,
    flavor:
      "[offline mock] Compiled by keyword heuristics — set GOOGLE_API_KEY for the real Fabricator.",
  };
  const clamped = clampSpec(raw);
  return { ...clamped, cost: computeCost(clamped) };
}
