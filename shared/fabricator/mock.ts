// Offline fallback: crude keyword heuristics so the whole game loop works
// with no API key at all (used by the test harness and keyless dev).
// Supports the full v1 progression: hand-tools with harvest, emitters,
// tracked vehicles, structures.
// ISOMORPHIC — no env access, no platform imports.

import {
  NO_TERRAIN,
  clampSpec,
  type FabricatedSpec,
  type MaterialType,
  type RawSpec,
  type TerrainModifiers,
} from "./schema";
import { computeCost } from "./cost";
import type { CompileInput } from "./provider";

export function mockCompile(input: CompileInput): FabricatedSpec {
  const text = `${input.name} ${input.intent ?? ""}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => text.includes(w));

  const noLoco = { type: "none" as const, speed: 0, terrainModifiers: { ...NO_TERRAIN } };

  // hand tools
  const isTool = has("axe", "saw", "pick", "pickaxe", "hammer", "torch") ||
    (has("drill", "cutter") && has("hand", "tool")) ||
    (has("drill") && !has("truck", "car", "vehicle", "rig", "machine", "tank"));
  if (isTool) {
    const materials: MaterialType[] = has("axe", "saw")
      ? ["wood"]
      : has("pick", "drill")
        ? ["stone", "bogiron"]
        : ["wood", "stone"];
    const raw: RawSpec = {
      category: "tool",
      displayName: input.name.slice(0, 32) || "Tool",
      size: { w: 36, h: 28 },
      locomotion: noLoco,
      harvest: { rate: 2, materials },
      emission: has("torch") ? { kind: "light", intensity: 0.6 } : undefined,
      seats: 0,
      flavor: "[offline mock] Compiled by keyword heuristics.",
    };
    const clamped = clampSpec(raw);
    return { ...clamped, cost: computeCost(clamped) };
  }

  // structures
  if (has("house", "hut", "shelter", "tower", "wall", "base", "lantern", "beacon", "lamp")) {
    const light = has("lantern", "beacon", "lamp", "light");
    const raw: RawSpec = {
      category: "structure",
      displayName: input.name.slice(0, 32) || "Structure",
      size: light ? { w: 40, h: 70 } : { w: 120, h: 100 },
      locomotion: noLoco,
      emission: light ? { kind: "light", intensity: 0.8 } : undefined,
      seats: 0,
      flavor: "[offline mock] Compiled by keyword heuristics.",
    };
    const clamped = clampSpec(raw);
    return { ...clamped, cost: computeCost(clamped) };
  }

  // vehicles
  let locoType: RawSpec["locomotion"]["type"] = "wheels";
  let mods: TerrainModifiers =
    { grass: 0.95, sand: 0.85, swamp: 0.1, rock: 0.3, snow: 0.2, water: 0 };
  if (has("boat", "float", "raft", "hover", "ship", "ferry")) {
    locoType = "float";
    mods = { grass: 0.25, sand: 0.3, swamp: 0.9, rock: 0.15, snow: 0.3, water: 0.95 };
  } else if (has("swamp", "bog", "mud")) {
    locoType = "wheels";
    mods = { grass: 0.7, sand: 0.6, swamp: 0.65, rock: 0.35, snow: 0.5, water: 0 };
  } else if (has("walker", "legs", "spider", "mech")) {
    locoType = "legs";
    mods = { grass: 0.6, sand: 0.6, swamp: 0.55, rock: 0.7, snow: 0.5, water: 0 };
  } else if (has("tank", "tracks", "tractor", "excavator", "digger")) {
    locoType = "tracks";
    mods = { grass: 0.7, sand: 0.7, swamp: 0.45, rock: 0.65, snow: 0.6, water: 0 };
  } else if (has("snow", "ice", "sled", "ski")) {
    locoType = "tracks";
    mods = { grass: 0.6, sand: 0.4, swamp: 0.3, rock: 0.4, snow: 0.95, water: 0 };
  }

  const harvester = has("mining", "miner", "excavator", "digger", "harvester", "logging", "logger", "drill");
  const materials: MaterialType[] = has("logging", "logger")
    ? ["wood"]
    : ["stone", "bogiron"];
  const raw: RawSpec = {
    category: "vehicle",
    displayName: input.name.slice(0, 32) || "Thing",
    size: harvester ? { w: 100, h: 60 } : { w: 84, h: 48 },
    locomotion: {
      type: locoType,
      speed: has("fast", "racer", "speed") ? 300 : harvester ? 120 : 200,
      terrainModifiers: mods,
    },
    harvest: harvester ? { rate: 2.5, materials } : undefined,
    emission: has("steam", "boiler", "kettle")
      ? { kind: "steam" as const, intensity: 0.6 }
      : has("smoke", "chimney", "furnace")
        ? { kind: "smoke" as const, intensity: 0.6 }
        : undefined,
    seats: 1,
    flavor:
      "[offline mock] Compiled by keyword heuristics — set GOOGLE_API_KEY for the real Fabricator.",
  };
  const clamped = clampSpec(raw);
  return { ...clamped, cost: computeCost(clamped) };
}
