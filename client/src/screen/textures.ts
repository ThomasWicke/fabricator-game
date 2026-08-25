// Procedural placeholder art, generated at runtime so Phase 1 needs zero
// asset files. Swap for real sprites (e.g. kenney.nl tilesets) by replacing
// these texture keys with loaded images — the rest of the code only refers
// to keys.

import Phaser from "phaser";

export const TILE = 32;
export const TILE_KEYS = {
  grassA: 0,
  grassB: 1,
  grassC: 2,
  grassD: 3,
  flowers: 4,
  dirt: 5,
  sandA: 6,
  sandB: 7,
  swampA: 8,
  swampB: 9,
};
export const TILE_COUNT = 10;

/** Deterministic RNG so world layout is stable for a given room code. */
export function mulberry32(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(
  ctx: CanvasRenderingContext2D,
  ox: number,
  rng: () => number,
  count: number,
  colors: string[],
) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rng() * colors.length)];
    const x = ox + rng() * (TILE - 2);
    const y = rng() * (TILE - 2);
    ctx.fillRect(Math.floor(x), Math.floor(y), 2, 2);
  }
}

export function makeTilesTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("tiles")) return;
  const canvas = scene.textures.createCanvas("tiles", TILE * TILE_COUNT, TILE)!;
  const ctx = canvas.context;
  const rng = mulberry32("tiles");

  const grassBases = ["#3f7d3a", "#42823c", "#3b7737", "#458540"];
  for (let v = 0; v < 4; v++) {
    const ox = v * TILE;
    ctx.fillStyle = grassBases[v];
    ctx.fillRect(ox, 0, TILE, TILE);
    speckle(ctx, ox, rng, 14, ["#4e9147", "#376e33", "#57a04f"]);
  }

  // flowers tile: grass base + colored dots
  const fx = TILE_KEYS.flowers * TILE;
  ctx.fillStyle = grassBases[0];
  ctx.fillRect(fx, 0, TILE, TILE);
  speckle(ctx, fx, rng, 10, ["#4e9147", "#376e33"]);
  speckle(ctx, fx, rng, 6, ["#f2e34c", "#e86fae", "#f4f4f4"]);

  // dirt tile
  const dx = TILE_KEYS.dirt * TILE;
  ctx.fillStyle = "#7a5c3d";
  ctx.fillRect(dx, 0, TILE, TILE);
  speckle(ctx, dx, rng, 12, ["#6b5036", "#8a6a48", "#5f462f"]);

  // sand tiles (beach)
  const sandBases = ["#d8c07a", "#d1b970"];
  for (let v = 0; v < 2; v++) {
    const ox = (TILE_KEYS.sandA + v) * TILE;
    ctx.fillStyle = sandBases[v];
    ctx.fillRect(ox, 0, TILE, TILE);
    speckle(ctx, ox, rng, 10, ["#c4ab60", "#e3cf8f", "#bfa458"]);
  }

  // swamp tiles (murky mud + weeds)
  const swampBases = ["#4a5236", "#414a30"];
  for (let v = 0; v < 2; v++) {
    const ox = (TILE_KEYS.swampA + v) * TILE;
    ctx.fillStyle = swampBases[v];
    ctx.fillRect(ox, 0, TILE, TILE);
    speckle(ctx, ox, rng, 10, ["#38402a", "#59634a", "#2f3a2d"]);
    // murky puddle glints
    ctx.fillStyle = "rgba(90, 110, 100, 0.55)";
    for (let i = 0; i < 3; i++) {
      const x = ox + 3 + rng() * (TILE - 12);
      const y = 3 + rng() * (TILE - 8);
      ctx.beginPath();
      ctx.ellipse(x + 4, y + 2, 4 + rng() * 3, 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  canvas.refresh();
}

/** The Universal Fabricator pad — where blueprints materialize. */
export function makePadTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("pad")) return;
  const w = 110;
  const h = 74;
  const canvas = scene.textures.createCanvas("pad", w, h)!;
  const ctx = canvas.context;
  // base plate
  ctx.fillStyle = "#3a4356";
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2 + 8, 50, 24, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4c5870";
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2 + 4, 44, 20, 0, 0, Math.PI * 2);
  ctx.fill();
  // glowing ring
  ctx.strokeStyle = "#6c9ef8";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2 + 4, 34, 14, 0, 0, Math.PI * 2);
  ctx.stroke();
  // emitter pylon
  ctx.fillStyle = "#2b3242";
  ctx.fillRect(w / 2 - 5, 4, 10, 26);
  ctx.fillStyle = "#8fc1ff";
  ctx.fillRect(w / 2 - 3, 6, 6, 6);
  canvas.refresh();
}

/** Bogiron deposit — the swamp-only resource node. */
export function makeBogironTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("bogiron")) return;
  const w = 34;
  const h = 26;
  const canvas = scene.textures.createCanvas("bogiron", w, h)!;
  const ctx = canvas.context;
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 3, 13, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // dark lump
  ctx.fillStyle = "#3c3430";
  ctx.beginPath();
  ctx.moveTo(3, h - 5);
  ctx.lineTo(7, 7);
  ctx.lineTo(17, 3);
  ctx.lineTo(28, 8);
  ctx.lineTo(31, h - 5);
  ctx.closePath();
  ctx.fill();
  // rusty ore flecks
  ctx.fillStyle = "#c97b3d";
  for (const [x, y] of [[10, 10], [19, 8], [24, 14], [13, 16], [20, 18]]) {
    ctx.fillRect(x, y, 3, 3);
  }
  canvas.refresh();
}

/** Berries, stamped over a biome's own bush so forage is unmistakable from
 *  the decorative shrubbery growing next to it. */
export function makeForageTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("berries")) return;
  const s = 16;
  const canvas = scene.textures.createCanvas("berries", s, s)!;
  const ctx = canvas.context;
  for (const [x, y, r, fill] of [
    [5, 9, 3, "#d8443f"],
    [10.5, 7, 2.6, "#e8615a"],
    [8, 12, 2.4, "#b8332f"],
  ] as [number, number, number, string][]) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }
  canvas.refresh();
}

/**
 * The things you carry, drawn small enough to stack.
 *
 * Each sits in the same 22×12 box so a mixed stack lines up, and each is lit
 * from the same direction as the terrain art. They are seen from slightly
 * above, like everything else here.
 */
export function makeCarryTextures(scene: Phaser.Scene): void {
  const W = 22;
  const H = 12;
  const make = (key: string, draw: (ctx: CanvasRenderingContext2D) => void) => {
    if (scene.textures.exists(key)) return;
    const canvas = scene.textures.createCanvas(key, W, H)!;
    draw(canvas.context);
    canvas.refresh();
  };

  // A log, seen end-on: the pale cut face is what makes a woodpile read.
  make("carry-wood", (ctx) => {
    ctx.fillStyle = "#8a6a48";
    ctx.beginPath();
    ctx.roundRect(1, 2, 18, 9, 4);
    ctx.fill();
    ctx.fillStyle = "#6d5236";
    ctx.beginPath();
    ctx.roundRect(1, 7, 18, 4, 2);
    ctx.fill();
    ctx.fillStyle = "#a8845e";
    ctx.beginPath();
    ctx.ellipse(17.5, 6.5, 3.4, 4.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#6d5236";
    ctx.beginPath();
    ctx.ellipse(17.5, 6.5, 1.5, 2.1, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  /**
   * A cuboid block: lit top, two shaded faces.
   *
   * Drawn with real vertical extent rather than as a flat diamond — a diamond
   * reads as a disc lying on the ground, and a stack of discs looks like a
   * stack of nothing. The faces match the terrain's lighting so a block on
   * your back belongs to the same world as the rock you took it from.
   */
  const block = (
    ctx: CanvasRenderingContext2D,
    top: string,
    left: string,
    right: string,
  ) => {
    const cx = 11;
    const midY = 5;
    const halfW = 9;
    const halfD = 4;
    const depth = 3.5;
    ctx.fillStyle = left;
    ctx.beginPath();
    ctx.moveTo(cx - halfW, midY);
    ctx.lineTo(cx, midY + halfD);
    ctx.lineTo(cx, midY + halfD + depth);
    ctx.lineTo(cx - halfW, midY + depth);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = right;
    ctx.beginPath();
    ctx.moveTo(cx, midY + halfD);
    ctx.lineTo(cx + halfW, midY);
    ctx.lineTo(cx + halfW, midY + depth);
    ctx.lineTo(cx, midY + halfD + depth);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(cx, midY - halfD);
    ctx.lineTo(cx + halfW, midY);
    ctx.lineTo(cx, midY + halfD);
    ctx.lineTo(cx - halfW, midY);
    ctx.closePath();
    ctx.fill();
  };

  make("carry-stone", (ctx) => block(ctx, "#c2c9d3", "#7f8794", "#98a0ab"));

  // Bogiron: the same block, dark, with the rusty flecks that name it.
  make("carry-bogiron", (ctx) => {
    block(ctx, "#5d4e42", "#332b24", "#463b32");
    for (const [x, y, r] of [[8, 5, 1.2], [13, 4.2, 1], [11, 6.4, 0.85]] as [number, number, number][]) {
      ctx.fillStyle = "#d9813f";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // A handful of berries.
  make("carry-food", (ctx) => {
    for (const [x, y, r, fill] of [
      [8, 7, 3, "#b8332f"],
      [13, 5.5, 2.7, "#d8443f"],
      [11, 9, 2.3, "#9c2a27"],
    ] as [number, number, number, string][]) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/**
 * A soft contact shadow for boulders.
 *
 * The pack's pines carry their own baked shadow; the rocks don't, and on
 * matching ground they lose their footing entirely — a snow-capped rock on a
 * snowfield has a top face the same near-white as the tile, so only its
 * shaded sides show and it reads as a notch cut into the ground rather than a
 * lump sitting on it. A shadow puts it back on the surface.
 */
export function makeShadowTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("shadow")) return;
  const w = 54;
  const h = 26;
  const canvas = scene.textures.createCanvas("shadow", w, h)!;
  const ctx = canvas.context;
  const g = ctx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
  g.addColorStop(0, "rgba(20, 28, 38, 0.32)");
  g.addColorStop(0.6, "rgba(20, 28, 38, 0.16)");
  g.addColorStop(1, "rgba(20, 28, 38, 0)");
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(1, h / w);
  ctx.translate(-w / 2, -w / 2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, w);
  ctx.restore();
  canvas.refresh();
}

/** A burrow: the thing enemies come out of, and the thing they run back to.
 *  Deliberately dark and low — you should spot it before it spots you. */
export function makeNestTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("nest")) return;
  const w = 46;
  const h = 30;
  const canvas = scene.textures.createCanvas("nest", w, h)!;
  const ctx = canvas.context;
  // mound
  ctx.fillStyle = "#3a3128";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 8, 21, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4a3f33";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 11, 18, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  // the hole
  ctx.fillStyle = "#140f0c";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 10, 9, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  // a few scattered bits around the entrance
  ctx.fillStyle = "#2b241d";
  for (const [x, y] of [[9, 22], [36, 21], [14, 9], [33, 11]] as [number, number][]) {
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  canvas.refresh();
}

/** A dropped pack — where somebody's load stayed when they didn't. */
export function makePackTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("pack")) return;
  const w = 26;
  const h = 24;
  const canvas = scene.textures.createCanvas("pack", w, h)!;
  const ctx = canvas.context;
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 3, 10, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#7a5c3d";
  ctx.beginPath();
  ctx.roundRect(4, 6, w - 8, h - 10, 4);
  ctx.fill();
  ctx.fillStyle = "#a8845e";
  ctx.beginPath();
  ctx.roundRect(4, 6, w - 8, 5, 3);
  ctx.fill();
  ctx.strokeStyle = "#4f3a25";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w / 2, 6);
  ctx.lineTo(w / 2, h - 4);
  ctx.stroke();
  canvas.refresh();
}

/** Tiny soft textures for particle emitters (smoke puffs, sparks). */
export function makeParticleTextures(scene: Phaser.Scene): void {
  if (!scene.textures.exists("puff")) {
    const s = 12;
    const canvas = scene.textures.createCanvas("puff", s, s)!;
    const ctx = canvas.context;
    const g = ctx.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(200,200,205,0.9)");
    g.addColorStop(1, "rgba(200,200,205,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    canvas.refresh();
  }
  if (!scene.textures.exists("spark")) {
    const s = 5;
    const canvas = scene.textures.createCanvas("spark", s, s)!;
    const ctx = canvas.context;
    ctx.fillStyle = "#ffd75e";
    ctx.fillRect(0, 0, s, s);
    canvas.refresh();
  }
  if (!scene.textures.exists("glow")) {
    const s = 128;
    const canvas = scene.textures.createCanvas("glow", s, s)!;
    const ctx = canvas.context;
    const g = ctx.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,231,160,0.55)");
    g.addColorStop(0.6, "rgba(255,231,160,0.18)");
    g.addColorStop(1, "rgba(255,231,160,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    canvas.refresh();
  }
}

export function makeTreeTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("tree")) return;
  const w = 52;
  const h = 64;
  const canvas = scene.textures.createCanvas("tree", w, h)!;
  const ctx = canvas.context;
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 5, 16, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  // trunk
  ctx.fillStyle = "#6d4c33";
  ctx.fillRect(w / 2 - 4, h - 24, 8, 20);
  // canopy: layered blobs
  const greens = ["#2e6b2e", "#357a34", "#3f8c3c"];
  const blobs: [number, number, number][] = [
    [w / 2, 26, 20],
    [w / 2 - 12, 34, 13],
    [w / 2 + 12, 34, 13],
    [w / 2, 16, 13],
  ];
  blobs.forEach(([x, y, r], i) => {
    ctx.fillStyle = greens[i % greens.length];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#4d9c48";
  ctx.beginPath();
  ctx.arc(w / 2 - 6, 20, 7, 0, Math.PI * 2);
  ctx.fill();
  canvas.refresh();
}

export function makeRockTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists("rock")) return;
  const w = 36;
  const h = 28;
  const canvas = scene.textures.createCanvas("rock", w, h)!;
  const ctx = canvas.context;
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 4, 14, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#8a8f99";
  ctx.beginPath();
  ctx.moveTo(4, h - 6);
  ctx.lineTo(8, 8);
  ctx.lineTo(18, 3);
  ctx.lineTo(29, 9);
  ctx.lineTo(32, h - 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#a6abb5";
  ctx.beginPath();
  ctx.moveTo(8, 10);
  ctx.lineTo(18, 5);
  ctx.lineTo(24, 9);
  ctx.lineTo(14, 14);
  ctx.closePath();
  ctx.fill();
  canvas.refresh();
}

/** Simple round explorer with a backpack; tinted per player slot. */
export function makeExplorerTexture(
  scene: Phaser.Scene,
  key: string,
  color: string,
  colorDark: string,
): void {
  if (scene.textures.exists(key)) return;
  const w = 28;
  const h = 34;
  const canvas = scene.textures.createCanvas(key, w, h)!;
  const ctx = canvas.context;
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h - 4, 10, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // backpack (peeks out on the left)
  ctx.fillStyle = colorDark;
  ctx.fillRect(2, 12, 8, 12);
  // body
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(w / 2 + 2, 16, 11, 0, Math.PI * 2);
  ctx.fill();
  // visor
  ctx.fillStyle = "#dff3ff";
  ctx.beginPath();
  ctx.ellipse(w / 2 + 6, 13, 5, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#25313f";
  ctx.beginPath();
  ctx.arc(w / 2 + 7, 13, 1.6, 0, Math.PI * 2);
  ctx.fill();
  canvas.refresh();
}
