// Isomorphic compile orchestrator: provider call → parse → validate in code
// → retry once on invalid → clamp → cost. The PartyKit endpoint (today) and
// the browser-direct BYOK path (later) both call THIS function; only the
// key source differs.

import {
  clampSpec,
  validateSpec,
  type FabricatedSpec,
  type RawSpec,
} from "./schema";
import { computeCost } from "./cost";
import { googleProvider } from "./providers/google";
import { anthropicProvider } from "./providers/anthropic";
import { ollamaProvider } from "./providers/ollama";
import type {
  CompileInput,
  CompilerConfig,
  FabricatorProvider,
  TokenUsage,
} from "./provider";

const PROVIDERS: Record<CompilerConfig["provider"], FabricatorProvider> = {
  google: googleProvider,
  anthropic: anthropicProvider,
  ollama: ollamaProvider,
};

export type CompileOutcome = {
  spec: FabricatedSpec;
  usage: TokenUsage;
  attempts: number;
};

/** Per-attempt ceiling (cloud default; a config may override via timeoutMs —
 *  local inference needs 60s to survive a cold model load). The whole
 *  pipeline sits behind a ~90s client-side patience budget, and two 30s
 *  attempts plus image generation fit inside it; an unbounded fetch that
 *  never returns does not. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Provider calls across all failure kinds. Bounded, because a retry loop
 *  that mixes two failure budgets can otherwise multiply them. */
const MAX_CALLS = 3;

/** Worth one more try: capacity blips, gateway noise, a garbled or empty
 *  body, a timeout. A 400/401/403 is OUR bug or OUR key and will fail the
 *  same way every time — retrying it just costs money and delay. */
const isTransient = (err: unknown): boolean => {
  if (err instanceof SyntaxError) return true; // malformed JSON body
  if (err instanceof Error && err.name === "AbortError") return true; // timeout
  const msg = err instanceof Error ? err.message : String(err);
  return /API (429|500|502|503|504)\b/.test(msg) || /returned no content/.test(msg);
};

export async function compileSpec(
  input: CompileInput,
  config: CompilerConfig,
  apiKey: string,
): Promise<CompileOutcome> {
  return compileSpecWith(PROVIDERS[config.provider], input, config, apiKey);
}

/** The orchestration itself, with the provider injected — which is what lets
 *  the retry policy be tested with a fake instead of a paid API. */
export async function compileSpecWith(
  provider: FabricatorProvider,
  input: CompileInput,
  config: CompilerConfig,
  apiKey: string,
): Promise<CompileOutcome> {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  let feedback: string | undefined;
  let lastErrors: string[] = [];
  for (let call = 1; call <= MAX_CALLS; call++) {
    let result;
    try {
      result = await provider.compileSpec(
        { ...input, feedback },
        config,
        apiKey,
        AbortSignal.timeout(config.timeoutMs ?? ATTEMPT_TIMEOUT_MS),
      );
    } catch (err) {
      // Thrown errors used to escape on attempt 1 with no retry at all —
      // only validation failures got a second chance, so a single 503 or a
      // truncated body killed the fabrication outright.
      if (call < MAX_CALLS && isTransient(err)) continue;
      throw err;
    }
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    lastErrors = validateSpec(result.raw);
    if (lastErrors.length === 0) {
      const clamped = clampSpec(result.raw as RawSpec);
      return {
        spec: { ...clamped, cost: computeCost(clamped) },
        usage,
        attempts: call,
      };
    }
    // The next call is a correction, not a re-roll: it carries the reasons
    // this answer was rejected.
    feedback = lastErrors.join("; ");
  }
  throw new Error(`Spec failed validation after retry: ${lastErrors.join(", ")}`);
}

export * from "./schema";
export * from "./provider";
export { computeCost } from "./cost";
export { mockCompile } from "./mock";
