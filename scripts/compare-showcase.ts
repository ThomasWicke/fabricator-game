// Old pipeline vs new, on the SAME subjects.
//
// "The recent assets don't feel like the earlier ones" is a claim about
// drift, and drift is only visible side by side. The earlier sheet was
// generated before cfg went to 1.6 and before the prompt stopped asking for
// a bold outline; these are the subjects both runs happen to share.
//
// Run: npx tsx scripts/compare-showcase.ts <oldDir> <newDir> <outFile>

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeImage, encodePng, makeImage, type Image } from "./lib/png";

const [oldDir, newDir, outFile] = process.argv.slice(2);
const PAIRS = ["spider-walker", "snow-sledge", "windmill", "paddle-steamer", "greenhouse"];
const CELL = 300;
const GROUND: [number, number, number, number] = [38, 44, 56, 255];

function fit(img: Image, max: number): Image {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
      out.data.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  return out;
}
function blend(dst: Image, src: Image, ox: number, oy: number) {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      const a = src.data[s + 3] / 255;
      if (a === 0) continue;
      const d = ((oy + y) * dst.width + (ox + x)) * 4;
      for (let c = 0; c < 3; c++) dst.data[d + c] = Math.round(src.data[s + c] * a + dst.data[d + c] * (1 - a));
    }
}

const newFiles = readdirSync(newDir);
const sheet = makeImage(PAIRS.length * CELL + 16, 2 * CELL + 16, GROUND);
PAIRS.forEach((slug, i) => {
  const oldPath = join(oldDir, `${slug}.png`);
  const newName = newFiles.find((f) => f.endsWith(`-${slug}.png`));
  for (const [row, path] of [[0, oldPath], [1, newName ? join(newDir, newName) : ""]] as [number, string][]) {
    if (!path || !existsSync(path)) { console.log(`missing: ${slug} row ${row}`); continue; }
    const img = fit(decodeImage(readFileSync(path)), CELL - 24);
    blend(sheet, img, 8 + i * CELL + ((CELL - img.width) >> 1), 8 + row * CELL + ((CELL - img.height) >> 1));
  }
});
writeFileSync(outFile, encodePng(sheet));
console.log(`${outFile}\ntop row = earlier pipeline, bottom row = current\norder: ${PAIRS.join(" · ")}`);
