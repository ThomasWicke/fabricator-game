// The sketch-to-silhouette fill, against drawings shaped like the ones
// players actually make.
//
// The bug this guards: strokes went to the sampler as strokes, and img2img
// returned strokes — hollow wireframe bodies. Every check below is really
// one question: after this runs, is the INSIDE of the drawing filled?
//
// Run: npx tsx scripts/test-silhouette.ts

import { fillSilhouette, silhouetteFromPngBase64 } from "../shared/fabricator/silhouette";
import { encodePngRgba } from "../shared/fabricator/png-encode";
import { decodePngRgba } from "../shared/fabricator/png-decode";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const W = 200;
const H = 160;
const STROKE: [number, number, number] = [0x1c, 0x23, 0x2e]; // client/src/sketch.ts

/** A transparent canvas, exactly what cropInkToDataUrl exports. */
const blank = () => new Uint8Array(W * H * 4);

function dot(d: Uint8Array, x: number, y: number, r = 3) {
  for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
      const i = (yy * W + xx) * 4;
      d[i] = STROKE[0];
      d[i + 1] = STROKE[1];
      d[i + 2] = STROKE[2];
      d[i + 3] = 255;
    }
  }
}

function line(d: Uint8Array, x0: number, y0: number, x1: number, y1: number, r = 3) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= steps; s++) {
    dot(d, Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps), r);
  }
}

const at = (rgba: Uint8Array, x: number, y: number): [number, number, number] => [
  rgba[(y * W + x) * 4],
  rgba[(y * W + x) * 4 + 1],
  rgba[(y * W + x) * 4 + 2],
];
const isGround = (c: number[]) => c[0] > 240 && c[1] > 240 && c[2] > 240;
const isBody = (c: number[]) => c[0] > 100 && c[0] < 200 && !isGround(c);

console.log("\n── a closed outline: the common case ───────────────────────");
{
  // The boat hull a player draws: one closed loop, nothing inside it.
  const d = blank();
  line(d, 40, 40, 160, 40);
  line(d, 160, 40, 160, 120);
  line(d, 160, 120, 40, 120);
  line(d, 40, 120, 40, 40);
  const r = fillSilhouette(d, W, H);
  check("has ink", r.inked);
  check("was filled, not thickened", !r.thickened);
  check("the interior became body", isBody(at(r.rgba, 100, 80)), at(r.rgba, 100, 80).join(","));
  check("outside stayed ground", isGround(at(r.rgba, 5, 5)), at(r.rgba, 5, 5).join(","));
  check(`solidity is high (${r.solidity.toFixed(2)})`, r.solidity > 0.85);
}

console.log("\n── a closed outline with a gap, as fingers draw ────────────");
{
  // Same hull, but the right wall stops 10px short — a lifted finger. Without
  // stroke-closing the flood leaks straight in and nothing gets filled.
  const d = blank();
  line(d, 40, 40, 160, 40);
  line(d, 160, 40, 160, 75);
  line(d, 160, 85, 160, 120);
  line(d, 160, 120, 40, 120);
  line(d, 40, 120, 40, 40);
  const r = fillSilhouette(d, W, H);
  check("the gap did not defeat the fill", isBody(at(r.rgba, 100, 80)), at(r.rgba, 100, 80).join(","));
  check(`solidity is high (${r.solidity.toFixed(2)})`, r.solidity > 0.85);
  check("still counts as filled, not thickened", !r.thickened);
}

console.log("\n── an open scribble: no interior to find ───────────────────");
{
  // A mast on a deck: strokes that meet but never close a loop. Filling
  // finds no enclosed region, so they must be fattened into a mass instead —
  // shipping them as drawn is the wireframe bug all over again.
  const d = blank();
  line(d, 40, 120, 160, 120);
  line(d, 100, 120, 100, 50);
  line(d, 100, 50, 150, 70);
  const r = fillSilhouette(d, W, H);
  check("has ink", r.inked);
  check("was recognised as open line-work", r.thickened);
  check(`the mass is substantial (${r.solidity.toFixed(2)})`, r.solidity > 0.3, `solidity ${r.solidity.toFixed(2)}`);
  // The point of thickening: a spot well clear of any stroke is now body.
  check("the space beside a stroke became body", isBody(at(r.rgba, 112, 90)), at(r.rgba, 112, 90).join(","));
}

console.log("\n── the strokes survive as interior detail ──────────────────");
{
  const d = blank();
  line(d, 40, 40, 160, 40);
  line(d, 160, 40, 160, 120);
  line(d, 160, 120, 40, 120);
  line(d, 40, 120, 40, 40);
  line(d, 100, 40, 100, 120); // a divider the player drew inside
  const r = fillSilhouette(d, W, H);
  const onStroke = at(r.rgba, 100, 80);
  const offStroke = at(r.rgba, 130, 80);
  check("the interior stroke is darker than the body around it", onStroke[0] < offStroke[0], `${onStroke[0]} vs ${offStroke[0]}`);
  check("…and the body beside it is still filled", isBody(offStroke));
}

console.log("\n── a flattened sketch: dark lines on opaque white ──────────");
{
  // No alpha to read, so ink has to be found by luminance instead.
  const d = blank();
  for (let i = 0; i < W * H; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
    d[i * 4 + 3] = 255;
  }
  line(d, 40, 40, 160, 40);
  line(d, 160, 40, 160, 120);
  line(d, 160, 120, 40, 120);
  line(d, 40, 120, 40, 40);
  const r = fillSilhouette(d, W, H);
  check("ink was found without alpha", r.inked);
  check("the interior became body", isBody(at(r.rgba, 100, 80)), at(r.rgba, 100, 80).join(","));
}

console.log("\n── nothing drawn ──────────────────────────────────────────");
{
  const r = fillSilhouette(blank(), W, H);
  check("reports no ink rather than inventing a shape", !r.inked);
  check("solidity is zero", r.solidity === 0);
}

console.log("\n── PNG round trip ─────────────────────────────────────────");
await (async () => {
  const d = blank();
  line(d, 40, 40, 160, 40);
  line(d, 160, 40, 160, 120);
  line(d, 160, 120, 40, 120);
  line(d, 40, 120, 40, 40);
  const png = await encodePngRgba(W, H, d);
  const back = await decodePngRgba(png);
  check("encode → decode preserves size", back.width === W && back.height === H);
  check(
    "encode → decode preserves pixels",
    back.rgba.every((v, i) => v === d[i]),
  );

  let bin = "";
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  const filled = await silhouetteFromPngBase64(btoa(bin));
  check("the base64 wrapper filled the shape", !!filled && filled.solidity > 0.85, filled ? `solidity ${filled.solidity.toFixed(2)}` : "null");
  // And what comes back has to be readable by the decoder the graph feeds.
  const reread = await decodePngRgba(
    Uint8Array.from(atob(filled!.base64), (c) => c.charCodeAt(0)),
  );
  check("the returned PNG decodes", reread.width === W && reread.height === H);
  check("…and its interior is filled", isBody(at(reread.rgba, 100, 80)), at(reread.rgba, 100, 80).join(","));
})();

console.log(
  failures === 0 ? "\n✓ all silhouette checks passed\n" : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
