// The production chroma keyer against synthetic images it must and must not
// key. This is the exact code the browser runs (chroma-core.ts) — testing a
// re-implementation would test nothing.
//
// Run: npx tsx scripts/test-chroma.ts

import { FLATNESS, HARD, keyImage } from "../client/src/screen/chroma-core";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

type RGB = [number, number, number];

/** A W×H field of `bg` with a centred `fw×fh` rectangle of `fg` — the shape
 *  of every well-behaved model output. */
function subjectOn(
  bg: RGB,
  fg: RGB,
  w = 64,
  h = 64,
  fw = 30,
  fh = 24,
): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside =
        x >= (w - fw) / 2 && x < (w + fw) / 2 && y >= (h - fh) / 2 && y < (h + fh) / 2;
      const c = inside ? fg : bg;
      const i = (y * w + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
  return d;
}

const alphaAt = (d: Uint8ClampedArray, w: number, x: number, y: number) =>
  d[(y * w + x) * 4 + 3];

console.log("\n── backgrounds it must key ─────────────────────────────────");

for (const [label, bg] of [
  ["magenta (the prompt's ask)", [255, 0, 255]],
  ["white (common defiance)", [255, 255, 255]],
  ["mid-grey", [128, 128, 130]],
  ["studio cream", [240, 234, 220]],
] as [string, RGB][]) {
  const d = subjectOn(bg, [60, 90, 200]);
  const out = keyImage(d, 64, 64);
  check(`${label}: keys`, out.applied);
  if (out.applied) {
    check(`  corner went transparent`, alphaAt(d, 64, 1, 1) === 0);
    check(`  subject centre survived opaque`, alphaAt(d, 64, 32, 32) === 255);
    check(
      `  bounds hug the subject`,
      out.bounds.maxX - out.bounds.minX < 34 && out.bounds.minX > 10,
      JSON.stringify(out.bounds),
    );
  }
}

{
  // The case the tight HARD threshold exists for: a grey machine on a grey
  // backdrop, separated by less than a generous threshold would allow.
  const d = subjectOn([128, 128, 130], [128 + HARD + 8, 128 + HARD + 8, 130 + HARD + 8]);
  const out = keyImage(d, 64, 64);
  check("a subject barely off the background colour still survives", out.applied);
  if (out.applied) check("  …opaque", alphaAt(d, 64, 32, 32) === 255);
}

console.log("\n── enclosed openings ───────────────────────────────────────");

{
  // A car window the model painted background-colour: enclosed by subject,
  // unreachable from the border. On MAGENTA the keyer clears it globally —
  // no real machine is magenta — which is how sprites stopped shipping with
  // magenta glass.
  const d = subjectOn([255, 0, 255], [60, 90, 200]);
  for (let y = 28; y < 36; y++) {
    for (let x = 26; x < 38; x++) {
      const i = (y * 64 + x) * 4;
      d[i] = 250;
      d[i + 1] = 20;
      d[i + 2] = 252;
    }
  }
  const out = keyImage(d, 64, 64);
  check("keys with a magenta window inside", out.applied);
  check("  the enclosed magenta went transparent", alphaAt(d, 64, 30, 30) === 0);
  check("  the body around it stayed", alphaAt(d, 64, 20, 32) === 255);
}

{
  // The same shape on a GREY backdrop with a grey patch inside: enclosed
  // near-background pixels stay, because on any non-magenta ground "looks
  // like the background" and "is the background" genuinely differ — this is
  // the grey machine with grey panels, and eating them was the original bug.
  const bg: RGB = [128, 128, 130];
  const d = subjectOn(bg, [60, 90, 200]);
  for (let y = 28; y < 36; y++) {
    for (let x = 26; x < 38; x++) {
      const i = (y * 64 + x) * 4;
      d[i] = 130;
      d[i + 1] = 128;
      d[i + 2] = 132;
    }
  }
  const out = keyImage(d, 64, 64);
  check("keys on grey with a grey panel inside", out.applied);
  check("  the enclosed grey panel SURVIVED", alphaAt(d, 64, 30, 30) === 255);
}

console.log("\n── images it must refuse ───────────────────────────────────");

{
  // A gradient backdrop — a scene, not a field. Keying would punch holes.
  const w = 64;
  const h = 64;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = Math.round((x / w) * 255);
      d[i + 1] = 80;
      d[i + 2] = Math.round((y / h) * 255);
      d[i + 3] = 255;
    }
  }
  const before = d.slice();
  const out = keyImage(d, w, h);
  check("a gradient background is refused", !out.applied && out.reason === "not-flat");
  check("  …and the pixels are untouched", d.every((v, i) => v === before[i]));
  check(
    `  the spread said so (${Math.round(out.spread)} > ${FLATNESS})`,
    out.spread > FLATNESS,
  );
}

{
  // A field of one colour with nothing on it — keying leaves nothing.
  const d = subjectOn([255, 0, 255], [255, 0, 255]);
  const before = d.slice();
  const out = keyImage(d, 64, 64);
  check(
    "an empty field is refused rather than blanked",
    !out.applied && (out.reason === "ate-everything" || out.reason === "nothing-left"),
    out.applied ? "applied!" : out.reason,
  );
  check("  …and the pixels are untouched", d.every((v, i) => v === before[i]));
}

console.log("\n── the fringe ──────────────────────────────────────────────");

{
  // A one-pixel blend ring between subject and magenta, as resampling makes.
  const w = 64;
  const h = 64;
  const d = subjectOn([255, 0, 255], [60, 90, 200], w, h);
  // Paint the subject's border pixels as a mostly-key blend — the last pixel
  // of a soft antialiased edge. (A 50/50 blend with this subject lands past
  // SOFT and is correctly treated as subject; the fringe pass exists for the
  // pixels that are nearly background but not quite.)
  for (let x = 17; x < 47; x++) {
    for (const y of [20, 43]) {
      const i = (y * w + x) * 4;
      d[i] = 0.25 * 60 + 0.75 * 255;
      d[i + 1] = 0.25 * 90 + 0.75 * 0;
      d[i + 2] = 0.25 * 200 + 0.75 * 255;
    }
  }
  const out = keyImage(d, w, h);
  check("a blended edge still keys", out.applied);
  const edge = alphaAt(d, w, 30, 20);
  check(
    "  the blend pixel faded instead of staying solid",
    edge < 255,
    `alpha ${edge}`,
  );
}

console.log(
  failures === 0
    ? "\n✓ all chroma checks passed\n"
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
