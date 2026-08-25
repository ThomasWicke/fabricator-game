// Chunk coverage, proven instead of reasoned about.
//
// Terrain is streamed as chunk-sized RenderTextures, each drawing its own
// hexes plus a bleed margin, clipped to its own rectangle. The design's one
// promise is: EVERY pixel of every tile is inside some chunk that draws that
// tile. The bleed margins were justified by a comment, the comment predated
// raised ground, and nobody re-derived it when relief went negative — so
// every raised tile in a chunk's first row lost its top edge, a line of
// notches along every horizontal chunk boundary in high country. This file
// re-derives it on every test run, against the drops real worlds produce.
//
// Run: npx tsx scripts/test-chunks.ts

import {
  CHUNK_COLS,
  CHUNK_H,
  CHUNK_ROWS,
  CHUNK_W,
  HEX_IMG_H,
  HEX_W,
  hexImageTopLeft,
} from "../client/src/screen/hexgrid";
import { tileAt, worldSeed } from "../client/src/screen/worldgen";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

// The draw loop from chunks.ts build(), as ranges. If chunks.ts changes its
// margins these must change with it — and the coverage assertions below say
// whether the new margins are sufficient, which is the entire point.
const drawsRow = (cy: number, row: number) =>
  row >= cy * CHUNK_ROWS - 2 && row < cy * CHUNK_ROWS + CHUNK_ROWS + 1;
const drawsCol = (cx: number, col: number) =>
  col >= cx * CHUNK_COLS - 1 && col < cx * CHUNK_COLS + CHUNK_COLS;

console.log("\n── the drops real worlds actually produce ──────────────────");

const drops = new Set<number>();
for (const seedStr of ["FABR", "GRID", "THOM", "amber-glade"]) {
  const seed = worldSeed(seedStr);
  for (let row = -120; row <= 120; row += 1) {
    for (let col = -120; col <= 120; col += 3) {
      drops.add(tileAt(col, row, seed).drop);
    }
  }
}
const sorted = [...drops].sort((a, b) => a - b);
console.log(`  observed drops: ${sorted.join(", ")}`);
check("raised ground exists (negative drop — the case the comment missed)", sorted[0] < 0);

console.log("\n── every tile pixel belongs to a chunk that draws it ───────");

{
  let worstTop = 0;
  let worstBottom = 0;
  let vOk = true;
  // Rows around a horizontal boundary, both parities, every observed drop.
  for (const drop of sorted) {
    for (let row = -26; row <= 26; row++) {
      const tl = hexImageTopLeft(0, row);
      const top = tl.y + drop;
      const bottom = top + HEX_IMG_H;
      // Union of vertical spans of chunks whose loop includes this row.
      for (let y = Math.floor(top); y < bottom; y++) {
        const covered = [-3, -2, -1, 0, 1, 2, 3].some(
          (cy) => drawsRow(cy, row) && y >= cy * CHUNK_H && y < (cy + 1) * CHUNK_H,
        );
        if (!covered) {
          vOk = false;
          if (y < tl.y) worstTop = Math.max(worstTop, tl.y - y);
          else worstBottom = Math.max(worstBottom, y - tl.y);
          if (worstTop + worstBottom < 40) continue; // keep scanning, cap noise
        }
      }
    }
  }
  check(
    "vertically: no tile pixel is orphaned at any drop",
    vOk,
    vOk ? "" : `uncovered pixels near tile top ${worstTop}px / bottom ${worstBottom}px`,
  );
}

{
  // Horizontally: both row parities (odd rows are offset half a tile).
  let hOk = true;
  for (let row = 0; row <= 1; row++) {
    for (let col = -25; col <= 25; col++) {
      const tl = hexImageTopLeft(col, row);
      for (let x = Math.floor(tl.x); x < tl.x + HEX_W; x++) {
        const covered = [-4, -3, -2, -1, 0, 1, 2, 3].some(
          (cx) => drawsCol(cx, col) && x >= cx * CHUNK_W && x < (cx + 1) * CHUNK_W,
        );
        if (!covered) hOk = false;
      }
    }
  }
  check("horizontally: no tile pixel is orphaned in either parity", hOk);
}

console.log("\n── the same tile lands on the same pixel in every chunk ────");

{
  // Chunks round stamp positions relative to their own origin. Rounding
  // commutes with whole-chunk offsets only because the offsets are integers
  // — this pins that, so a future fractional chunk size cannot silently
  // shear tiles at the boundary.
  let ok = true;
  for (let row = -3; row <= 3; row++) {
    for (let col = -12; col <= 12; col++) {
      const tl = hexImageTopLeft(col, row);
      const stamps = new Set<number>();
      for (let cx = -3; cx <= 3; cx++) {
        if (!drawsCol(cx, col)) continue;
        stamps.add(cx * CHUNK_W + Math.round(tl.x - cx * CHUNK_W));
      }
      if (stamps.size > 1) ok = false;
    }
  }
  check("every chunk that draws a tile agrees on its world x", ok);
}

console.log(
  failures === 0
    ? "\n✓ all chunk-coverage checks passed\n"
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
