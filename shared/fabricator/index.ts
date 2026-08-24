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
import type {
  CompileInput,
  CompilerConfig,
  FabricatorProvider,
  TokenUsage,
} from "./provider";

const PROVIDERS: Record<CompilerConfig["provider"], FabricatorProvider> = {
  google: googleProvider,
  anthropic: anthropicProvider,
};

export type CompileOutcome = {
  spec: FabricatedSpec;
  usage: TokenUsage;
  attempts: number;
};

export async function compileSpec(
  input: CompileInput,
  config: CompilerConfig,
  apiKey: string,
): Promise<CompileOutcome> {
  const provider = PROVIDERS[config.provider];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await provider.compileSpec(input, config.model, apiKey);
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    lastErrors = validateSpec(result.raw);
    if (lastErrors.length === 0) {
      const clamped = clampSpec(result.raw as RawSpec);
      return {
        spec: { ...clamped, cost: computeCost(clamped) },
        usage,
        attempts: attempt,
      };
    }
  }
  throw new Error(`Spec failed validation after retry: ${lastErrors.join(", ")}`);
}

export * from "./schema";
export * from "./provider";
export { computeCost } from "./cost";
export { mockCompile } from "./mock";
