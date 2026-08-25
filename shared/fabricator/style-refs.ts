// Style-reference images for body-sprite generation.
//
// The strongest lever for a consistent look is not more adjectives — it is
// handing the image model an actual picture and saying "render in exactly
// this style". One reference per category, because the categories have
// different canonical views (side profile / item icon / three-quarter), and
// a vehicle rendered in a tool's icon style would be worse than no ref.
//
// The refs are OUR OWN best generated outputs, curated from the eval-art
// contact sheet, so the style is one the model demonstrably produces —
// referencing hand-made art it can only approximate would anchor every
// generation to a target it always misses.
//
// Cost: an input image this size is ~258 tokens; output bills a flat 1120
// regardless. One ref adds ~20% tokens to a call and zero extra requests.
//
// To re-curate: `npx tsx scripts/eval-art.ts`, pick from the contact sheet in
// fixtures/art/, then `npx tsx scripts/embed-style-refs.ts <category>=<file> …`
// which regenerates the data below.
//
// ISOMORPHIC — imported by the worker; base64 constants, no fs.

import type { FabricatedSpec } from "./schema";

export type StyleRef = {
  /** Where this ref came from, for humans. */
  source: string;
  /** PNG, raw base64 (no data: prefix). */
  base64: string;
};

/** Populated by scripts/embed-style-refs.ts — empty until first curation. */
export const STYLE_REFS: Partial<Record<FabricatedSpec["category"], StyleRef>> = {};

/** The palette line for the prompt, derived from the curated refs at embed
 *  time. Empty until refs exist; the prompt omits its palette clause then. */
export const STYLE_PALETTE: string[] = [];
