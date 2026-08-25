// The Quantum Uplink — the one design the Fabricator did not compile.
//
// It is the win condition wearing a machine's shape: the only way to reach
// VibeTech again, pinned in every design library from minute one, priced
// absurdly across all six materials so the whole economy points at it. What
// happens when it is finished is the game's one real decision, and that
// decision lives in the screen client — this file is only the shared shape,
// so the phone can show the same pinned row without inventing its own copy.
//
// ISOMORPHIC — imported by the screen and the controller.

import type { FabricatedSpec } from "../shared/fabricator/schema";

export const UPLINK_ID = "uplink";

/** Authored, not compiled: the bill is game design, not cost-model output. */
export const UPLINK_SPEC: FabricatedSpec = {
  category: "structure",
  displayName: "Quantum Uplink",
  size: { w: 150, h: 140 },
  locomotion: {
    type: "none",
    speed: 0,
    terrainModifiers: { grass: 0, sand: 0, swamp: 0, rock: 0, snow: 0, water: 0 },
  },
  emission: { kind: "light", intensity: 1 },
  seats: 0,
  flavor:
    "Company property. Restores intergalactic communications. VibeTech reminds you that completing the array is a contractual obligation, Privateer.",
  cost: {
    wood: 150,
    stone: 100,
    bogiron: 40,
    basalt: 30,
    glass: 30,
    rime: 30,
    total: 380,
  },
};
