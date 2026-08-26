// Body-sprite generation: spec (+ player sketch as shape reference) → a
// game-ready body image on a solid magenta background. Gemini image models
// can't output alpha, so the client chroma-keys the magenta out
// (client/src/screen/chroma.ts).
//
// Vehicles are asked for COMPLETE — running gear included. The hybrid
// approach (AI body + library parts bolted on) doubled up: the
// generated art drew its own wheels and our sprites sat on top of them.
// Structures still take library parts (lamps, chimneys) since those pair
// with emission effects rather than duplicating the silhouette.
//
// ISOMORPHIC — fetch-only, caller supplies the key. No env access.

import { STYLE_PALETTE, STYLE_REFS } from "./style-refs";
import type { FabricatedSpec } from "./schema";

/**
 * Nano Banana 2 Lite. Measured against the full `gemini-3.1-flash-image` on
 * the same four subjects with this exact prompt: ~2.8s vs ~9.7s, comparable
 * or better quality, and it honoured `legs` where the full model drew tracks.
 *
 * Cost note: an image bills as a FLAT 1120 output tokens on both models,
 * regardless of any aspect/size hint (those are accepted and ignored), so
 * the only cost levers are which model runs and how many images we ask for.
 */
export const IMAGE_MODEL = "gemini-3.1-flash-lite-image";

/** Lite occasionally returns 503 "high demand"; the full model is the
 *  backstop so a fabrication never loses its art to a capacity blip. */
const IMAGE_FALLBACK_MODEL = "gemini-3.1-flash-image";

export type BodySprite = {
  /** data:<mime>;base64,... */
  dataUrl: string;
  mimeType: string;
};

/**
 * The stages of image generation only the provider can see, kept so the T
 * console can show what the model was actually handed and what it actually
 * gave back.
 *
 * The pipeline spans two machines and four transformations, and until now
 * every one of them was invisible: a body came back wrong and the only
 * evidence was the final sprite. Diagnosing the hollow wireframes of
 * 2026-08-26 meant reasoning backwards from one PNG — with these frames it
 * would have been a glance.
 *
 * All base64 PNG, no data: prefix.
 */
export type ArtTrace = {
  /** The image input AS THE MODEL RECEIVED IT: the filled silhouette on the
   *  local path (silhouette.ts rewrites the player's strokes before they are
   *  uploaded), the player's raw sketch on Gemini's, absent when they drew
   *  nothing. */
  input?: string;
  /** The model's own frame, before any background removal. Local path only —
   *  its graph runs rembg and composites onto magenta, so the returned image
   *  is already two steps downstream of what the model drew. Gemini removes
   *  nothing, so there its returned image IS this frame. */
  preKey?: string;
  /** The positive prompt actually sent, after every per-category and
   *  per-spec branch has resolved. */
  prompt?: string;
};

function buildImagePrompt(spec: FabricatedSpec, hasSketch: boolean, _hasStyleRef = false): string {
  const aspect =
    spec.size.w > spec.size.h * 1.4
      ? "wide, elongated"
      : spec.size.h > spec.size.w * 1.2
        ? "tall, upright"
        : "roughly square";
  const RUNNING_GEAR: Record<string, string> = {
    wheels: "chunky rubber wheels",
    tracks: "caterpillar tracks",
    legs: "articulated walking legs",
    float: "pontoon floats",
  };
  const gear = RUNNING_GEAR[spec.locomotion.type];
  const parts =
    spec.category === "vehicle" && gear
      ? ` Draw it complete and ready to drive, standing on clearly visible ${gear} along its underside.` +
        (spec.harvest ? " Include a visible cutting or drilling implement." : "")
      : "";
  // Vehicles must all face the same way or they can't be mirrored: the game
  // flips the sprite to drive left, so anything drawn at an isometric angle
  // reads as driving diagonally in one direction and backwards in the other.
  // Flat lighting matters for the same reason — a strong directional shadow
  // would land on the wrong side once mirrored.
  const view =
    spec.category === "vehicle"
      ? "STRICT SIDE VIEW: the vehicle faces exactly RIGHT — its nose points at the " +
        "right edge of the frame and its direction of travel is perfectly horizontal. " +
        "Seen from slightly above so a sliver of the roof shows, but it still reads as " +
        "a clean side profile. Do NOT draw it at an isometric or three-quarter angle, " +
        "and do NOT angle it toward any corner of the frame. Light it evenly and flatly, " +
        "with no strong directional shadow — the sprite gets mirrored to drive the other way. "
      : spec.category === "tool"
        ? // Something held, not something stood on: a building wants the map's
          // viewing angle, a tool wants to look like the item it is.
          "Shown as a clean inventory item icon: the object alone, at a slight " +
          "three-quarter angle, oriented diagonally with its business end toward " +
          "the lower left. Not held by anyone, not resting on anything. "
        : "Viewed from a high three-quarter top-down angle. ";

  return (
    `A single 2D video-game sprite: the body of "${spec.displayName}" (a ${spec.category}). ${spec.flavor} ` +
    view +
    `${aspect} proportions.` +
    parts +
    // The attached images carry their own labels; the style tail below only
    // needs to hold when there is no reference at all.
    // The local backend returned two hollow wireframes on 2026-08-26 by
    // treating a scribble as an exact line map. The cause there was the
    // img2img init (see silhouette.ts) and not the wording, but a multimodal
    // model handed a line drawing can make the same reading, and it costs one
    // sentence to rule out.
    (hasSketch
      ? " The sketch is the OUTLINE of a solid object: fill it in as opaque volume. " +
        "Its lines are the boundary of the shape, not the subject — never render wires, " +
        "tubes, bare frames or a hollow see-through object. "
      : "") +
    " Style: flat cel-shaded colors, chunky simplified toy-like shapes, bold readable silhouette, " +
    "solid opaque bodies filled with flat color, matching the look of Kenney game assets. " +
    (STYLE_PALETTE.length
      ? `Work from this palette where it fits: ${STYLE_PALETTE.join(", ")}. `
      : "") +
    "One object only, centered, filling most of the frame, isolated on a SOLID PURE MAGENTA background (#FF00FF). " +
    "Do not draw a driver, pilot or any person — the players have their own characters. " +
    "No shadows, no ground, no text, no border."
  );
}

/** Usage as reported by the API, so spend can be tracked per fabrication. */
export type ImageUsage = {
  model: string;
  imageTokens: number;
  totalTokens: number;
  /** Local backend only: how much of the art is one object (see
   *  sprite-check.ts). Worth logging — it is the number that decides
   *  whether a frame was re-rolled. */
  unity?: number;
  /** Local backend only: how much of its own bounding box the subject fills.
   *  The other re-roll trigger — this is the one that catches a body drawn
   *  as an outline, which unity scores as a perfect single object. */
  solidity?: number;
  /** Local backend only: how solid the player's sketch was after filling.
   *  Low means they drew open line-work and we thickened it into a mass, so
   *  a body that came out unlike the drawing has its explanation here. */
  sketchSolidity?: number;
};

async function callImageModel(
  model: string,
  parts: Record<string, unknown>[],
  apiKey: string,
): Promise<{ sprite: BodySprite; usage: ImageUsage }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts }] }),
    },
  );
  if (!res.ok) {
    const err = new Error(`Image API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as {
    candidates?: {
      content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] };
    }[];
    usageMetadata?: {
      totalTokenCount?: number;
      candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
    };
  };
  const img = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!img) throw new Error("Image model returned no image");
  return {
    sprite: { dataUrl: `data:${img.mimeType};base64,${img.data}`, mimeType: img.mimeType },
    usage: {
      model,
      imageTokens:
        body.usageMetadata?.candidatesTokensDetails?.find((d) => d.modality === "IMAGE")
          ?.tokenCount ?? 0,
      totalTokens: body.usageMetadata?.totalTokenCount ?? 0,
    },
  };
}

/** Capacity errors — worth another go, or the other model. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

export type ArtReferences = {
  /** The player's rough sketch — shape only. */
  sketch?: string;
  /** The parent design's body, when this is a modification — the new art
   *  should be recognisably the same machine. */
  parent?: string;
};

export async function generateBodySprite(
  spec: FabricatedSpec,
  refs: ArtReferences,
  apiKey: string,
  model: string = IMAGE_MODEL,
): Promise<BodySprite & { usage: ImageUsage; trace: ArtTrace }> {
  // Each image is preceded by a text part saying what it IS. Naming them by
  // position ("the first image…") breaks the moment an optional one is
  // absent, and there are three optional images now.
  const parts: Record<string, unknown>[] = [];
  const attach = (label: string, base64: string) => {
    parts.push({ text: label });
    parts.push({ inlineData: { mimeType: "image/png", data: base64 } });
  };
  const styleRef = STYLE_REFS[spec.category];
  if (styleRef) {
    attach(
      "Style reference from this game — match its exact rendering style: same shading, line treatment, saturation and level of detail:",
      styleRef.base64,
    );
  }
  if (refs.parent) {
    attach(
      "The PREVIOUS VERSION of this machine. The new image must read as the same machine, modified — keep its overall shape, colours and character:",
      refs.parent,
    );
  }
  if (refs.sketch) {
    attach(
      "The player's rough shape sketch. Read it as a SILHOUETTE to fill, not as lines to " +
        "trace: follow its outline and layout, then render the object solid:",
      refs.sketch,
    );
  }
  const prompt = buildImagePrompt(spec, !!refs.sketch, !!styleRef);
  parts.push({ text: prompt });
  // Gemini is handed the sketch as drawn — it reads a drawing AS a drawing,
  // so there is nothing to preprocess and `input` is simply what we sent.
  // Nothing removes its background either, so the frame it returns is both
  // the returned image and the pre-key one; only `preKey` would be a lie
  // here, and it stays absent.
  const trace: ArtTrace = { input: refs.sketch, prompt };

  // Lite is the default and occasionally reports "high demand". A failed call
  // isn't billed, so one retry then the heavier model is cheap insurance
  // against a fabrication losing its art.
  const attempts =
    model === IMAGE_MODEL ? [model, model, IMAGE_FALLBACK_MODEL] : [model];
  let last: unknown;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { sprite, usage } = await callImageModel(attempts[i], parts, apiKey);
      return { ...sprite, usage, trace };
    } catch (err) {
      last = err;
      const status = (err as Error & { status?: number }).status;
      if (!status || !TRANSIENT.has(status)) throw err;
      if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw last;
}
