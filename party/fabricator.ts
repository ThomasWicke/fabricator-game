// PartyKit-side Fabricator endpoint: resolves the API key from room env,
// enforces a per-room rate cap, and delegates to the isomorphic compile
// module in shared/fabricator/. This file is the only place key resolution
// happens — the shared module never touches env.

import {
  compileSpec,
  mockCompile,
  DEFAULT_COMPILER_CONFIG,
  ANTHROPIC_COMPILER_CONFIG,
  type CompileInput,
  type CompilerConfig,
  type FabricatedSpec,
} from "../shared/fabricator";
import { generateBodySprite } from "../shared/fabricator/image";

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

  private resolve(): { config: CompilerConfig; apiKey: string } | null {
    const googleKey = this.env.GOOGLE_API_KEY as string | undefined;
    if (googleKey) return { config: DEFAULT_COMPILER_CONFIG, apiKey: googleKey };
    const anthropicKey = this.env.ANTHROPIC_API_KEY as string | undefined;
    if (anthropicKey) return { config: ANTHROPIC_COMPILER_CONFIG, apiKey: anthropicKey };
    return null;
  }

  async compile(input: CompileInput): Promise<FabricatedSpec> {
    this.checkRateCap();
    const resolved = this.resolve();
    if (!resolved) {
      // Keyless dev / test harness: keep the loop playable offline.
      return mockCompile(input);
    }
    const outcome = await compileSpec(input, resolved.config, resolved.apiKey);
    console.log(
      `fabricated "${input.name}" via ${resolved.config.provider}/${resolved.config.model}` +
        ` in ${outcome.attempts} attempt(s), tokens in=${outcome.usage.inputTokens}` +
        ` out=${outcome.usage.outputTokens}`,
    );
    return outcome.spec;
  }

  /**
   * AI body sprite for the spec (Google key only — Anthropic has no image
   * model). Failures return null: the game falls back to the player's
   * sketch, fabrication never dies on the art step.
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
  ): Promise<string | null> {
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
      return sprite.dataUrl;
    } catch (err) {
      console.error("body sprite failed, falling back to sketch:", err);
      return null;
    }
  }
}
