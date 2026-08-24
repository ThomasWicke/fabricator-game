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
 * Dev default: Gemini free tier ($0 during development).
 *
 * Model choice (probed 2026-08-24 against a free-tier key): the 2.5 family
 * is retired ("no longer available to new users"), and both
 * `gemini-flash-latest` and `gemini-3.7-flash` are capacity-gated on the
 * free tier — they hang past 25s. `gemini-3.6-flash` answers in ~1.7s.
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
  ): Promise<ProviderResult>;
}
