// Twenty subjects through the production art path, laid out for a human to
// judge. Not a pass/fail eval — the question it answers is "does this look
// like one game?", which no metric decides.
//
// Everything runs on production defaults: same prompt builder, same cfg,
// same LoRA, same retry rules a player's fabrication gets. The only thing
// supplied here is the subject list. Sprites are keyed with the REAL client
// keyer and composited on the game's own ground, so the sheet shows what
// ends up on screen rather than what came off the sampler.
//
// OPT-IN and free — needs LOCAL_IMAGE_URL (the ComfyUI server).
// Run: npx tsx scripts/showcase-art.ts
//      npx tsx scripts/showcase-art.ts --seed 7   ← reproducible run

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateBodySpriteLocal, MIN_SOLIDITY } from "../shared/fabricator/image-local";
import { clampSpec, computeCost } from "../shared/fabricator";
import type { FabricatedSpec, RawSpec } from "../shared/fabricator";
import { keyImage } from "../client/src/screen/chroma-core";
import { isFramedScene, alphaMask, measureUnity } from "../shared/fabricator/sprite-check";
import { decodeImage, encodePng, makeImage, type Image } from "./lib/png";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // no .env — rely on the environment
}

const OUT_DIR = fileURLToPath(new URL("../fixtures/art-local/showcase-20/", import.meta.url));

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
const moves = (type: "wheels" | "tracks" | "legs" | "float", speed = 190) => ({
  type,
  speed,
  terrainModifiers: {
    grass: 0.9, sand: 0.8, swamp: 0.3, rock: 0.4, snow: 0.3,
    water: type === "float" ? 0.9 : 0,
  },
});

/** Spread across category, silhouette and aspect — a style that only holds
 *  for wheeled boxes is not a style. */
const SUBJECTS: FabricatedSpec[] = [
  spec({ category: "vehicle", displayName: "Dune Runner", flavor: "A quick little wheeled scout.", size: { w: 90, h: 50 }, locomotion: moves("wheels", 230), seats: 1 }),
  spec({ category: "vehicle", displayName: "Bog Crawler", flavor: "Tracked, patient, unstoppable.", size: { w: 110, h: 60 }, locomotion: moves("tracks", 120), seats: 1 }),
  spec({ category: "vehicle", displayName: "Reed Skiff", flavor: "A flat-bottomed river boat.", size: { w: 120, h: 46 }, locomotion: moves("float", 150), seats: 2 }),
  spec({ category: "vehicle", displayName: "Spider Walker", flavor: "Six legs, no hurry, no obstacles.", size: { w: 90, h: 80 }, locomotion: moves("legs", 110), seats: 1 }),
  spec({ category: "vehicle", displayName: "Ore Hauler", flavor: "A tipping bed and nothing to spare.", size: { w: 140, h: 70 }, locomotion: moves("wheels", 100), seats: 1 }),
  spec({ category: "vehicle", displayName: "Snow Sledge", flavor: "Runs on rails of polished bone.", size: { w: 110, h: 44 }, locomotion: moves("float", 200), seats: 2 }),
  spec({ category: "vehicle", displayName: "Paddle Steamer", flavor: "A tall stack and a lazy wake.", size: { w: 130, h: 90 }, locomotion: moves("float", 130), seats: 2 }),

  spec({ category: "structure", displayName: "Stone Hut", flavor: "Four walls against the night.", size: { w: 100, h: 90 } }),
  spec({ category: "structure", displayName: "Glass Kiln", flavor: "Runs hot and smells of the desert.", size: { w: 90, h: 100 }, emission: { kind: "smoke", intensity: 0.6 } }),
  spec({ category: "structure", displayName: "Signal Pylon", flavor: "A light that says: someone lives here.", size: { w: 50, h: 130 }, emission: { kind: "light", intensity: 0.9 } }),
  spec({ category: "structure", displayName: "Windmill", flavor: "Four sails turning over a stone base.", size: { w: 90, h: 140 } }),
  spec({ category: "structure", displayName: "Greenhouse", flavor: "Warm glass over stubborn green things.", size: { w: 120, h: 80 } }),
  spec({ category: "structure", displayName: "Watchtower", flavor: "High enough to see trouble coming.", size: { w: 60, h: 150 } }),
  spec({ category: "structure", displayName: "Iron Smelter", flavor: "It eats bogiron and breathes soot.", size: { w: 110, h: 110 }, emission: { kind: "smoke", intensity: 0.8 } }),
  spec({ category: "structure", displayName: "Rain Cistern", flavor: "A squat drum, always half full.", size: { w: 90, h: 70 } }),

  spec({ category: "tool", displayName: "Timber Axe", flavor: "Bites deep, asks nothing.", size: { w: 36, h: 30 }, harvest: { rate: 2, materials: ["wood"] } }),
  spec({ category: "tool", displayName: "Rime Drill", flavor: "Chews frost like biscuit.", size: { w: 40, h: 30 }, harvest: { rate: 1.5, materials: ["rime"] } }),
  spec({ category: "tool", displayName: "Iron Spear", flavor: "Reach, and the sense to use it.", size: { w: 40, h: 26 }, weapon: { damage: 14, reach: 110, cooldown: 0.8 } }),
  spec({ category: "tool", displayName: "Prospector Pick", flavor: "For rock that keeps secrets.", size: { w: 34, h: 32 }, harvest: { rate: 1.6, materials: ["stone", "basalt"] } }),
  spec({ category: "tool", displayName: "Storm Lantern", flavor: "Small flame, stubborn about it.", size: { w: 26, h: 36 }, emission: { kind: "light", intensity: 0.7 } }),
];

const CELL = 300;
const COLS = 4;
/** The game's own ground, so the sheet judges sprites in context. */
const GROUND: [number, number, number, number] = [38, 44, 56, 255];

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

/** Alpha-composite onto the sheet, which plain blit does not do. */
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
    console.error("showcase-art needs LOCAL_IMAGE_URL (the ComfyUI server).");
    process.exit(1);
  }
  const endpoint = { baseUrl, token: process.env.LOCAL_AI_TOKEN ?? "" };
  const seedArg = process.argv.indexOf("--seed");
  const baseSeed = seedArg > 0 ? Number(process.argv[seedArg + 1]) : undefined;
  mkdirSync(OUT_DIR, { recursive: true });

  const cells: (Image | null)[] = [];
  let refused = 0;
  let thin = 0;

  for (let i = 0; i < SUBJECTS.length; i++) {
    const s = SUBJECTS[i];
    const t0 = Date.now();
    const slug = s.displayName.toLowerCase().replace(/\W+/g, "-");
    try {
      const sprite = await generateBodySpriteLocal(s, {}, endpoint, {
        // Vary per subject so a pinned run still gets twenty different rolls.
        ...(baseSeed !== undefined ? { seed: baseSeed + i * 1013 } : {}),
      });
      const raw = Buffer.from(sprite.dataUrl.split(",")[1], "base64");
      const img = decodeImage(raw);
      writeFileSync(join(OUT_DIR, `${String(i + 1).padStart(2, "0")}-${slug}.png`), raw);

      // The production keyer, then measured on its own alpha.
      const out = keyImage(img.data, img.width, img.height);
      const m = measureUnity(alphaMask(img.data, img.width, img.height), img.width, img.height);
      if (!out.applied) refused++;
      if (m.solidity < MIN_SOLIDITY) thin++;
      cells.push(fit(img, CELL - 24));
      console.log(
        `${String(i + 1).padStart(2)} ${s.displayName.padEnd(16)} ${s.category.padEnd(9)} ` +
          `${String(Date.now() - t0).padStart(6)}ms  ${out.applied ? "keyed  " : `REFUSED(${out.reason})`} ` +
          `unity=${m.unity.toFixed(2)} solidity=${m.solidity.toFixed(2)}` +
          (isFramedScene(m) ? " FRAMED-SCENE" : ""),
      );
    } catch (err) {
      cells.push(null);
      console.log(`${String(i + 1).padStart(2)} ${s.displayName.padEnd(16)} ERROR: ${(err as Error).message.slice(0, 90)}`);
    }
  }

  const rows = Math.ceil(cells.length / COLS);
  const sheet = makeImage(COLS * CELL + 16, rows * CELL + 16, GROUND);
  cells.forEach((cell, i) => {
    if (!cell) return;
    const cx = 8 + (i % COLS) * CELL;
    const cy = 8 + Math.floor(i / COLS) * CELL;
    blend(sheet, cell, cx + ((CELL - cell.width) >> 1), cy + ((CELL - cell.height) >> 1));
  });
  const path = join(OUT_DIR, "showcase.png");
  writeFileSync(path, encodePng(sheet));
  console.log(`\n${cells.filter(Boolean).length}/${SUBJECTS.length} generated · ${refused} keyer refusals · ${thin} below the solidity bar`);
  console.log(`sheet: ${path}`);
}

main();
