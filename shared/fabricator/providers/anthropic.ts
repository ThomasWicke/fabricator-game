// Anthropic provider — structured output via output_config.format.
// Raw fetch (kept dependency-light and isomorphic per the AI-backend plan;
// browser-direct BYOK later needs the CORS opt-in header, included below).
// ISOMORPHIC — no env access, no platform imports.

import { SPEC_JSON_SCHEMA } from "../schema";
import { SYSTEM_PROMPT, buildUserText } from "../prompt";
import type { FabricatorProvider, ProviderResult } from "../provider";

export const anthropicProvider: FabricatorProvider = {
  id: "anthropic",

  async compileSpec(input, model, apiKey, signal): Promise<ProviderResult> {
    const content: Record<string, unknown>[] = [];
    if (input.imageBase64) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: input.imageBase64 },
      });
    }
    content.push({ type: "text", text: buildUserText(input) });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Allows the future BYOK browser-direct path; harmless server-side.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
        output_config: {
          format: { type: "json_schema", schema: SPEC_JSON_SCHEMA },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.content?.find((b) => b.type === "text")?.text;
    if (!text) throw new Error("Anthropic returned no text content");
    return {
      raw: JSON.parse(text),
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
    };
  },
};
