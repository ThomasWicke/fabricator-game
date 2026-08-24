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
// ISOMORPHIC — must run in PartyKit workers AND browsers. No process.env,
// no PartyKit imports, no Node APIs.

export type LocomotionType = "none" | "wheels" | "tracks" | "legs" | "float";
export type TerrainType = "grass" | "sand" | "swamp";
export type MaterialType = "wood" | "stone" | "bogiron";
export type PartKind =
  | "wheel"
  | "leg"
  | "float"
  | "track"
  | "drill"
  | "chimney"
  | "lamp";
export type EmissionKind = "light" | "smoke" | "sparks";

export const MATERIALS: readonly MaterialType[] = ["wood", "stone", "bogiron"];

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
     *  Car" lives. */
    terrainModifiers: Record<TerrainType, number>;
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
  /** Ambient output — visible in the world (glow / smoke puffs / sparks). */
  emission?: {
    kind: EmissionKind;
    /** 0..1 — scales radius / particle frequency. */
    intensity: number;
  };
  /** Functional parts attached to the body; x/y relative to body size,
   *  each in [-0.5, 0.5] ((0,0) = body center). */
  anchors: { part: PartKind; x: number; y: number }[];
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
          },
          required: ["grass", "sand", "swamp"],
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
        kind: { type: "string", enum: ["light", "smoke", "sparks"] },
        intensity: { type: "number" },
      },
      required: ["kind", "intensity"],
      additionalProperties: false,
    },
    anchors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          part: {
            type: "string",
            enum: ["wheel", "leg", "float", "track", "drill", "chimney", "lamp"],
          },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["part", "x", "y"],
        additionalProperties: false,
      },
    },
    seats: { type: "number" },
    flavor: { type: "string" },
  },
  required: ["category", "displayName", "size", "locomotion", "anchors", "seats", "flavor"],
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
  for (const t of ["grass", "sand", "swamp"]) {
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
    if (!["light", "smoke", "sparks"].includes(em.kind as string)) {
      errs.push("bad emission.kind");
    }
    if (typeof em.intensity !== "number") errs.push("bad emission.intensity");
  }
  if (!Array.isArray(o.anchors)) {
    errs.push("bad anchors");
  } else {
    for (const a of o.anchors as Record<string, unknown>[]) {
      if (
        !["wheel", "leg", "float", "track", "drill", "chimney", "lamp"].includes(
          a?.part as string,
        ) ||
        typeof a?.x !== "number" ||
        typeof a?.y !== "number"
      ) {
        errs.push("bad anchor entry");
        break;
      }
    }
  }
  if (typeof o.seats !== "number") errs.push("bad seats");
  if (typeof o.flavor !== "string") errs.push("bad flavor");
  return errs;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/** Enforce simulation-safe bounds no matter what the compiler returns. */
export function clampSpec(raw: RawSpec): RawSpec {
  const t = raw.locomotion.terrainModifiers;
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
        ? { grass: 0, sand: 0, swamp: 0 }
        : {
            grass: clamp(t.grass, 0, 1),
            sand: clamp(t.sand, 0, 1),
            swamp: clamp(t.swamp, 0, 1),
          },
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
    anchors: raw.anchors.slice(0, 8).map((a) => ({
      part: a.part,
      x: clamp(a.x, -0.5, 0.5),
      y: clamp(a.y, -0.5, 0.5),
    })),
    seats: clamp(Math.round(raw.seats), 0, 2),
    flavor: raw.flavor.slice(0, 120),
  };
}
