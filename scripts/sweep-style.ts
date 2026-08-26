// Where did the pixel-art style go?
//
// cfg went 1.0 -> 1.6 to wake the negative prompt up, and that bought real
// things: the sprite-SHEET failure disappeared, because every anti-collage
// term had been inert at cfg 1.0. It also cost something — higher guidance
// follows the prompt more literally and dilutes the LoRA, and the twenty-item
// showcase came back more illustrative and less chunky than the earlier run.
//
// Guidance and LoRA strength pull against each other, so tuning either alone
// is guesswork. This walks the grid on fixed subjects and FIXED SEEDS, so the
// only differences on the sheet are the two variables.
//
// Reading the sheet: each block is one subject; rows are cfg, columns are
// LoRA strength. Style should get flatter and chunkier to the right and to
// the top; single-object reliability should improve downward.
//
// OPT-IN and free — needs LOCAL_IMAGE_URL (the ComfyUI server).
// Run: npx tsx scripts/sweep-style.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateBodySpriteLocal } from "../shared/fabricator/image-local";
import { clampSpec, computeCost } from "../shared/fabricator";
import type { FabricatedSpec, RawSpec } from "../shared/fabricator";
import { alphaMask, isFramedScene, measureUnity } from "../shared/fabricator/sprite-check";
import { keyImage } from "../client/src/screen/chroma-core";
import { decodeImage, encodePng, makeImage, type Image } from "./lib/png";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // no .env — rely on the environment
}

const OUT_DIR = fileURLToPath(new URL("../fixtures/art-local/sweep/", import.meta.url));

const CFGS = [1.0, 1.3, 1.6];
const LORAS = [0.9, 1.1];
/** One seed per subject, shared by every cell, so a cell differs from its
 *  neighbour by the axis and nothing else. */
const SEEDS = [11111, 22222, 33333, 44444];

const spec = (over: Partial<RawSpec>): FabricatedSpec => {
  const clamped = clampSpec({
    category: "structure",
    displayName: "x",
    size: { w: 80, h: 60 },
    locomotion: {
      type: "none",
      speed: 0,
      terrainModifiers: { grass: 0, sand: 0, swamp: 0, rock: 0, snow: 0, water: 0 },
    },
    seats: 0,
    flavor: "",
    ...over,
  } as RawSpec);
  return { ...clamped, cost: computeCost(clamped) };
};

/** Four subjects that between them exercise every failure the two axes
 *  trade against: the buggy was the sprite-SHEET case at cfg 1.0, the
 *  greenhouse and steamer are where the style drift is most visible, and the
 *  axe is a thin tool where over-styling shows first. */
const SUBJECTS: FabricatedSpec[] = [
  spec({
    category: "vehicle",
    displayName: "Dune Runner",
    flavor: "A quick little wheeled scout.",
    size: { w: 90, h: 50 },
    locomotion: {
      type: "wheels",
      speed: 230,
      terrainModifiers: { grass: 0.9, sand: 0.8, swamp: 0.3, rock: 0.4, snow: 0.3, water: 0 },
    },
    seats: 1,
  }),
  spec({
    category: "vehicle",
    displayName: "Paddle Steamer",
    flavor: "A tall stack and a lazy wake.",
    size: { w: 130, h: 90 },
    locomotion: {
      type: "float",
      speed: 130,
      terrainModifiers: { grass: 0.2, sand: 0.2, swamp: 0.8, rock: 0.1, snow: 0.1, water: 0.9 },
    },
    seats: 2,
  }),
  spec({ category: "structure", displayName: "Greenhouse", flavor: "Warm glass over stubborn green things.", size: { w: 120, h: 80 } }),
  spec({ category: "tool", displayName: "Timber Axe", flavor: "Bites deep, asks nothing.", size: { w: 36, h: 30 }, harvest: { rate: 2, materials: ["wood"] } }),
];

const CELL = 240;
const GROUND: [number, number, number, number] = [38, 44, 56, 255];
const GAP = 10;

function fit(img: Image, max: number): Image {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
      out.data.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return out;
}

function blend(dst: Image, src: Image, ox: number, oy: number) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      const a = src.data[s + 3] / 255;
      if (a === 0) continue;
      const d = ((oy + y) * dst.width + (ox + x)) * 4;
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round(src.data[s + c] * a + dst.data[d + c] * (1 - a));
      }
    }
  }
}

async function main() {
  const baseUrl = process.env.LOCAL_IMAGE_URL;
  if (!baseUrl) {
    console.error("sweep-style needs LOCAL_IMAGE_URL (the ComfyUI server).");
    process.exit(1);
  }
  const endpoint = { baseUrl, token: process.env.LOCAL_AI_TOKEN ?? "" };
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`cfg ${CFGS.join("/")} x lora ${LORAS.join("/")} on ${SUBJECTS.length} subjects, ` +
    `${CFGS.length * LORAS.length * SUBJECTS.length} generations\n`);

  // One block per subject: rows = cfg, cols = lora.
  const blockW = LORAS.length * (CELL + GAP) + GAP;
  const blockH = CFGS.length * (CELL + GAP) + GAP;
  const sheet = makeImage(SUBJECTS.length * blockW, blockH, GROUND);

  for (let si = 0; si < SUBJECTS.length; si++) {
    const s = SUBJECTS[si];
    const slug = s.displayName.toLowerCase().replace(/\W+/g, "-");
    for (let ci = 0; ci < CFGS.length; ci++) {
      for (let li = 0; li < LORAS.length; li++) {
        const cfg = CFGS[ci];
        const loraStrength = LORAS[li];
        const t0 = Date.now();
        try {
          const sprite = await generateBodySpriteLocal(s, {}, endpoint, {
            cfg,
            loraStrength,
            // Pinned seed => one attempt, so a cell shows the setting rather
            // than the retry loop's best-of-three.
            seed: SEEDS[si],
          });
          const bytes = Buffer.from(sprite.dataUrl.split(",")[1], "base64");
          const img = decodeImage(bytes);
          writeFileSync(join(OUT_DIR, `${slug}-cfg${cfg}-lora${loraStrength}.png`), bytes);
          const out = keyImage(img.data, img.width, img.height);
          const m = measureUnity(alphaMask(img.data, img.width, img.height), img.width, img.height);
          blend(
            sheet,
            fit(img, CELL - 16),
            si * blockW + GAP + li * (CELL + GAP) + 8,
            GAP + ci * (CELL + GAP) + 8,
          );
          console.log(
            `${s.displayName.padEnd(15)} cfg=${cfg} lora=${loraStrength} ` +
              `${String(Date.now() - t0).padStart(6)}ms ${out.applied ? "keyed  " : `REFUSED(${out.reason})`} ` +
              `unity=${m.unity.toFixed(2)} solidity=${m.solidity.toFixed(2)}` +
              (isFramedScene(m) ? " FRAMED-SCENE" : ""),
          );
        } catch (err) {
          console.log(`${s.displayName.padEnd(15)} cfg=${cfg} lora=${loraStrength} ERROR: ${(err as Error).message.slice(0, 80)}`);
        }
      }
    }
  }

  const path = join(OUT_DIR, "sweep.png");
  writeFileSync(path, encodePng(sheet));
  console.log(`\nsheet: ${path}`);
  console.log(`blocks left-to-right: ${SUBJECTS.map((s) => s.displayName).join(" · ")}`);
  console.log(`within each block: rows = cfg ${CFGS.join("/")} (top to bottom), cols = lora ${LORAS.join("/")} (left to right)`);
}

main();
