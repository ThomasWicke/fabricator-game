// How long does it take to find somewhere to land?
//
// findSpawn walks outward from the origin until it finds dry, temperate
// ground with a clear neighbourhood. It runs inside create(), synchronously,
// before a single frame is drawn — so if it is slow the game shows a black
// screen and looks hung. Run: npx tsx scripts/bench-spawn.ts

import { biomeAt, findSpawn, worldSeed } from "../client/src/screen/worldgen";

const SEEDS = [
  "FABR", "SOLO", "SURV", "MOBI", "XKCD", "room-7",
  "ABCD", "ZZZZ", "QQQQ", "TEST", "AAAA", "9999",
];

let worst = 0;
let worstSeed = "";
for (const str of SEEDS) {
  const seed = worldSeed(str);
  const t0 = performance.now();
  const s = findSpawn(seed);
  const ms = performance.now() - t0;
  const ring = Math.max(Math.abs(s.col), Math.abs(s.row));
  if (ms > worst) {
    worst = ms;
    worstSeed = str;
  }
  console.log(
    `  ${str.padEnd(8)} (${String(s.col).padStart(4)},${String(s.row).padStart(4)})` +
      `  ring ${String(ring).padStart(3)}  ${ms.toFixed(1).padStart(7)}ms  ${biomeAt(s.col, s.row, seed)}`,
  );
}
console.log(`\n  worst: ${worstSeed} at ${worst.toFixed(1)}ms`);
// A spawn search that takes longer than a frame or two is a black screen the
// player reads as a crash.
process.exit(worst < 150 ? 0 : 1);
