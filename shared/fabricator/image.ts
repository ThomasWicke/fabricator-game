// Body-sprite generation: spec (+ player sketch as shape reference) → a
// game-ready body image on a solid magenta background. Gemini image models
// can't output alpha, so the client chroma-keys the magenta out
// (client/src/screen/chroma.ts).
//
// The prompt asks for the BODY ONLY — wheels/legs/floats/drills come from
// the hand-made part library at spec anchors (the hybrid pipeline), so the
// image model is told to leave them off.
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
  const noParts =
    spec.category === "structure"
      ? ""
      : " Do NOT draw wheels, tracks, legs, floats or drills — the body only, as if the running gear has been removed; those parts are attached separately.";
  return (
    `A single 2D video-game sprite: the body of "${spec.displayName}" (a ${spec.category}). ${spec.flavor} ` +
    `Viewed from a high three-quarter top-down angle. ${aspect} proportions.` +
    noParts +
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
