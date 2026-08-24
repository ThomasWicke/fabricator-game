// Gemini provider — structured output via generationConfig.responseSchema.
// Raw fetch to the REST API; works in workers and browsers alike.
// ISOMORPHIC — no env access, no platform imports.

import { SPEC_JSON_SCHEMA } from "../schema";
import { SYSTEM_PROMPT, buildUserText } from "../prompt";
import type { FabricatorProvider, ProviderResult } from "../provider";

/**
 * Convert standard JSON Schema to Gemini's Schema dialect: uppercase type
 * names, no additionalProperties. Enums stay as-is on STRING.
 */
function toGeminiSchema(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof node.type === "string") out.type = node.type.toUpperCase();
  if (node.enum) out.enum = node.enum;
  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties as Record<string, Record<string, unknown>>).map(
        ([k, v]) => [k, toGeminiSchema(v)],
      ),
    );
  }
  if (node.required) out.required = node.required;
  if (node.items) out.items = toGeminiSchema(node.items as Record<string, unknown>);
  return out;
}

export const googleProvider: FabricatorProvider = {
  id: "google",

  async compileSpec(input, model, apiKey): Promise<ProviderResult> {
    const parts: Record<string, unknown>[] = [];
    if (input.imageBase64) {
      parts.push({ inlineData: { mimeType: "image/png", data: input.imageBase64 } });
    }
    parts.push({ text: buildUserText(input) });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(SPEC_JSON_SCHEMA as unknown as Record<string, unknown>),
          },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
    if (!text) throw new Error("Gemini returned no content");
    return {
      raw: JSON.parse(text),
      usage: {
        inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  },
};
