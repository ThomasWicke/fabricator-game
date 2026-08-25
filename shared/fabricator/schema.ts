// Spec v1 — the capability schema. Single source of truth: the TS type, the
// JSON schema sent to providers, and the code-side validator all live here.
//
// This is the core architectural thesis: the LLM only ever SELECTS AND
// PARAMETERIZES from this fixed vocabulary; all behavior downstream of a
// spec is deterministic, hand-designed simulation.
//
// v1 primitives: locomotion (terrain-modified movement), harvest (resource
// gathering), emission (light/smoke/sparks). Cost is a per-material bill
// computed in code — swamp capability is priced in bogiron, which only
// exists in the swamp. That's the material-gated progression loop.
//
// Wood and stone are everywhere; the other four are each the price of going
// somewhere. Every hostile biome now holds exactly one, and each is spent on
// the capability you would want in order to survive the place it comes from:
//
//   bogiron  bog     going where legs can't (swamp and water movement)
//   basalt   rock    weapons
//   glass    desert  growing food, and light
//   rime     snow    keeping things at a distance
//
// The map's edges are the economy. None of them are needed to build a
// harvester, so no gate can ever lock you out of the tool that opens it.
//
// ISOMORPHIC — must run in PartyKit workers AND browsers. No process.env,
// no PartyKit imports, no Node APIs.

export type LocomotionType = "none" | "wheels" | "tracks" | "legs" | "float";
/** Movement classes, not biomes. The world paints ten Kenney biomes; they all
 *  collapse into these six for the purposes of "can this machine cross it, and
 *  how fast" — which is the only terrain question the Fabricator answers. */
export type TerrainType = "grass" | "sand" | "swamp" | "rock" | "snow" | "water";
export type MaterialType = "wood" | "stone" | "bogiron" | "basalt" | "glass" | "rime";
/** The four that only one biome makes. Wood and stone are the commons. */
export type ExoticMaterial = Exclude<MaterialType, "wood" | "stone">;

export const TERRAINS: readonly TerrainType[] = [
  "grass",
  "sand",
  "swamp",
  "rock",
  "snow",
  "water",
];

export type TerrainModifiers = Record<TerrainType, number>;
/** What a machine throws off while it runs. Exhaust of any kind streams out
 *  BEHIND the thing that makes it; light is the one that surrounds it. */
export type EmissionKind = "light" | "smoke" | "steam" | "sparks";

export const MATERIALS: readonly MaterialType[] = [
  "wood",
  "stone",
  "bogiron",
  "basalt",
  "glass",
  "rime",
];
export const EXOTICS: readonly ExoticMaterial[] = ["bogiron", "basalt", "glass", "rime"];

export type MaterialCost = Record<MaterialType, number> & { total: number };

export type FabricatedSpec = {
  category: "vehicle" | "structure" | "tool";
  displayName: string;
  /** World pixels. */
  size: { w: number; h: number };
  locomotion: {
    type: LocomotionType;
    /** Base speed in px/s on ideal terrain. 0 for structures/tools. */
    speed: number;
    /** Speed multipliers per terrain, 0..1. This is where "Swamp Buggy ≠
     *  Car" lives — and, since water is in here, where a raft becomes the
     *  only way across the sea. 0 means "cannot enter at all". */
    terrainModifiers: TerrainModifiers;
  };
  /** Resource gathering. On a tool: boosts the carrying player. On a
   *  vehicle: harvests nodes it touches while driven. */
  harvest?: {
    /** Units per second, 0.4..4. */
    rate: number;
    /** Which materials it can extract. Bogiron REQUIRES a harvester that
     *  lists it — bare hands can't gather it. */
    materials: MaterialType[];
  };
  /**
   * Ambient output. The renderer decides WHERE it goes — exhaust behind the
   * machine, light around it — so the spec only says what kind and how much.
   *
   * There is deliberately no parts list any more. Bolting library wheels and
   * chimneys onto generated art doubled up a silhouette that already had
   * them, and it spent the compiler's attention on where to glue props
   * instead of on what the machine DOES.
   */
  emission?: {
    kind: EmissionKind;
    /** 0..1 — scales radius / particle frequency. */
    intensity: number;
  };
  /**
   * Something to hit things with. On a tool it arms the carrier; without it
   * you still have bare hands, just slower and weaker.
   */
  weapon?: {
    /** Damage per swing, 4..40. */
    damage: number;
    /** How far the swing reaches, in world pixels, 40..150. */
    reach: number;
    /** Seconds between swings, 0.25..2. */
    cooldown: number;
  };
  /** Room for more. On a tool it enlarges the carrier's pack; on a structure
   *  it is a depot — somewhere out in the world to unload without walking all
   *  the way back to the Fabricator. */
  storage?: {
    /** Extra units, 4..40. */
    capacity: number;
  };
  /** Grows food. Structures only — a farm, a still, a greenhouse. */
  nourish?: {
    /** Food per minute, 1..12. */
    rate: number;
  };
  /** Keeps wildlife off. Structures only. */
  ward?: {
    /** Radius in world pixels, 60..260. */
    radius: number;
  };
  seats: number;
  /** One in-world line from the Fabricator about its interpretation. */
  flavor: string;
  /** Per-material bill — computed by code from the spec, never by the LLM. */
  cost: MaterialCost;
};

/** What providers must return (cost is added by code afterwards). */
export type RawSpec = Omit<FabricatedSpec, "cost">;

/** Standard JSON Schema for RawSpec — providers adapt it to their own
 *  structured-output dialect. */
export const SPEC_JSON_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["vehicle", "structure", "tool"] },
    displayName: { type: "string" },
    size: {
      type: "object",
      properties: { w: { type: "number" }, h: { type: "number" } },
      required: ["w", "h"],
      additionalProperties: false,
    },
    locomotion: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["none", "wheels", "tracks", "legs", "float"] },
        speed: { type: "number" },
        terrainModifiers: {
          type: "object",
          properties: {
            grass: { type: "number" },
            sand: { type: "number" },
            swamp: { type: "number" },
            rock: { type: "number" },
            snow: { type: "number" },
            water: { type: "number" },
          },
          required: ["grass", "sand", "swamp", "rock", "snow", "water"],
          additionalProperties: false,
        },
      },
      required: ["type", "speed", "terrainModifiers"],
      additionalProperties: false,
    },
    harvest: {
      type: "object",
      properties: {
        rate: { type: "number" },
        materials: {
          type: "array",
          items: { type: "string", enum: ["wood", "stone", "bogiron"] },
        },
      },
      required: ["rate", "materials"],
      additionalProperties: false,
    },
    emission: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["light", "smoke", "steam", "sparks"] },
        intensity: { type: "number" },
      },
      required: ["kind", "intensity"],
      additionalProperties: false,
    },
    weapon: {
      type: "object",
      properties: {
        damage: { type: "number" },
        reach: { type: "number" },
        cooldown: { type: "number" },
      },
      required: ["damage", "reach", "cooldown"],
      additionalProperties: false,
    },
    storage: {
      type: "object",
      properties: { capacity: { type: "number" } },
      required: ["capacity"],
      additionalProperties: false,
    },
    nourish: {
      type: "object",
      properties: { rate: { type: "number" } },
      required: ["rate"],
      additionalProperties: false,
    },
    ward: {
      type: "object",
      properties: { radius: { type: "number" } },
      required: ["radius"],
      additionalProperties: false,
    },
    seats: { type: "number" },
    flavor: { type: "string" },
  },
  required: ["category", "displayName", "size", "locomotion", "seats", "flavor"],
  additionalProperties: false,
} as const;

/**
 * Code-side validation — never trust provider-side schema enforcement
 * alone. Returns a list of problems; empty = valid.
 */
export function validateSpec(raw: unknown): string[] {
  const errs: string[] = [];
  const o = raw as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null) return ["not an object"];
  if (!["vehicle", "structure", "tool"].includes(o.category as string)) {
    errs.push("bad category");
  }
  if (typeof o.displayName !== "string" || !o.displayName.trim()) {
    errs.push("bad displayName");
  }
  const size = o.size as Record<string, unknown> | undefined;
  if (typeof size?.w !== "number" || typeof size?.h !== "number") {
    errs.push("bad size");
  }
  const loco = o.locomotion as Record<string, unknown> | undefined;
  if (!["none", "wheels", "tracks", "legs", "float"].includes(loco?.type as string)) {
    errs.push("bad locomotion.type");
  }
  if (typeof loco?.speed !== "number") errs.push("bad locomotion.speed");
  const mods = loco?.terrainModifiers as Record<string, unknown> | undefined;
  for (const t of TERRAINS) {
    if (typeof mods?.[t] !== "number") errs.push(`bad terrainModifiers.${t}`);
  }
  if (o.harvest !== undefined && o.harvest !== null) {
    const hv = o.harvest as Record<string, unknown>;
    if (typeof hv.rate !== "number") errs.push("bad harvest.rate");
    if (
      !Array.isArray(hv.materials) ||
      !(hv.materials as unknown[]).every((m) => MATERIALS.includes(m as MaterialType))
    ) {
      errs.push("bad harvest.materials");
    }
  }
  if (o.emission !== undefined && o.emission !== null) {
    const em = o.emission as Record<string, unknown>;
    if (!["light", "smoke", "steam", "sparks"].includes(em.kind as string)) {
      errs.push("bad emission.kind");
    }
    if (typeof em.intensity !== "number") errs.push("bad emission.intensity");
  }
  const num = (obj: unknown, field: string, label: string) => {
    if (obj === undefined || obj === null) return;
    if (typeof (obj as Record<string, unknown>)[field] !== "number") errs.push(label);
  };
  num(o.weapon, "damage", "bad weapon.damage");
  num(o.weapon, "reach", "bad weapon.reach");
  num(o.weapon, "cooldown", "bad weapon.cooldown");
  num(o.storage, "capacity", "bad storage.capacity");
  num(o.nourish, "rate", "bad nourish.rate");
  num(o.ward, "radius", "bad ward.radius");
  if (typeof o.seats !== "number") errs.push("bad seats");
  if (typeof o.flavor !== "string") errs.push("bad flavor");
  return errs;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

export const NO_TERRAIN: TerrainModifiers = {
  grass: 0,
  sand: 0,
  swamp: 0,
  rock: 0,
  snow: 0,
  water: 0,
};

/**
 * Fill in modifiers a spec doesn't carry. Designs compiled before rock/snow/
 * water existed are stored permanently and still have to drive, so the missing
 * classes are inferred from the ones they do have rather than defaulting to
 * zero — which would strand every pre-existing machine the moment it left the
 * grass. Water is the exception: crossing it is a capability you have to have
 * been designed for, so only a float hull gets it by default.
 */
export function normalizeModifiers(
  mods: Partial<TerrainModifiers> | undefined,
  locomotionType: LocomotionType,
): TerrainModifiers {
  const m = mods ?? {};
  const grass = m.grass ?? 0;
  const sand = m.sand ?? 0;
  const swamp = m.swamp ?? 0;
  return {
    grass,
    sand,
    swamp,
    // Bare rock rewards whatever copes with rough ground.
    rock: m.rock ?? Math.min(sand, grass) * 0.7,
    // Snow is soft going: closer to the bog than to the plain.
    snow: m.snow ?? (grass + swamp) / 2 * 0.8,
    water: m.water ?? (locomotionType === "float" ? 0.9 : 0),
  };
}

/** Enforce simulation-safe bounds no matter what the compiler returns. */
export function clampSpec(raw: RawSpec): RawSpec {
  const t = normalizeModifiers(raw.locomotion.terrainModifiers, raw.locomotion.type);
  // Anything that can't move has no meaningful terrain modifiers. Compilers
  // fill that dead field arbitrarily (observed: one structure at 1/1/1,
  // another at 0/0/0), which would otherwise leak into computeCost as
  // "versatility" and price identical structures differently.
  const immobile = raw.category !== "vehicle" || raw.locomotion.type === "none";
  return {
    ...raw,
    displayName: raw.displayName.slice(0, 32),
    size: {
      w: clamp(raw.size.w, 32, 180),
      h: clamp(raw.size.h, 24, 140),
    },
    locomotion: {
      type: raw.locomotion.type,
      speed: immobile ? 0 : clamp(raw.locomotion.speed, 40, 360),
      terrainModifiers: immobile
        ? { ...NO_TERRAIN }
        : (Object.fromEntries(
            TERRAINS.map((k) => [k, clamp(t[k], 0, 1)]),
          ) as TerrainModifiers),
    },
    harvest: raw.harvest
      ? {
          rate: clamp(raw.harvest.rate, 0.4, 4),
          materials: [...new Set(raw.harvest.materials)],
        }
      : undefined,
    emission: raw.emission
      ? { kind: raw.emission.kind, intensity: clamp(raw.emission.intensity, 0, 1) }
      : undefined,
    weapon: raw.weapon
      ? {
          damage: clamp(raw.weapon.damage, 4, 40),
          reach: clamp(raw.weapon.reach, 40, 150),
          cooldown: clamp(raw.weapon.cooldown, 0.25, 2),
        }
      : undefined,
    storage: raw.storage
      ? { capacity: Math.round(clamp(raw.storage.capacity, 4, 40)) }
      : undefined,
    // Only a building can farm or ward: both are things that sit somewhere and
    // work on the ground around them, which is what a structure IS.
    nourish:
      raw.nourish && raw.category === "structure"
        ? { rate: clamp(raw.nourish.rate, 1, 12) }
        : undefined,
    ward:
      raw.ward && raw.category === "structure"
        ? { radius: clamp(raw.ward.radius, 60, 260) }
        : undefined,
    seats: clamp(Math.round(raw.seats), 0, 2),
    flavor: raw.flavor.slice(0, 120),
  };
}
