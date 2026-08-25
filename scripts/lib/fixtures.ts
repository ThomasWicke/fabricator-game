// Record/replay for the compiler eval.
//
// The eval used to be live-API-only, which meant it cost money, took minutes,
// and therefore never ran — so the downstream pipeline (validate → clamp →
// cost → per-pair checks) had no regression net at all. A fixture is the raw
// provider response from a real run; replaying it through the real
// orchestrator exercises everything except the network for free, every
// `npm test`.
//
// A fixture is invalidated by anything that changes what the model was asked:
// the system prompt, the user text builder, the response grammar, the model
// id, or the pair itself. All of that is folded into the key, so a stale
// fixture simply stops being found rather than silently vouching for a
// prompt it never saw.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SPEC_JSON_SCHEMA } from "../../shared/fabricator/schema";
import { SYSTEM_PROMPT, buildUserText } from "../../shared/fabricator/prompt";
import type { CompileInput, CompilerConfig, ProviderResult } from "../../shared/fabricator";

const ROOT = fileURLToPath(new URL("../../fixtures/compiler/", import.meta.url));

export type Fixture = {
  /** What was asked, for humans reading the file. */
  meta: {
    name: string;
    intent?: string;
    hasSketch: boolean;
    model: string;
    recordedAt: string;
    attempts: number;
  };
  /** The raw response that ended the run — parsed JSON on success. */
  raw?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  /** Set instead of `raw` when the live run itself failed. */
  error?: string;
};

/** Everything that shapes the request, hashed. `buildUserText` is included
 *  via its OUTPUT for this input, so a wording change re-keys exactly the
 *  fixtures it affects. */
export function fixtureKey(config: CompilerConfig, input: CompileInput): string {
  const h = createHash("sha256");
  h.update(config.provider);
  h.update(config.model);
  h.update(SYSTEM_PROMPT);
  h.update(JSON.stringify(SPEC_JSON_SCHEMA));
  h.update(buildUserText(input));
  h.update(input.imageBase64 ?? "");
  return h.digest("hex").slice(0, 12);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32);

function fixturePath(config: CompilerConfig, input: CompileInput): string {
  const dir = join(ROOT, config.model);
  return join(dir, `${slug(input.name)}-${fixtureKey(config, input)}.json`);
}

export function loadFixture(config: CompilerConfig, input: CompileInput): Fixture | null {
  const path = fixturePath(config, input);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

export function saveFixture(
  config: CompilerConfig,
  input: CompileInput,
  fixture: Fixture,
): void {
  const dir = join(ROOT, config.model);
  mkdirSync(dir, { recursive: true });
  writeFileSync(fixturePath(config, input), JSON.stringify(fixture, null, 2) + "\n");
}

/** Fixture files present for a model — stale ones (whose key no longer
 *  matches any pair) show up here and nowhere else. */
export function listFixtures(model: string): string[] {
  const dir = join(ROOT, model);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

/** A provider whose answers come from disk. Fed to compileSpecWith, so the
 *  replay runs the real orchestrator — real validation, real clamping, real
 *  costing — on the recorded response. */
export function replayProvider(fixture: Fixture) {
  return {
    id: "google" as const,
    async compileSpec(): Promise<ProviderResult> {
      if (fixture.error) throw new Error(fixture.error);
      return {
        raw: fixture.raw,
        usage: fixture.usage ?? { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

export function appendHistory(entry: Record<string, unknown>): void {
  mkdirSync(ROOT, { recursive: true });
  const path = join(ROOT, "..", "eval-history.jsonl");
  const line = JSON.stringify(entry) + "\n";
  writeFileSync(path, existsSync(path) ? readFileSync(path, "utf8") + line : line);
}
