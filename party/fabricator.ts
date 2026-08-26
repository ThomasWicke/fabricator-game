// PartyKit-side Fabricator endpoint: resolves the API key from room env,
// enforces a per-room rate cap, and delegates to the isomorphic compile
// module in shared/fabricator/. This file is the only place key resolution
// happens — the shared module never touches env.
//
// Provider order is a degradation chain, not a single pick: the self-hosted
// Mac mini first (free), then Gemini, then Anthropic, then the offline mock.
// A dead local server costs one failed attempt chain, never a dead game.

import {
  compileSpec,
  mockCompile,
  DEFAULT_COMPILER_CONFIG,
  ANTHROPIC_COMPILER_CONFIG,
  OLLAMA_COMPILER_CONFIG,
  type CompileInput,
  type CompilerConfig,
  type FabricatedSpec,
} from "../shared/fabricator";
import { generateBodySprite } from "../shared/fabricator/image";
import type { ArtTrace } from "../shared/fabricator/image";
import { generateBodySpriteLocal } from "../shared/fabricator/image-local";

/** Per-room fabrication cap so a deployed demo key can't be farmed. */
const MAX_PER_HOUR = 20;

export class FabricatorEndpoint {
  private timestamps: number[] = [];

  constructor(private env: Record<string, unknown>) {}

  /** Throws with a player-facing message on rate cap. */
  checkRateCap(): void {
    const hourAgo = Date.now() - 3600_000;
    this.timestamps = this.timestamps.filter((t) => t > hourAgo);
    if (this.timestamps.length >= MAX_PER_HOUR) {
      throw new Error("The Fabricator is overheated — try again later.");
    }
    this.timestamps.push(Date.now());
  }

  private resolve(): { config: CompilerConfig; apiKey: string }[] {
    const chain: { config: CompilerConfig; apiKey: string }[] = [];
    const localUrl = this.env.LOCAL_AI_URL as string | undefined;
    if (localUrl) {
      chain.push({
        config: {
          ...OLLAMA_COMPILER_CONFIG,
          model:
            (this.env.LOCAL_COMPILER_MODEL as string | undefined) ??
            OLLAMA_COMPILER_CONFIG.model,
          baseUrl: localUrl,
        },
        apiKey: (this.env.LOCAL_AI_TOKEN as string | undefined) ?? "",
      });
    }
    const googleKey = this.env.GOOGLE_API_KEY as string | undefined;
    if (googleKey) chain.push({ config: DEFAULT_COMPILER_CONFIG, apiKey: googleKey });
    const anthropicKey = this.env.ANTHROPIC_API_KEY as string | undefined;
    if (anthropicKey) chain.push({ config: ANTHROPIC_COMPILER_CONFIG, apiKey: anthropicKey });
    return chain;
  }

  /** The spec, and WHICH link of the chain produced it. The degradation
   *  chain is invisible from the outside — a fabrication looks identical
   *  whether the Mac mini answered or Gemini caught the fall — so the model
   *  travels with the result and ends up in the player's /log. */
  async compile(input: CompileInput): Promise<{ spec: FabricatedSpec; model: string }> {
    this.checkRateCap();
    const chain = this.resolve();
    if (chain.length === 0) {
      // Keyless dev / test harness: keep the loop playable offline.
      return { spec: mockCompile(input), model: "offline mock (no key configured)" };
    }
    let lastErr: unknown;
    for (const { config, apiKey } of chain) {
      const label = `${config.provider}/${config.model}`;
      try {
        const outcome = await compileSpec(input, config, apiKey);
        console.log(
          `fabricated "${input.name}" via ${label}` +
            ` in ${outcome.attempts} attempt(s), tokens in=${outcome.usage.inputTokens}` +
            ` out=${outcome.usage.outputTokens}`,
        );
        return { spec: outcome.spec, model: label };
      } catch (err) {
        lastErr = err;
        console.error(`compile via ${label} failed:`, err);
      }
    }
    throw lastErr;
  }

  /**
   * AI body sprite for the spec. Local ComfyUI first when configured, then
   * the Gemini path (Anthropic has no image model). Failures return null:
   * the game falls back to the player's sketch, fabrication never dies on
   * the art step.
   *
   * Tools used to be skipped here, on the grounds that they render as 22px
   * icons and are not worth the round trip. That stopped being true when they
   * became things you carry: a tool now has a thumbnail in the library and an
   * entry on the belt. Worse, the fallback it relied on does not exist for a
   * blueprint submitted with only a name — the sketch pad returns nothing
   * when nothing was drawn — so those tools came out as a grey rectangle.
   */
  async bodySprite(
    spec: FabricatedSpec,
    refs: { sketch?: string; parent?: string },
  ): Promise<{ dataUrl: string; model: string; trace: ArtTrace } | null> {
    const localUrl = this.env.LOCAL_IMAGE_URL as string | undefined;
    if (localUrl) {
      try {
        const t0 = Date.now();
        const sprite = await generateBodySpriteLocal(spec, refs, {
          baseUrl: localUrl,
          token: (this.env.LOCAL_AI_TOKEN as string | undefined) ?? "",
        });
        console.log(
          `body sprite for "${spec.displayName}" in ${Date.now() - t0}ms via ` +
            `${sprite.usage.model} (local, unity=${sprite.usage.unity?.toFixed(2)}, ` +
            // solidity is the re-roll trigger that catches a body drawn as an
            // outline; sketchSolidity says how much shape the player gave us
            // to work from. Both belong in the trace — between them they
            // explain a body that came out unlike the drawing.
            `solidity=${sprite.usage.solidity?.toFixed(2)}, ` +
            (Number.isFinite(sprite.usage.sketchSolidity)
              ? `sketch=${sprite.usage.sketchSolidity!.toFixed(2)}, `
              : "") +
            `~${Math.round(sprite.dataUrl.length / 1024)}KB wire)`,
        );
        return { dataUrl: sprite.dataUrl, model: `${sprite.usage.model} (local)`, trace: sprite.trace };
      } catch (err) {
        console.error("local body sprite failed, trying cloud:", err);
      }
    }
    const googleKey = this.env.GOOGLE_API_KEY as string | undefined;
    if (!googleKey) return null;
    try {
      const t0 = Date.now();
      const sprite = await generateBodySprite(spec, refs, googleKey);
      // Log usage per fabrication: image output bills at a flat token count,
      // so counting these lines is counting the spend.
      console.log(
        `body sprite for "${spec.displayName}" in ${Date.now() - t0}ms via ` +
          `${sprite.usage.model} (${sprite.usage.imageTokens} image tokens, ` +
          `${sprite.usage.totalTokens} total, ~${Math.round(sprite.dataUrl.length / 1024)}KB wire)`,
      );
      return { dataUrl: sprite.dataUrl, model: sprite.usage.model, trace: sprite.trace };
    } catch (err) {
      console.error("body sprite failed, falling back to sketch:", err);
      return null;
    }
  }
}
