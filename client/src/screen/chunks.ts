// Terrain streaming. The world is endless, so the ground can't be one big
// RenderTexture any more — it's a grid of chunk-sized ones, created as the
// cameras approach and destroyed as they leave.
//
// The seam problem, and why this is laid out the way it is:
//
// Kenney's hex tiles are 3D blocks — a 64px top face over a 25px slab side —
// so a tile overlaps the row above it, and odd rows are staggered half a tile
// to the right. Chunk quads that overlap would therefore need a global depth
// order that respects *hex rows*, which two horizontally-adjacent chunks
// cannot agree on. Instead each chunk redraws the one column and two rows that
// bleed in from its neighbours and then clips to its own exact rectangle. The
// quads tile edge to edge, nothing overlaps, and depth never has to arbitrate.
//
// Cost per chunk is (COLS+1) × (ROWS+2) batched draws, once, at load.

import Phaser from "phaser";
import { HEX_W, ROW_H, hexImageTopLeft, hexToWorld } from "./hexgrid";
import { BIOMES, decorAt, tileAt } from "./worldgen";

export const CHUNK_COLS = 10;
export const CHUNK_ROWS = 12;

/** Chunk footprint in world pixels. */
export const CHUNK_W = CHUNK_COLS * HEX_W; // 650
export const CHUNK_H = CHUNK_ROWS * ROW_H; // 576

/** Ground sits under everything; nothing else uses depths this low. */
const GROUND_DEPTH = -10_000;

/**
 * How far past each camera's view to keep chunks resident. One chunk of
 * margin means the ground is always already there when you cross a boundary,
 * instead of popping in at the edge of the screen.
 */
const MARGIN = 1;

/**
 * Chunks kept resident BEYOND what the cameras currently need.
 *
 * This used to be a flat ceiling of 34, which was never a ceiling: eviction
 * only ever drops chunks nobody needs, so a view that needs more simply keeps
 * more. Two cameras on a 1080p screen already need about 40, so the number
 * described a budget the code was not keeping — and the fix is not a bigger
 * constant. What the cameras need spans roughly 20 chunks on a phone and 50
 * on a split 1440p television, so any single figure is either a phone holding
 * three times what it can see or a television rebuilding what it just had.
 *
 * Sized against the view instead. Each chunk is a 650×576 GPU texture (~1.5 MB),
 * so the resident set costs about (needed + 8) × 1.5 MB: ~42 MB on a phone,
 * ~87 MB on the worst split-screen. The 8 is history — enough that pacing back
 * and forth across one boundary doesn't rebuild the same two chunks forever.
 */
const HISTORY_CHUNKS = 8;

/** Chunks built per frame. Building is a few milliseconds of batched draws;
 *  more than a couple in one frame is a visible hitch when you drive fast. */
const BUILDS_PER_FRAME = 2;

export type ChunkKey = string;
export const chunkKey = (cx: number, cy: number): ChunkKey => `${cx},${cy}`;

/** Which chunk a hex belongs to. Floor division, so negatives work. */
export const chunkOfHex = (col: number, row: number) => ({
  cx: Math.floor(col / CHUNK_COLS),
  cy: Math.floor(row / CHUNK_ROWS),
});

export type ChunkHooks = {
  /** A chunk became resident: spawn its resource nodes. */
  onLoad: (cx: number, cy: number) => void;
  /** A chunk left: destroy everything that belonged to it. */
  onUnload: (cx: number, cy: number) => void;
};

export class ChunkField {
  private live = new Map<ChunkKey, Phaser.GameObjects.RenderTexture>();
  private queue: { cx: number; cy: number }[] = [];
  private queued = new Set<ChunkKey>();
  private lastNeeded = "";

  constructor(
    private scene: Phaser.Scene,
    private seed: number,
    private hooks: ChunkHooks,
  ) {}

  /** Resident chunk count — the HUD's perf readout uses it. */
  get size(): number {
    return this.live.size;
  }

  /**
   * Reconcile residency against where the cameras are looking. Called every
   * frame, so the common case (nothing changed) has to be nearly free: the
   * needed set is compared as a joined string before any work happens.
   */
  update(cameras: Phaser.Cameras.Scene2D.Camera[]): void {
    const needed = new Set<ChunkKey>();
    const centres: { x: number; y: number }[] = [];

    for (const cam of cameras) {
      const v = cam.worldView;
      centres.push({ x: v.centerX, y: v.centerY });
      const x0 = Math.floor(v.x / CHUNK_W) - MARGIN;
      const x1 = Math.floor((v.x + v.width) / CHUNK_W) + MARGIN;
      const y0 = Math.floor(v.y / CHUNK_H) - MARGIN;
      const y1 = Math.floor((v.y + v.height) / CHUNK_H) + MARGIN;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) needed.add(chunkKey(cx, cy));
      }
    }

    const signature = [...needed].join("|");
    if (signature !== this.lastNeeded) {
      this.lastNeeded = signature;
      for (const key of needed) {
        if (this.live.has(key) || this.queued.has(key)) continue;
        const [cx, cy] = key.split(",").map(Number);
        this.queue.push({ cx, cy });
        this.queued.add(key);
      }
      this.evict(needed, centres);
    }

    for (let i = 0; i < BUILDS_PER_FRAME && this.queue.length; i++) {
      const { cx, cy } = this.queue.shift()!;
      const key = chunkKey(cx, cy);
      this.queued.delete(key);
      // The camera may have moved on while this sat in the queue.
      if (!needed.has(key) || this.live.has(key)) continue;
      this.build(cx, cy);
    }
  }

  /** Drop chunks nobody needs, furthest from any camera first. */
  private evict(needed: Set<ChunkKey>, centres: { x: number; y: number }[]): void {
    const spare = [...this.live.keys()].filter((k) => !needed.has(k));
    const budget = needed.size + HISTORY_CHUNKS;
    if (this.live.size <= budget && spare.length === 0) return;

    const distance = (key: ChunkKey) => {
      const [cx, cy] = key.split(",").map(Number);
      const x = (cx + 0.5) * CHUNK_W;
      const y = (cy + 0.5) * CHUNK_H;
      return Math.min(...centres.map((c) => Math.hypot(c.x - x, c.y - y)));
    };
    spare.sort((a, b) => distance(b) - distance(a));

    // Everything outside the needed set is fair game once we're over budget;
    // under it we keep a little history, so pacing back and forth across one
    // boundary doesn't rebuild the same two chunks forever.
    const overBudget = this.live.size - budget;
    const keepSpare = Math.max(0, Math.min(spare.length, HISTORY_CHUNKS));
    const dropCount = Math.max(overBudget, spare.length - keepSpare);
    for (const key of spare.slice(0, dropCount)) this.drop(key);
  }

  private drop(key: ChunkKey): void {
    this.live.get(key)?.destroy();
    this.live.delete(key);
    const [cx, cy] = key.split(",").map(Number);
    this.hooks.onUnload(cx, cy);
  }

  private build(cx: number, cy: number): void {
    const x0 = cx * CHUNK_W;
    const y0 = cy * CHUNK_H;
    const rt = this.scene.add
      .renderTexture(x0, y0, CHUNK_W, CHUNK_H)
      .setOrigin(0, 0)
      .setDepth(GROUND_DEPTH);

    const col0 = cx * CHUNK_COLS;
    const row0 = cy * CHUNK_ROWS;

    rt.beginDraw();
    // Two rows of bleed-in above and one column to the left: a tile's image
    // hangs 41px below its row, and a sunken sea tile (+11) hangs 52px, so the
    // row two above can just reach in. Raised ground (-14) reaches less far,
    // not more, so two rows still covers the worst case. Ascending row order is
    // what makes each row's top face cover the slab of the row above it.
    for (let row = row0 - 2; row < row0 + CHUNK_ROWS; row++) {
      for (let col = col0 - 1; col < col0 + CHUNK_COLS; col++) {
        const { biome, drop } = tileAt(col, row, this.seed);
        const c = hexToWorld(col, row);
        const tl = hexImageTopLeft(col, row);
        rt.batchDraw(BIOMES[biome].tile, tl.x - x0, tl.y + drop - y0);
        const deco = decorAt(col, row, this.seed, biome);
        if (deco) {
          const img = this.scene.textures.get(deco).getSourceImage();
          rt.batchDraw(
            deco,
            c.x - img.width / 2 - x0,
            c.y - img.height + 4 + drop - y0,
          );
        }
      }
    }
    rt.endDraw();

    this.live.set(chunkKey(cx, cy), rt);
    this.hooks.onLoad(cx, cy);
  }

  destroy(): void {
    for (const key of [...this.live.keys()]) this.drop(key);
    this.queue.length = 0;
    this.queued.clear();
  }
}
