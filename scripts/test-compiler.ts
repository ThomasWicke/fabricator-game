// The compile orchestrator's retry policy, tested with a fake provider.
//
// This logic decides when a player's fabrication dies and when it quietly
// recovers, and it used to be wrong in a way nothing caught: thrown provider
// errors escaped on the first attempt with no retry at all, so a single 503
// killed the fabrication while a validation failure got a second chance.
// A fake provider makes every failure shape reproducible for free.
//
// Run: npx tsx scripts/test-compiler.ts

import { compileSpecWith } from "../shared/fabricator";
import type {
  CompileInput,
  CompilerConfig,
  FabricatorProvider,
  ProviderResult,
} from "../shared/fabricator";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const CONFIG: CompilerConfig = { provider: "google", model: "fake" };
const INPUT: CompileInput = { name: "Test Rig" };

/** A spec the validator accepts. */
const GOOD_SPEC = {
  category: "structure",
  displayName: "Test Rig",
  size: { w: 60, h: 50 },
  locomotion: {
    type: "none",
    speed: 0,
    terrainModifiers: { grass: 0, sand: 0, swamp: 0, rock: 0, snow: 0, water: 0 },
  },
  seats: 0,
  flavor: "a rig for testing",
};

/** A provider that plays back a script of outcomes, one per call, and
 *  records what it was asked. */
function scripted(outcomes: Array<unknown | Error>): {
  provider: FabricatorProvider;
  calls: CompileInput[];
} {
  const calls: CompileInput[] = [];
  const provider: FabricatorProvider = {
    id: "google",
    async compileSpec(input): Promise<ProviderResult> {
      calls.push(input);
      const next = outcomes[calls.length - 1];
      if (next instanceof Error) throw next;
      return { raw: next, usage: { inputTokens: 10, outputTokens: 20 } };
    },
  };
  return { provider, calls };
}

const run = (outcomes: Array<unknown | Error>) => {
  const { provider, calls } = scripted(outcomes);
  return compileSpecWith(provider, INPUT, CONFIG, "key").then(
    (outcome) => ({ outcome, calls, error: null as Error | null }),
    (error: Error) => ({ outcome: null, calls, error }),
  );
};

console.log("\n── the happy path ──────────────────────────────────────────");

{
  const r = await run([GOOD_SPEC]);
  check("a valid answer compiles first time", !!r.outcome && r.calls.length === 1);
  check("…and reports one attempt", r.outcome?.attempts === 1);
  check("…with usage counted", r.outcome?.usage.outputTokens === 20);
}

console.log("\n── transient failures recover ──────────────────────────────");

{
  const r = await run([new Error("Gemini API 503: overloaded"), GOOD_SPEC]);
  check("a 503 is retried, not fatal", !!r.outcome, r.error?.message ?? "");
  check("…in exactly two calls", r.calls.length === 2, `${r.calls.length}`);
}

{
  const r = await run([new SyntaxError("Unexpected token"), GOOD_SPEC]);
  check("a garbled body is retried", !!r.outcome);
}

{
  const r = await run([new Error("Gemini returned no content"), GOOD_SPEC]);
  check("an empty answer is retried", !!r.outcome);
}

{
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  const r = await run([abort, GOOD_SPEC]);
  check("a timeout is retried", !!r.outcome);
}

console.log("\n── permanent failures fail fast ────────────────────────────");

{
  const r = await run([new Error("Gemini API 400: bad request"), GOOD_SPEC]);
  check(
    "a 400 is not retried — it is our bug and will fail identically",
    !r.outcome && r.calls.length === 1,
    `${r.calls.length} call(s)`,
  );
}

{
  const r = await run([new Error("Gemini API 403: key invalid"), GOOD_SPEC]);
  check("a 403 is not retried", !r.outcome && r.calls.length === 1);
}

console.log("\n── validation failures become corrections ──────────────────");

{
  const bad = { ...GOOD_SPEC, category: "spaceship" };
  const r = await run([bad, GOOD_SPEC]);
  check("an invalid spec gets a second chance", !!r.outcome);
  check(
    "…and the retry carries the validator's reasons",
    !!r.calls[1]?.feedback && /category/.test(r.calls[1].feedback ?? ""),
    r.calls[1]?.feedback ?? "(no feedback)",
  );
  check("…while the first call carried none", r.calls[0]?.feedback === undefined);
}

{
  const bad = { ...GOOD_SPEC, category: "spaceship" };
  const r = await run([bad, bad, bad, GOOD_SPEC]);
  check(
    "the call budget is a hard ceiling — three, then give up",
    !r.outcome && r.calls.length === 3,
    `${r.calls.length} call(s)`,
  );
  check(
    "…and the error names the validation problem",
    /failed validation/.test(r.error?.message ?? ""),
    r.error?.message ?? "",
  );
}

{
  // Mixed budget: one transient blip, then an invalid answer, then a good
  // one — the two failure kinds share the same ceiling.
  const bad = { ...GOOD_SPEC, category: "spaceship" };
  const r = await run([new Error("Gemini API 503: x"), bad, GOOD_SPEC]);
  check("a blip plus a correction still fits the budget", !!r.outcome && r.calls.length === 3);
}

console.log(
  failures === 0
    ? "\n✓ all compiler checks passed\n"
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
