// Provider adapter interface + compiler config.
// ISOMORPHIC — fetch-only; the caller supplies the API key (PartyKit env
// today, browser localStorage in the future BYOK milestone). No process.env,
// no PartyKit imports.

export type ProviderId = "google" | "anthropic";

export type CompilerConfig = {
  provider: ProviderId;
  /** Model ID — config string only, never inline in provider code. */
  model: string;
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

export type CompileInput = {
  name: string;
  intent?: string;
  /** Raw base64 PNG (no data: prefix), ≤256px sketch. */
  imageBase64?: string;
  /** Validation errors from a failed previous attempt, fed back so the retry
   *  is a correction rather than a blind re-roll. */
  feedback?: string;
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
    model: string,
    apiKey: string,
    /** Per-attempt timeout, owned by the orchestrator. */
    signal?: AbortSignal,
  ): Promise<ProviderResult>;
}
