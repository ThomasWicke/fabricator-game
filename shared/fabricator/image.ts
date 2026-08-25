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

function buildImagePrompt(spec: FabricatedSpec, hasSketch: boolean): string {
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
      : "Viewed from a high three-quarter top-down angle. ";

  return (
    `A single 2D video-game sprite: the body of "${spec.displayName}" (a ${spec.category}). ${spec.flavor} ` +
    view +
    `${aspect} proportions.` +
    parts +
    (hasSketch
      ? " Use the attached rough player sketch as the shape reference — follow its silhouette and layout, but render it properly."
      : "") +
    " Style: flat cel-shaded colors, chunky simplified toy-like shapes, bold readable silhouette, matching the look of Kenney game assets. " +
    "One object only, centered, filling most of the frame, isolated on a SOLID PURE MAGENTA background (#FF00FF). " +
    "Do not draw a driver, pilot or any person — the players have their own characters. " +
    "No shadows, no ground, no text, no border."
  );
}

/** Usage as reported by the API, so spend can be tracked per fabrication. */
export type ImageUsage = { model: string; imageTokens: number; totalTokens: number };

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

export async function generateBodySprite(
  spec: FabricatedSpec,
  sketchBase64: string | undefined,
  apiKey: string,
  model: string = IMAGE_MODEL,
): Promise<BodySprite & { usage: ImageUsage }> {
  const parts: Record<string, unknown>[] = [];
  if (sketchBase64) {
    parts.push({ inlineData: { mimeType: "image/png", data: sketchBase64 } });
  }
  parts.push({ text: buildImagePrompt(spec, !!sketchBase64) });

  // Lite is the default and occasionally reports "high demand". A failed call
  // isn't billed, so one retry then the heavier model is cheap insurance
  // against a fabrication losing its art.
  const attempts =
    model === IMAGE_MODEL ? [model, model, IMAGE_FALLBACK_MODEL] : [model];
  let last: unknown;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { sprite, usage } = await callImageModel(attempts[i], parts, apiKey);
      return { ...sprite, usage };
    } catch (err) {
      last = err;
      const status = (err as Error & { status?: number }).status;
      if (!status || !TRANSIENT.has(status)) throw err;
      if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw last;
}
