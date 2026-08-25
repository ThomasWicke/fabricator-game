// Art-pipeline eval: generate real bodies for canned specs, then measure
// what the production keyer makes of them.
//
// The compile eval says nothing about the half of the pipeline players
// actually look at. This one asks, per generated image: did the model obey
// the magenta-background instruction, did the keyer accept it, how much of
// the frame does the subject fill — and writes a CONTACT SHEET so style
// consistency can be judged by eye. That sheet is also the curation tool for
// choosing style-reference images.
//
// OPT-IN: this is the expensive script — ~10 images ≈ 0.30€ on the lite
// model. Runs only with a GOOGLE_API_KEY.
//
// Run: npx tsx scripts/eval-art.ts

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateBodySprite } from "../shared/fabricator/image";
import { clampSpec, computeCost } from "../shared/fabricator";
import type { FabricatedSpec, RawSpec } from "../shared/fabricator";
import { dist, keyImage, readKey } from "../client/src/screen/chroma-core";
import { decodePng, encodePng, makeImage, blit, type Image } from "./lib/png";

// minimal .env loader, same as the compile eval
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // no .env — rely on the environment
}

const OUT_DIR = fileURLToPath(new URL("../fixtures/art/", import.meta.url));

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

const mobile = (type: "wheels" | "tracks" | "legs" | "float") => ({
  type,
  speed: 200,
  terrainModifiers: { grass: 0.9, sand: 0.8, swamp: 0.2, rock: 0.3, snow: 0.2, water: type === "float" ? 0.9 : 0 },
});

/** One per category-and-silhouette the game actually produces. */
const SUBJECTS: FabricatedSpec[] = [
  spec({ category: "vehicle", displayName: "Dune Runner", flavor: "A quick little wheeled scout.", size: { w: 90, h: 50 }, locomotion: mobile("wheels"), seats: 1 }),
  spec({ category: "vehicle", displayName: "Bog Crawler", flavor: "Tracked, patient, unstoppable.", size: { w: 110, h: 60 }, locomotion: mobile("tracks"), seats: 1 }),
  spec({ category: "vehicle", displayName: "Reed Skiff", flavor: "A flat-bottomed river boat.", size: { w: 120, h: 50 }, locomotion: mobile("float"), seats: 2 }),
  spec({ category: "structure", displayName: "Stone Hut", flavor: "Four walls against the night.", size: { w: 100, h: 90 } }),
  spec({ category: "structure", displayName: "Glass Kiln", flavor: "Runs hot and smells of the desert.", size: { w: 90, h: 100 }, emission: { kind: "smoke", intensity: 0.6 } }),
  spec({ category: "structure", displayName: "Signal Pylon", flavor: "A light that says: someone lives here.", size: { w: 50, h: 130 }, emission: { kind: "light", intensity: 0.9 } }),
  spec({ category: "tool", displayName: "Timber Axe", flavor: "Bites deep, asks nothing.", size: { w: 36, h: 30 }, harvest: { rate: 2, materials: ["wood"] } }),
  spec({ category: "tool", displayName: "Rime Drill", flavor: "Chews frost like biscuit.", size: { w: 40, h: 30 }, harvest: { rate: 1.5, materials: ["rime"] } }),
  spec({ category: "tool", displayName: "Iron Spear", flavor: "Reach, and the sense to use it.", size: { w: 40, h: 26 }, weapon: { damage: 14, reach: 110, cooldown: 0.8 } }),
];

const CELL = 200;
const LABEL_H = 14;

/** Nearest-neighbour fit into a cell, centred. */
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

async function main() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("eval-art needs GOOGLE_API_KEY — it generates real images.");
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  type Row = {
    name: string;
    ms: number;
    magenta: boolean;
    keyed: string;
    spread: number;
    removed: number;
    fill: number;
  };
  const rows: Row[] = [];
  const cells: { img: Image; label: string }[] = [];

  for (const s of SUBJECTS) {
    const t0 = Date.now();
    try {
      const sprite = await generateBodySprite(s, {}, apiKey);
      const ms = Date.now() - t0;
      const b64 = sprite.dataUrl.split(",")[1];
      const img = decodePng(Buffer.from(b64, "base64"));
      writeFileSync(join(OUT_DIR, `${s.displayName.toLowerCase().replace(/\W+/g, "-")}.png`), Buffer.from(b64, "base64"));

      // Did the model obey the magenta instruction? Learn the background the
      // same way the keyer does, before keying mutates the pixels.
      const { key } = readKey(img.data, img.width, img.height);
      const magenta = dist(key[0], key[1], key[2], [255, 0, 255]) < 60;
      // Then measure with the REAL keyer.
      const outcome = keyImage(img.data, img.width, img.height);
      const fill = outcome.applied
        ? ((outcome.bounds.maxX - outcome.bounds.minX) * (outcome.bounds.maxY - outcome.bounds.minY)) /
          (img.width * img.height)
        : 0;
      rows.push({
        name: s.displayName,
        ms,
        magenta,
        keyed: outcome.applied ? "keyed" : outcome.reason,
        spread: Math.round(outcome.spread),
        removed: outcome.applied ? Math.round(outcome.removedFraction * 100) : 0,
        fill: Math.round(fill * 100),
      });
      cells.push({ img: fit(img, CELL), label: s.displayName });
      console.log(
        `${outcome.applied ? "✓" : "✗"} ${s.displayName.padEnd(14)} ${String(ms).padStart(5)}ms ` +
          `${magenta ? "magenta" : "OFF-SPEC bg"} spread=${Math.round(outcome.spread)} ` +
          (outcome.applied
            ? `removed=${Math.round(outcome.removedFraction * 100)}% fill=${Math.round(fill * 100)}%`
            : `REFUSED: ${outcome.reason}`),
      );
    } catch (err) {
      rows.push({ name: s.displayName, ms: Date.now() - t0, magenta: false, keyed: "ERROR", spread: 0, removed: 0, fill: 0 });
      console.log(`✗ ${s.displayName.padEnd(14)} ERROR: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  // ── contact sheet ──
  const cols = 3;
  const rowsN = Math.ceil(cells.length / cols);
  const sheet = makeImage(cols * (CELL + 8) + 8, rowsN * (CELL + LABEL_H + 8) + 8, [34, 40, 49, 255]);
  cells.forEach((cell, i) => {
    const cx = 8 + (i % cols) * (CELL + 8);
    const cy = 8 + Math.floor(i / cols) * (CELL + LABEL_H + 8);
    blit(sheet, cell.img, cx + Math.floor((CELL - cell.img.width) / 2), cy + Math.floor((CELL - cell.img.height) / 2));
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const sheetPath = join(OUT_DIR, `contact-sheet-${stamp}.png`);
  writeFileSync(sheetPath, encodePng(sheet));
  console.log(`\ncontact sheet: ${sheetPath}`);
  const refused = rows.filter((r) => r.keyed !== "keyed").length;
  console.log(`${rows.length - refused}/${rows.length} keyed cleanly`);
  process.exit(refused > rows.length / 2 ? 1 : 0);
}

main();
