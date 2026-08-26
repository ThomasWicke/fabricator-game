// Ollama provider — the self-hosted compiler on the Mac mini. Structured
// output via `format`: Ollama takes standard JSON Schema verbatim and
// constrains decoding to it (no dialect conversion, unlike Gemini's
// uppercase-type Schema). Vision input rides as raw base64 in
// `messages[].images` — exactly what CompileInput.imageBase64 already holds.
// ISOMORPHIC — no env access, no platform imports; baseUrl comes via config.

import { SPEC_JSON_SCHEMA } from "../schema";
import { SYSTEM_PROMPT, buildUserText } from "../prompt";
import { localAuthHeaders } from "../local-auth";
import type { FabricatorProvider, ProviderResult } from "../provider";

/**
 * Grammar-constrained decoding quietly suppresses OPTIONAL properties: once
 * the required fields are written, "close the object" is the cheapest path,
 * and both qwen3-vl sizes dropped every capability block (harvest, weapon,
 * emission…) that the same model includes when unconstrained. The fix is the
 * one OpenAI's structured outputs mandate: every property required, with
 * optionality expressed as an explicit null the model must choose against.
 * stripNulls() then restores the absent-field shape the validator expects.
 */
function toOllamaSchema(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  if (node.properties) {
    const required = new Set((node.required as string[]) ?? []);
    out.properties = Object.fromEntries(
      Object.entries(node.properties as Record<string, Record<string, unknown>>).map(
        ([key, prop]) => {
          const converted = toOllamaSchema(prop);
          return [key, required.has(key) ? converted : { anyOf: [converted, { type: "null" }] }];
        },
      ),
    );
    out.required = Object.keys(node.properties as object);
  }
  if (node.items) out.items = toOllamaSchema(node.items as Record<string, unknown>);
  return out;
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNulls(v)]),
    );
  }
  return value;
}

export const ollamaProvider: FabricatorProvider = {
  id: "ollama",

  async compileSpec(input, config, apiKey, signal): Promise<ProviderResult> {
    if (!config.baseUrl) throw new Error("Ollama config is missing baseUrl");
    const userMessage: Record<string, unknown> = {
      role: "user",
      content: buildUserText(input),
    };
    if (input.imageBase64) userMessage.images = [input.imageBase64];

    const res = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...localAuthHeaders(apiKey) },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, userMessage],
        format: toOllamaSchema(SPEC_JSON_SCHEMA as unknown as Record<string, unknown>),
        // Thinking + format makes Ollama run a long unconstrained reasoning
        // pass and then RE-PROCESS it all for the constrained pass — measured
        // at ~90s extra per call on qwen3-vl:8b. Off: ~10s warm.
        think: false,
        options: { temperature: 0.7, num_ctx: 8192 },
        // Keep the model resident between fabrications; a cold load costs
        // 15-40s, which is most of the latency budget.
        keep_alive: "30m",
      }),
    });
    if (!res.ok) {
      // "API <status>" wording matters: the orchestrator's isTransient regex
      // keys on it to retry 429/5xx and give up on 4xx.
      throw new Error(`Ollama API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      message?: { content?: string; thinking?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    // Some models' chat templates open a think block even with think:false,
    // so Ollama's parser files the (still schema-constrained) answer under
    // `thinking` and leaves `content` empty. Either way it is our JSON.
    const text = body.message?.content || body.message?.thinking;
    if (!text) throw new Error("Ollama returned no content");
    return {
      raw: stripNulls(JSON.parse(text)),
      usage: {
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
      },
    };
  },
};
