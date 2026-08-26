// Did filling the sketch actually stop the hollow bodies?
//
// Thomas reported two fabrications on 2026-08-26 that came back as
// wireframes — outlines with nothing inside. The cause was upstream of the
// model: the sketch reached the sampler as strokes on black at denoise 0.7,
// and img2img returned strokes. This runs both arms against the same seed and
// the same drawing, so the only thing that differs is the fix.
//
// OPT-IN and free — needs LOCAL_IMAGE_URL (the ComfyUI server).
// Run: npx tsx scripts/eval-silhouette.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateBodySpriteLocal, MIN_SOLIDITY } from "../shared/fabricator/image-local";
import { fillSilhouette } from "../shared/fabricator/silhouette";
import { encodePngRgba } from "../shared/fabricator/png-encode";
import { clampSpec, computeCost } from "../shared/fabricator";
import type { FabricatedSpec, RawSpec } from "../shared/fabricator";
import { magentaMask, measureUnity } from "../shared/fabricator/sprite-check";
import { decodeImage, encodePng, makeImage, blit, type Image } from "./lib/png";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // no .env — rely on the environment
}

const OUT_DIR = fileURLToPath(new URL("../fixtures/art-local/silhouette/", import.meta.url));

// ── synthetic sketches, drawn the way the pad exports them ──
const SW = 240;
const SH = 180;
const STROKE: [number, number, number] = [0x1c, 0x23, 0x2e];

function pad(): Uint8Array {
  return new Uint8Array(SW * SH * 4);
}
function stroke(d: Uint8Array, pts: [number, number][], r = 3) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) {
      const cx = Math.round(x0 + ((x1 - x0) * s) / steps);
      const cy = Math.round(y0 + ((y1 - y0) * s) / steps);
      for (let yy = Math.max(0, cy - r); yy <= Math.min(SH - 1, cy + r); yy++) {
        for (let xx = Math.max(0, cx - r); xx <= Math.min(SW - 1, cx + r); xx++) {
          const p = (yy * SW + xx) * 4;
          d[p] = STROKE[0];
          d[p + 1] = STROKE[1];
          d[p + 2] = STROKE[2];
          d[p + 3] = 255;
        }
      }
    }
  }
}

/** A boat hull, drawn as one closed outline — the shape that came back hollow. */
function hullSketch(): Uint8Array {
  const d = pad();
  stroke(d, [[30, 70], [210, 70], [180, 130], [60, 130], [30, 70]]);
  stroke(d, [[110, 70], [110, 25]]); // a mast
  return d;
}
/** A wheeled buggy, drawn as an open scribble — no enclosed region at all. */
function buggySketch(): Uint8Array {
  const d = pad();
  stroke(d, [[40, 110], [200, 110]]);
  stroke(d, [[70, 110], [95, 60], [160, 60], [185, 110]]);
  stroke(d, [[70, 130], [70, 110]]);
  stroke(d, [[175, 130], [175, 110]]);
  return d;
}

const spec = (over: Partial<RawSpec>): FabricatedSpec => {
  const clamped = clampSpec({
    category: "vehicle",
    displayName: "x",
    size: { w: 110, h: 60 },
    locomotion: {
      type: "wheels",
      speed: 180,
      terrainModifiers: { grass: 0.9, sand: 0.8, swamp: 0.2, rock: 0.3, snow: 0.2, water: 0 },
    },
    seats: 1,
    flavor: "",
    ...over,
  } as RawSpec);
  return { ...clamped, cost: computeCost(clamped) };
};

const SUBJECTS = [
  {
    name: "Reed Skiff",
    sketch: hullSketch,
    spec: spec({
      displayName: "Reed Skiff",
      flavor: "A flat-bottomed river boat.",
      size: { w: 120, h: 50 },
      locomotion: {
        type: "float",
        speed: 160,
        terrainModifiers: { grass: 0.2, sand: 0.2, swamp: 0.8, rock: 0.1, snow: 0.1, water: 0.9 },
      },
    }),
  },
  {
    name: "Dune Buggy",
    sketch: buggySketch,
    spec: spec({ displayName: "Dune Buggy", flavor: "A quick little wheeled scout." }),
  },
];

// The prompt and settings as they stood when the wireframes shipped, so the
// "before" arm is the real previous behaviour rather than a half-reverted one.
const OLD_POSITIVE = (current: string) =>
  current.replace(
    "solid opaque body filled with flat colour, thick dark outline around the exterior only",
    "bold readable outline",
  );
const OLD_NEGATIVE =
  "person, driver, pilot, text, watermark, signature, shadow, ground, floor, " +
  "border, frame, photo, photorealistic, 3d render, blurry, multiple objects, " +
  "sprite sheet, grid, collage, multiple views, variations, tileset, icon set";

const CELL = 240;

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
  const baseUrl = process.env.LOCAL_IMAGE_URL;
  if (!baseUrl) {
    console.error("eval-silhouette needs LOCAL_IMAGE_URL (the ComfyUI server).");
    process.exit(1);
  }
  const endpoint = { baseUrl, token: process.env.LOCAL_AI_TOKEN ?? "" };
  mkdirSync(OUT_DIR, { recursive: true });

  const cells: Image[] = [];
  let regressions = 0;

  for (const subject of SUBJECTS) {
    const raw = subject.sketch();
    const rawPng = await encodePngRgba(SW, SH, raw);
    const sketchB64 = Buffer.from(rawPng).toString("base64");

    // What the fill makes of it, saved so the prior is inspectable by eye.
    const filled = fillSilhouette(raw, SW, SH);
    writeFileSync(
      join(OUT_DIR, `${subject.name.toLowerCase().replace(/\W+/g, "-")}-0-sketch.png`),
      Buffer.from(rawPng),
    );
    writeFileSync(
      join(OUT_DIR, `${subject.name.toLowerCase().replace(/\W+/g, "-")}-1-filled.png`),
      Buffer.from(await encodePngRgba(SW, SH, filled.rgba)),
    );
    console.log(
      `\n${subject.name}: sketch filled → solidity ${filled.solidity.toFixed(2)}` +
        (filled.thickened ? " (open line-work, thickened)" : " (enclosed, flood-filled)"),
    );

    const seed = 424242;
    const ARMS = [
      {
        label: "before",
        opts: {
          seed,
          cfg: 1.0,
          denoise: 0.7,
          fillSketch: false,
          negativePrompt: OLD_NEGATIVE,
        },
        oldPrompt: true,
      },
      { label: "after", opts: { seed }, oldPrompt: false },
    ];

    const results: Record<string, { solidity: number; unity: number }> = {};
    for (const arm of ARMS) {
      const t0 = Date.now();
      const opts: Record<string, unknown> = { ...arm.opts };
      if (arm.oldPrompt) {
        const { buildLocalImagePrompt } = await import("../shared/fabricator/image-local");
        opts.prompt = OLD_POSITIVE(buildLocalImagePrompt(subject.spec));
      }
      const sprite = await generateBodySpriteLocal(subject.spec, { sketch: sketchB64 }, endpoint, opts);
      const bytes = Buffer.from(sprite.dataUrl.split(",")[1], "base64");
      const img = decodeImage(bytes);
      const m = measureUnity(magentaMask(img.data, img.width, img.height), img.width, img.height);
      results[arm.label] = { solidity: m.solidity, unity: m.unity };
      const verdict = m.solidity >= MIN_SOLIDITY ? "SOLID" : "HOLLOW";
      console.log(
        `  ${arm.label.padEnd(6)} ${String(Date.now() - t0).padStart(6)}ms ` +
          `solidity=${m.solidity.toFixed(3)} unity=${m.unity.toFixed(2)} ${verdict}`,
      );
      writeFileSync(
        join(OUT_DIR, `${subject.name.toLowerCase().replace(/\W+/g, "-")}-${arm.label === "before" ? 2 : 3}-${arm.label}.png`),
        bytes,
      );
      cells.push(fit(img, CELL));
    }
    if (results.after.solidity < MIN_SOLIDITY) {
      console.log(`  ✗ ${subject.name}: the fix did not clear the solidity bar`);
      regressions++;
    }
  }

  const cols = 2;
  const rowsN = Math.ceil(cells.length / cols);
  const sheet = makeImage(cols * (CELL + 8) + 8, rowsN * (CELL + 8) + 8, [34, 40, 49, 255]);
  cells.forEach((cell, i) => {
    const cx = 8 + (i % cols) * (CELL + 8);
    const cy = 8 + Math.floor(i / cols) * (CELL + 8);
    blit(sheet, cell, cx + Math.floor((CELL - cell.width) / 2), cy + Math.floor((CELL - cell.height) / 2));
  });
  const sheetPath = join(OUT_DIR, "before-after.png");
  writeFileSync(sheetPath, encodePng(sheet));
  console.log(`\nleft column = before, right column = after\ncontact sheet: ${sheetPath}`);
  process.exit(regressions === 0 ? 0 : 1);
}

main();
