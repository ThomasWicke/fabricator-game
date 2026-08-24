// Body-sprite generation: spec (+ player sketch as shape reference) → a
// game-ready body image on a solid magenta background. Gemini image models
// can't output alpha, so the client chroma-keys the magenta out
// (client/src/screen/chroma.ts).
//
// Vehicles are asked for COMPLETE — running gear included. The hybrid
// approach (AI body + library parts bolted on at anchors) doubled up: the
// generated art drew its own wheels and our sprites sat on top of them.
// Structures still take library parts (lamps, chimneys) since those pair
// with emission effects rather than duplicating the silhouette.
//
// ISOMORPHIC — fetch-only, caller supplies the key. No env access.

import type { FabricatedSpec } from "./schema";

/** Paid-tier image model (Nano Banana 2). ~10s, ~340KB JPEG.
 *  `gemini-3.1-flash-lite-image` is the fast/cheap alternative (~3s). */
export const IMAGE_MODEL = "gemini-3.1-flash-image";

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
    "No shadows, no ground, no text, no border."
  );
}

export async function generateBodySprite(
  spec: FabricatedSpec,
  sketchBase64: string | undefined,
  apiKey: string,
  model: string = IMAGE_MODEL,
): Promise<BodySprite> {
  const parts: Record<string, unknown>[] = [];
  if (sketchBase64) {
    parts.push({ inlineData: { mimeType: "image/png", data: sketchBase64 } });
  }
  parts.push({ text: buildImagePrompt(spec, !!sketchBase64) });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts }] }),
    },
  );
  if (!res.ok) {
    throw new Error(`Image API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    candidates?: {
      content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] };
    }[];
  };
  const img = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!img) throw new Error("Image model returned no image");
  return {
    dataUrl: `data:${img.mimeType};base64,${img.data}`,
    mimeType: img.mimeType,
  };
}
