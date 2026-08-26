// A/B harness for sprite prompts and models.
//
// Every arm runs the same subjects at the same SEEDS, which is the whole
// point: seed variance turned out to dominate this pipeline, so two arms
// compared on different seeds tell you nothing. Written to settle the
// sprite-sheet question (see docs/local-ai.md) and kept for the next one —
// swapping checkpoints, trying a new LoRA, testing a prompt idea.
//
// Free and local, but not part of `npm test`: it spends minutes of GPU.
//
//   npx tsx scripts/eval-art-matrix.ts 1              ← the prompt arms
//   npx tsx scripts/eval-art-matrix.ts 2 A2-specimen  ← that arm on FLUX
//
// FLUX note: it loads ~22GB and keeps it. Free it before going back to
// SDXL —  curl -X POST :8188/free -d '{"unload_models":true,"free_memory":true}'

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBodySpriteLocal, type LocalImageOptions } from "../shared/fabricator/image-local";
import { clampSpec, computeCost } from "../shared/fabricator";
import type { FabricatedSpec, RawSpec } from "../shared/fabricator";
import { STYLE_PALETTE } from "../shared/fabricator/style-refs";
import { keyImage } from "../client/src/screen/chroma-core";
import { alphaMask, measureUnity } from "../shared/fabricator/sprite-check";
import { decodeImage, encodePng, makeImage, blit, type Image } from "./lib/png";

const OUT = fileURLToPath(new URL("../fixtures/art-local/matrix/", import.meta.url));
const endpoint = { baseUrl: process.env.LOCAL_IMAGE_URL ?? "http://127.0.0.1:8188", token: "" };

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
const move = (type: "wheels" | "tracks" | "legs" | "float") => ({
  type,
  speed: 200,
  terrainModifiers: { grass: 0.9, sand: 0.8, swamp: 0.2, rock: 0.3, snow: 0.2, water: type === "float" ? 0.9 : 0 },
});

/** Weighted toward the known offenders: two vehicles and two tools that
 *  came back as grids, plus one structure that never did. */
const SUBJECTS: FabricatedSpec[] = [
  spec({ category: "vehicle", displayName: "Dune Runner", flavor: "A quick little wheeled scout.", size: { w: 90, h: 50 }, locomotion: move("wheels"), seats: 1 }),
  spec({ category: "vehicle", displayName: "Spider Walker", flavor: "Eight legs, no fear of rocks.", size: { w: 80, h: 70 }, locomotion: move("legs"), seats: 1 }),
  spec({ category: "tool", displayName: "Iron Spear", flavor: "Reach, and the sense to use it.", size: { w: 40, h: 26 }, weapon: { damage: 14, reach: 110, cooldown: 0.8 } }),
  spec({ category: "tool", displayName: "Rime Drill", flavor: "Chews frost like biscuit.", size: { w: 40, h: 30 }, harvest: { rate: 1.5, materials: ["rime"] } }),
  spec({ category: "structure", displayName: "Stone Hut", flavor: "Four walls against the night.", size: { w: 100, h: 90 } }),
];

const SEEDS = [11111, 22222];

const palette = STYLE_PALETTE.length ? `, palette ${STYLE_PALETTE.join(" ")}` : "";

function viewOf(s: FabricatedSpec): string {
  const GEAR: Record<string, string> = {
    wheels: "chunky rubber wheels along its underside",
    tracks: "caterpillar tracks along its underside",
    legs: "articulated walking legs",
    float: "pontoon floats",
  };
  const gear = GEAR[s.locomotion.type];
  return s.category === "vehicle"
    ? "strict side view, facing right, flat even lighting" + (gear ? `, complete with ${gear}` : "")
    : s.category === "tool"
      ? "slight three-quarter angle, business end toward lower left, not held by anyone"
      : "high three-quarter top-down view";
}

// ── the prompt strategies under test ──

/** A0: what ships today — leads with "2D video game sprite". */
const baseline = (s: FabricatedSpec) =>
  `pixel, 2D video game sprite of ${s.displayName}, a ${s.category}. ${s.flavor} ` +
  `${viewOf(s)}, single object, centered, filling most of the frame, ` +
  `flat cel shading, chunky simplified toy-like shapes, bold readable silhouette${palette}`;

/** A1: the same picture, never called a sprite or game art. */
const degamified = (s: FabricatedSpec) =>
  `pixel art illustration of one single ${s.displayName}. ${s.flavor} ` +
  `${viewOf(s)}. one complete object, centered, filling the frame, ` +
  `flat cel shading, chunky simplified shapes, bold readable outline${palette}`;

/** A2: borrows the museum-specimen idiom — a frame that holds one thing. */
const specimen = (s: FabricatedSpec) =>
  `a single ${s.displayName}, alone. ${s.flavor} ${viewOf(s)}. ` +
  `one whole object shown by itself against an empty background, centered, filling the frame. ` +
  `pixel art, flat cel shading, chunky simplified shapes, bold readable outline${palette}`;

const NEG_STRONG =
  "sprite sheet, grid, collage, multiple views, variations, tileset, icon set, " +
  "person, driver, text, watermark, shadow, ground, border, photo, 3d render";

type Arm = {
  id: string;
  what: string;
  prompt: (s: FabricatedSpec) => string;
  opts?: LocalImageOptions;
};

const PHASE1: Arm[] = [
  { id: "A0-baseline", what: "ships today: '2D video game sprite'", prompt: baseline },
  { id: "A1-degamified", what: "no game/sprite words", prompt: degamified },
  { id: "A2-specimen", what: "'a single X, alone'", prompt: specimen },
  {
    id: "A3-cfg2",
    what: "baseline + cfg 2.0 (negative prompt finally bites)",
    prompt: baseline,
    opts: { cfg: 2.0, negativePrompt: NEG_STRONG },
  },
  {
    id: "A4-nolora",
    what: "degamified, LoRA off (is the LoRA the grid source?)",
    prompt: degamified,
    opts: { lora: "" },
  },
];

const FLUX: LocalImageOptions = {
  checkpoint: "flux1-schnell-fp8.safetensors",
  lora: "", // pixel-art-xl is SDXL-only
  steps: 4,
  cfg: 1.0,
  latentType: "sd3",
  scheduler: "simple",
  timeoutMs: 300_000,
};

const CELL = 200;
type Row = { arm: string; subject: string; unity: number; blobs: number; keyed: string; ms: number };

async function runArm(arm: Arm, extra: LocalImageOptions = {}): Promise<Row[]> {
  const rows: Row[] = [];
  const cells: Image[] = [];
  for (const s of SUBJECTS) {
    for (const seed of SEEDS) {
      const t0 = Date.now();
      try {
        const sprite = await generateBodySpriteLocal(s, {}, endpoint, {
          ...arm.opts,
          ...extra,
          prompt: arm.prompt(s),
          seed,
        });
        const ms = Date.now() - t0;
        const buf = Buffer.from(sprite.dataUrl.split(",")[1], "base64");
        const img = decodeImage(buf);
        writeFileSync(
          join(OUT, `${arm.id}--${s.displayName.toLowerCase().replace(/\W+/g, "-")}-${seed}.png`),
          buf,
        );
        const outcome = keyImage(img.data, img.width, img.height);
        const m = outcome.applied
          ? measureUnity(alphaMask(img.data, img.width, img.height), img.width, img.height)
          : { unity: 0, blobs: 0, coverage: 0, spanX: 0, spanY: 0 };
        rows.push({
          arm: arm.id,
          subject: s.displayName,
          unity: m.unity,
          blobs: m.blobs,
          keyed: outcome.applied ? "ok" : outcome.reason,
          ms,
        });
        cells.push(fit(img, CELL));
        console.log(
          `  ${arm.id.padEnd(14)} ${s.displayName.padEnd(14)} seed=${seed} ` +
            `unity=${m.unity.toFixed(2)} blobs=${m.blobs} ${outcome.applied ? "keyed" : outcome.reason} ${ms}ms`,
        );
      } catch (err) {
        rows.push({ arm: arm.id, subject: s.displayName, unity: 0, blobs: 0, keyed: "ERROR", ms: Date.now() - t0 });
        console.log(`  ${arm.id.padEnd(14)} ${s.displayName.padEnd(14)} ERROR ${(err as Error).message.slice(0, 80)}`);
      }
    }
  }
  if (cells.length) sheet(cells, join(OUT, `sheet-${arm.id}.png`));
  return rows;
}

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

function sheet(cells: Image[], path: string) {
  const cols = SEEDS.length * 2 <= 4 ? SEEDS.length * 2 : 4;
  const rowsN = Math.ceil(cells.length / cols);
  const img = makeImage(cols * (CELL + 8) + 8, rowsN * (CELL + 8) + 8, [34, 40, 49, 255]);
  cells.forEach((c, i) => {
    const cx = 8 + (i % cols) * (CELL + 8);
    const cy = 8 + Math.floor(i / cols) * (CELL + 8);
    blit(img, c, cx + Math.floor((CELL - c.width) / 2), cy + Math.floor((CELL - c.height) / 2));
  });
  writeFileSync(path, encodePng(img));
}

function table(rows: Row[]) {
  const arms = [...new Set(rows.map((r) => r.arm))];
  console.log(`\n${"arm".padEnd(16)} ${"single-object".padEnd(14)} ${"mean unity".padEnd(11)} keyed  mean ms`);
  for (const a of arms) {
    const rs = rows.filter((r) => r.arm === a);
    const single = rs.filter((r) => r.unity >= 0.85).length;
    const meanU = rs.reduce((n, r) => n + r.unity, 0) / rs.length;
    const keyed = rs.filter((r) => r.keyed === "ok").length;
    const ms = Math.round(rs.reduce((n, r) => n + r.ms, 0) / rs.length);
    console.log(
      `${a.padEnd(16)} ${`${single}/${rs.length}`.padEnd(14)} ${meanU.toFixed(2).padEnd(11)} ${String(keyed).padEnd(6)} ${ms}`,
    );
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const phase = process.argv[2] ?? "1";
  const all: Row[] = [];
  if (phase === "1") {
    for (const arm of PHASE1) {
      console.log(`\n─── ${arm.id}: ${arm.what} ───`);
      all.push(...(await runArm(arm)));
    }
  } else {
    // Phase 2: the winning prompt on FLUX, against the same prompt on SDXL.
    const winner = PHASE1.find((a) => a.id === (process.argv[3] ?? "A1-degamified"))!;
    console.log(`\n─── FLUX: ${winner.id} ───`);
    all.push(...(await runArm({ ...winner, id: `FLUX-${winner.id}` }, FLUX)));
  }
  table(all);
  console.log(`\nsheets + frames: ${OUT}`);
}
main();
