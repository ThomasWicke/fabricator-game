// Provider adapter interface + compiler config.
// ISOMORPHIC — fetch-only; the caller supplies the API key (PartyKit env
// today, browser localStorage in the future BYOK milestone). No process.env,
// no PartyKit imports.

export type ProviderId = "google" | "anthropic" | "ollama";

export type CompilerConfig = {
  provider: ProviderId;
  /** Model ID — config string only, never inline in provider code. */
  model: string;
  /** Server origin for self-hosted providers (Ollama). Cloud providers have
   *  their endpoint baked into the provider module and leave this unset. */
  baseUrl?: string;
  /** Per-attempt timeout override. Local inference needs more than the 30s
   *  cloud default: a cold model load alone can eat that. */
  timeoutMs?: number;
};

/**
 * Default: Gemini, on the user's paid tier-1 key.
 *
 * Model choice (probed 2026-08-24, then a FREE-tier key): the 2.5 family is
 * retired, and `gemini-flash-latest` / `gemini-3.7-flash` hung past 25s —
 * but that was free-tier capacity gating, and the account has since moved to
 * paid tier 1. Both are worth re-probing via the eval before trusting this
 * default again. `gemini-3.6-flash` answers in ~1.7s.
 */
export const DEFAULT_COMPILER_CONFIG: CompilerConfig = {
  provider: "google",
  model: "gemini-3.6-flash",
};

/** Cheaper/faster free-tier alternative; compare via scripts/eval-compiler.ts. */
export const GOOGLE_LITE_COMPILER_CONFIG: CompilerConfig = {
  provider: "google",
  model: "gemini-3.5-flash-lite",
};

/** Quality-anchor config for demos / eval comparison. */
export const ANTHROPIC_COMPILER_CONFIG: CompilerConfig = {
  provider: "anthropic",
  model: "claude-sonnet-5",
};

/**
 * Self-hosted compiler on the Mac mini (Ollama). Vision + native structured
 * outputs, $0 per call. `baseUrl` is injected at resolve time from env
 * (LOCAL_AI_URL) — this constant carries only what is config, not deployment.
 * 60s timeout: one cold model load must not burn all three MAX_CALLS.
 */
export const OLLAMA_COMPILER_CONFIG: CompilerConfig = {
  provider: "ollama",
  model: "qwen3-vl:8b",
  timeoutMs: 60_000,
};

export type CompileInput = {
  name: string;
  intent?: string;
  /** Raw base64 PNG (no data: prefix), ≤256px sketch. */
  imageBase64?: string;
  /** Validation errors from a failed previous attempt, fed back so the retry
   *  is a correction rather than a blind re-roll. */
  feedback?: string;
  /** The spec being modified, when this blueprint is a variant of an
   *  existing design rather than a fresh invention. */
  parentSpec?: object;
};

export type TokenUsage = { inputTokens: number; outputTokens: number };

export type ProviderResult = {
  /** Parsed but NOT yet validated spec object. */
  raw: unknown;
  usage: TokenUsage;
};

export interface FabricatorProvider {
  id: ProviderId;
  compileSpec(
    input: CompileInput,
    /** Full config, not just the model — self-hosted providers need baseUrl. */
    config: CompilerConfig,
    apiKey: string,
    /** Per-attempt timeout, owned by the orchestrator. */
    signal?: AbortSignal,
  ): Promise<ProviderResult>;
}
