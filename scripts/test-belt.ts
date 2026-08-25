// The belt's index arithmetic. Short, but it wraps through a position that
// isn't a tool — bare hands — and that is where the off-by-one lives.
//
// Run: npx tsx scripts/test-belt.ts

import { BELT_MAX, HANDS, nextBeltIndex } from "../client/src/screen/belt";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Walk the cycle from bare hands and record where it goes. */
const walk = (count: number, steps: number): number[] => {
  const seen: number[] = [];
  let at = HANDS;
  for (let i = 0; i < steps; i++) {
    at = nextBeltIndex(at, count);
    seen.push(at);
  }
  return seen;
};

console.log("\n── cycling ─────────────────────────────────────────────────");

check("an empty belt stays empty-handed", walk(0, 3).every((i) => i === HANDS));
check(
  "one tool alternates with bare hands",
  JSON.stringify(walk(1, 4)) === JSON.stringify([0, HANDS, 0, HANDS]),
  JSON.stringify(walk(1, 4)),
);
check(
  "two tools cycle through hands, not straight past them",
  JSON.stringify(walk(2, 6)) === JSON.stringify([0, 1, HANDS, 0, 1, HANDS]),
  JSON.stringify(walk(2, 6)),
);
check(
  "a full belt reaches every tool",
  new Set(walk(BELT_MAX, BELT_MAX + 1)).size === BELT_MAX + 1,
  JSON.stringify(walk(BELT_MAX, BELT_MAX + 1)),
);

console.log("\n── the invariants ──────────────────────────────────────────");

{
  // Whatever the belt holds, cycling must return home in exactly count+1
  // steps: every tool once, and bare hands once.
  let ok = true;
  for (let count = 1; count <= BELT_MAX; count++) {
    const seen = walk(count, count + 1);
    if (seen[seen.length - 1] !== HANDS) ok = false;
    if (new Set(seen).size !== count + 1) ok = false;
  }
  check("one full lap is every tool plus hands, with nothing repeated", ok);
}

{
  // Never off the end of the array — this is read straight into belt[i].
  let ok = true;
  for (let count = 0; count <= BELT_MAX; count++) {
    for (let from = HANDS; from < count; from++) {
      const to = nextBeltIndex(from, count);
      if (to < HANDS || to >= count) ok = false;
    }
  }
  check("the result is always a real position or bare hands", ok);
}

{
  // A belt that shrank under a stale index — a save restored with fewer tools
  // than the index it recorded — must land somewhere valid rather than
  // indexing past the end.
  const to = nextBeltIndex(3, 1);
  check("a stale index past the end falls back to bare hands", to === HANDS, `${to}`);
}

console.log(
  failures === 0 ? "\n✓ all belt checks passed\n" : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
