// World-generation settings — the knobs the lobby exposes.
//
// Lives in shared/ rather than beside the generator because a saved world
// carries its settings: terrain is derived from them, so resuming a save has
// to regenerate the same ground or restored objects would land on different
// terrain. That means the wire protocol needs the type, and the protocol
// can't reach into client code.
//
// ISOMORPHIC — plain data, no DOM, no platform imports.

export type WorldSize = "small" | "medium" | "large";
export type Amount = "none" | "some" | "lots";
export type Density = "sparse" | "normal" | "dense";

export type WorldSettings = {
  /** Free text; same seed + same settings = same world. */
  seed: string;
  size: WorldSize;
  /** Swamp coverage — the terrain that punishes walking. */
  swamp: Amount;
  /** Width of the sand shore around the landmass. */
  shore: Amount;
  /** Trees, rocks and bogiron deposits. */
  scatter: Density;
};

export const WORLD_SIZES: readonly WorldSize[] = ["small", "medium", "large"];
export const AMOUNTS: readonly Amount[] = ["none", "some", "lots"];
export const DENSITIES: readonly Density[] = ["sparse", "normal", "dense"];

export const DEFAULT_SETTINGS: WorldSettings = {
  seed: "",
  size: "medium",
  swamp: "some",
  shore: "some",
  scatter: "normal",
};

/** Columns per world size. Rows are derived so the world comes out roughly
 *  square in pixels — hex columns sit 65px apart but rows only 48px (see
 *  hexgrid.ts). "medium" reproduces the 50×68 world the hex grid shipped
 *  with. */
export const SIZE_COLS: Record<WorldSize, number> = {
  small: 40,
  medium: 50,
  large: 68,
};

/** Hex column pitch ÷ row pitch (HEX_W / ROW_H). */
export const ROW_RATIO = 65 / 48;

export const rowsFor = (size: WorldSize): number =>
  Math.round(SIZE_COLS[size] * ROW_RATIO);

/** Same seed + settings must give the same world, so saves compare on this. */
export function settingsEqual(a: WorldSettings, b: WorldSettings): boolean {
  return (
    a.seed === b.seed &&
    a.size === b.size &&
    a.swamp === b.swamp &&
    a.shore === b.shore &&
    a.scatter === b.scatter
  );
}
