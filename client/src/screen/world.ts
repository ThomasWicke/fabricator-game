// The shared world scene. Host-authoritative: this scene IS the simulation.
// Controllers only feed inputs in via setInput(); keyboard on the screen
// itself works as a dev fallback (P1: WASD + F/G, P2: arrows + K/L).
//
// Split-screen: two cameras over one world, one per player (DST-couch-co-op
// style), fixed vertical split for now.
//
// The world is ENDLESS. Terrain is a pure function of (hex, seed) in
// worldgen.ts; chunks.ts streams it in and out around the two cameras as
// RenderTextures. Nothing here holds a map — there is no map to hold, and no
// edge to reach. Resource nodes live and die with their chunk; the only thing
// that persists is the set of hexes players have actually worked.
//
// Play is continuous — entities move freely in pixels — but terrain lookup and
// structure placement are hexagonal, and hexgrid.ts knows each hex's 6
// neighbours: the foundation for connecting fabricated structures into
// production lines later.
//
// v1 economy: trees/rocks/bogiron deposits are harvestable nodes feeding a
// shared team stockpile; fabrication charges a per-material bill computed
// from the spec. Bare hands can't gather bogiron — a bogiron-capable
// harvester (tool or vehicle) is required: the first real progression gate.

import Phaser from "phaser";
import type {
  ButtonState,
  Slot,
  StickState,
  WorldSnapshot,
} from "../../../party/protocol";
import type {
  FabricatedSpec,
  MaterialType,
  TerrainType,
} from "../../../shared/fabricator/schema";
import { normalizeModifiers } from "../../../shared/fabricator/schema";
import { canAfford, formatCost } from "../../../shared/fabricator/cost";
import { HEX_W, ROW_H, hexToWorld, worldToHex } from "./hexgrid";
import {
  CHUNK_COLS,
  CHUNK_ROWS,
  ChunkField,
  chunkKey,
  chunkOfHex,
  dropFor,
  type ChunkKey,
} from "./chunks";
import { makePadTexture, makePartTextures, makeParticleTextures } from "./textures";
import {
  BIOMES,
  BIOME_TILE_KEYS,
  DECOR_KEYS,
  SCATTER_KEYS,
  type BiomeType,
  biomeAt,
  findSpawn,
  inClearing,
  isLiquid,
  scatterAt,
  terrainOf,
  worldSeed,
} from "./worldgen";

const WALK_SPEED = 220;
const SPRINT_MULT = 1.65;
/** On-foot terrain penalties. Water and lava aren't slow, they're closed —
 *  crossing them is what a fabricated hull is for. */
const WALK_MODS: Record<TerrainType, number> = {
  grass: 1,
  sand: 0.85,
  swamp: 0.35,
  rock: 0.7,
  snow: 0.55,
  water: 0,
};
const ENTER_RANGE = 70;
const HARVEST_RANGE = 56;
/** Both split-screen viewports are half-width, so the world needs magnifying
 *  to stay readable across a room. Tune here — it applies to both cameras. */
const CAMERA_ZOOM = 1.6;
/** Bare hands: slow, and bogiron is beyond them. */
const HAND_RATE = 0.8;
const HAND_MATERIALS: MaterialType[] = ["wood", "stone"];
const STARTING_STOCK: Record<MaterialType, number> = { wood: 25, stone: 15, bogiron: 0 };
const PLAYER_SCALE = 0.45;
/** Pines carry 8px of transparent padding below the trunk in every size
 *  variant, so origin(0.5,1) alone would bury them. */
const PINE_PAD = 8;
/** Sideways speed below which a vehicle keeps its current facing — stops it
 *  flickering when you drive straight up or down. */
const FLIP_DEADZONE = 12;
/** How far past its own footprint an automated structure can reach. */
const AUTOMATION_REACH = 40;
/** Unattended harvesting runs at this fraction of the spec's rate — free,
 *  but slower than standing there doing it yourself. */
const AUTOMATION_RATE = 0.6;
/** One full day, in ms. Short enough that a session sees both halves. */
const DAY_MS = 240_000;
/** How dark it gets at midnight. High enough that a lamp is worth building. */
const NIGHT_ALPHA = 0.74;
/** Darkness sits above the world; lights sit above the darkness and punch
 *  through it with additive blending. */
const DEPTH_DARKNESS = 900_000;
const DEPTH_LIGHT = 900_001;
const DEPTH_POINTER = 950_000;
/**
 * How far ahead of itself a walker checks for water, in pixels. Roughly the
 * half-depth of the body: enough that you stop at the water's edge rather
 * than in it, and no more.
 *
 * Bigger is NOT safer here. Hexes tile diagonally, so a long axis-aligned
 * probe from the southern lip of a hex reaches into the *south-east*
 * neighbour — and on a diagonal coastline that neighbour is sea while the
 * hex due east is dry sand. An over-long probe therefore refuses moves that
 * are plainly fine, and you get stuck walking the shore. A frame of movement
 * is only ~6px even at a sprint, so this stays well ahead of the body.
 */
const WALK_PROBE = 10;
/** Headings tried when the way ahead is water, in order of preference:
 *  straight on, then bending either way. Stops at ±75° — past that you're
 *  no longer going where you asked to go. */
const SHORE_FAN = [0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3];
/** Below this multiplier a machine simply cannot enter the ground at all. */
const IMPASSABLE = 0.03;

/** The partner arrow appears only inside this range — beyond it you're on
 *  your own expedition and an arrow is just clutter. */
const POINTER_RANGE = 1300;
/** Margin from the viewport edge the arrow rides at, in screen pixels. */
const POINTER_INSET = 52;

const ALIEN_SKINS = { 1: "alienPink", 2: "alienYellow" } as const;
const ALIEN_FRAMES = ["stand", "walk1", "walk2", "climb1", "climb2"];

export type PlayerInput = { stick: StickState; buttons: ButtonState };
export type Stockpile = Record<MaterialType, number>;

const idleInput = (): PlayerInput => ({
  stick: { x: 0, y: 0 },
  buttons: { a: false, b: false },
});

/** Anything the world can manufacture: a stored Design plus a URL for its
 *  display-ready art (chroma-keyed body, or the player's sketch), served
 *  from R2 by the Worker. */
export type PlaceableDesign = {
  id: string;
  spec: FabricatedSpec;
  artUrl?: string;
};

type PlayerEntity = {
  slot: Slot;
  skin: string;
  sprite: Phaser.Physics.Arcade.Sprite;
  label: Phaser.GameObjects.Text;
  net: PlayerInput;
  prevA: boolean;
  color: number;
  driving: VehicleEntity | null;
  tool: {
    designId: string;
    spec: FabricatedSpec;
    icon: Phaser.GameObjects.Image;
    glow?: Phaser.GameObjects.Image;
  } | null;
  nextHarvestAt: number;
};

type VehicleEntity = {
  designId: string;
  container: Phaser.GameObjects.Container;
  /** The body art itself — shaken in place to sell a running engine. */
  bodyImg: Phaser.GameObjects.Image;
  parts: { img: Phaser.GameObjects.Image; kind: string; baseY: number }[];
  spec: FabricatedSpec;
  /** terrainModifiers with the newer movement classes filled in — designs
   *  compiled before rock/snow/water existed still have to drive. */
  mods: Record<TerrainType, number>;
  driver: Slot | null;
  /** Second rider, when the spec has the seats for one. */
  passenger: Slot | null;
  nextHarvestAt: number;
  smoke?: Phaser.GameObjects.Particles.ParticleEmitter;
  sparks?: Phaser.GameObjects.Particles.ParticleEmitter;
  /** Light lives outside the container so it can render above the night
   *  overlay; container children are stuck at the container's depth. */
  glow?: Phaser.GameObjects.Image;
  glowOffset?: { x: number; y: number };
};

type ResourceNode = {
  sprite: Phaser.GameObjects.Image;
  /** Invisible static body at the hex center — collision is decoupled from
   *  the visual so tall sprites with shifted origins can't desync it. */
  blocker: Phaser.GameObjects.Rectangle;
  /** Logical position on the ground. Gameplay (harvest range, popups)
   *  measures against THIS, never the sprite anchor — boulders anchor at
   *  their tile's top-left, pines at their trunk, and neither is the
   *  gameplay position. */
  cx: number;
  cy: number;
  /** Hex address — the stable identity used by world saves. */
  col: number;
  row: number;
  material: MaterialType;
  remaining: number;
};

/** What the minimap needs. Sampled on demand rather than pushed, because it
 *  redraws far more slowly than the world ticks. */
export type MinimapData = {
  seed: number;
  spawn: { col: number; row: number };
  centre: { col: number; row: number };
  players: { slot: Slot; col: number; row: number; color: number }[];
  built: { col: number; row: number }[];
  biome: BiomeType;
};

export class WorldScene extends Phaser.Scene {
  private seedText = "fabricator";
  private seed = 0;
  private players = new Map<Slot, PlayerEntity>();
  private vehicles: VehicleEntity[] = [];
  private obstacles!: Phaser.Physics.Arcade.StaticGroup;
  private cam2!: Phaser.Cameras.Scene2D.Camera;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private pad!: { x: number; y: number };
  private spawn = { col: 0, row: 0 };
  private fabFx: Phaser.GameObjects.GameObject[] = [];
  /** One night overlay per viewport: an endless world has no rectangle a
   *  single quad could cover, and the two cameras can be anywhere. */
  private darkness: Phaser.GameObjects.Rectangle[] = [];
  private spawnCount = 0;
  private field!: ChunkField;

  /** Arrow pointing at the other player, one per viewport. */
  private pointers = new Map<Slot, {
    container: Phaser.GameObjects.Container;
    arrow: Phaser.GameObjects.Triangle;
    label: Phaser.GameObjects.Text;
  }>();

  private nodeByHex = new Map<string, ResourceNode>();
  private nodesByChunk = new Map<ChunkKey, ResourceNode[]>();
  /** Nodes whose remaining count differs from the deterministic baseline —
   *  the only node state a save needs to carry. Survives chunk unload, which
   *  is what makes a worked-out grove stay worked out when you walk back. */
  private harvestDeltas = new Map<string, { col: number; row: number; remaining: number }>();
  /** biomeAt is pure but not free, and the sim asks about the same few hexes
   *  every frame. Bounded so an endless world can't grow an endless cache. */
  private biomeCache = new Map<string, BiomeType>();

  stockpile: Stockpile = { ...STARTING_STOCK };
  /** Screen shell subscribes for the HUD. */
  onStockpile: ((s: Stockpile) => void) | null = null;
  onToolEquipped: ((slot: Slot, spec: FabricatedSpec) => void) | null = null;
  /** Fired when a player boards or leaves a vehicle, for the HUD. */
  onRideChanged: ((slot: Slot, vehicle: string | null, driving: boolean) => void) | null =
    null;
  /** Fired when persistent state changed — the shell debounces a save. */
  onDirty: (() => void) | null = null;
  /** Fired once the scene exists and can accept a snapshot. */
  onReady: (() => void) | null = null;

  private markDirty() {
    this.onDirty?.();
  }

  constructor() {
    super("world");
  }

  init(data: { seed?: string }) {
    if (data.seed) this.seedText = data.seed;
    this.seed = worldSeed(this.seedText);
  }

  preload() {
    this.load.setPath("/assets/hex");
    for (const key of new Set([...BIOME_TILE_KEYS, ...DECOR_KEYS, ...SCATTER_KEYS])) {
      this.load.image(key, `${key}.png`);
    }
    this.load.setPath("/assets/aliens");
    for (const skin of Object.values(ALIEN_SKINS)) {
      for (const f of ALIEN_FRAMES) this.load.image(`${skin}_${f}`, `${skin}_${f}.png`);
    }
    this.load.setPath();
  }

  create() {
    // Dev/test hook: lets the harness inspect players and inject inputs.
    (window as unknown as { __world: WorldScene }).__world = this;

    makePadTexture(this);
    makePartTextures(this);
    makeParticleTextures(this);

    this.obstacles = this.physics.add.staticGroup();

    // ── the landing site ────────────────────────────────────────
    // Nothing is carved or cleared: findSpawn walks the field until it finds
    // ground that was already good, which is the endless world's version of
    // "generate a starting area".
    this.spawn = findSpawn(this.seed);
    const padWorld = hexToWorld(this.spawn.col, this.spawn.row);
    this.pad = { x: padWorld.x, y: padWorld.y };

    // ── terrain streaming ───────────────────────────────────────
    this.field = new ChunkField(this, this.seed, {
      onLoad: (cx, cy) => this.loadChunkNodes(cx, cy),
      onUnload: (cx, cy) => this.unloadChunkNodes(cx, cy),
    });

    this.add.image(this.pad.x, this.pad.y, "pad").setDepth(this.pad.y);

    // ── players (aliens: stand=down, walk=side, climb=up) ───────
    for (const skin of Object.values(ALIEN_SKINS)) {
      this.anims.create({
        key: `${skin}-walk`,
        frames: [{ key: `${skin}_walk1` }, { key: `${skin}_walk2` }],
        frameRate: 8,
        repeat: -1,
      });
      this.anims.create({
        key: `${skin}-climb`,
        frames: [{ key: `${skin}_climb1` }, { key: `${skin}_climb2` }],
        frameRate: 6,
        repeat: -1,
      });
    }
    const p1 = this.spawnPlayer(1, this.pad.x - 44, this.pad.y + 52, 0xf06eaa);
    const p2 = this.spawnPlayer(2, this.pad.x + 44, this.pad.y + 52, 0xffcf4d);
    this.physics.add.collider(p1.sprite, this.obstacles);
    this.physics.add.collider(p2.sprite, this.obstacles);
    this.physics.add.collider(p1.sprite, p2.sprite);

    // No edges to fall off. The bounds exist only because Arcade wants some,
    // and they sit far enough out that float precision gives up first.
    this.physics.world.setBounds(-2e6, -2e6, 4e6, 4e6);

    // ── split-screen cameras ────────────────────────────────────
    // Deliberately unbounded: setBounds would clamp scrolling to a rectangle,
    // which is exactly the thing this world no longer has.
    const cam1 = this.cameras.main;
    cam1.setZoom(CAMERA_ZOOM);
    cam1.startFollow(p1.sprite, true, 0.12, 0.12);
    cam1.setRoundPixels(true);

    this.cam2 = this.cameras.add();
    this.cam2.setZoom(CAMERA_ZOOM);
    this.cam2.startFollow(p2.sprite, true, 0.12, 0.12);
    this.cam2.setRoundPixels(true);

    this.layoutCameras();
    this.scale.on("resize", () => this.layoutCameras());

    this.buildPointers(cam1, this.cam2);

    // ── keyboard dev fallback ───────────────────────────────────
    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,F,G,UP,DOWN,LEFT,RIGHT,K,L",
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    // Night falls over each viewport separately: one quad per camera, resized
    // and repositioned to that camera's view every frame. A single world-space
    // rectangle can't work when the two players may be a continent apart.
    for (const slot of [1, 2] as const) {
      const quad = this.add
        .rectangle(0, 0, 10, 10, 0x0a1024)
        .setDepth(DEPTH_DARKNESS)
        .setAlpha(0);
      (slot === 1 ? this.cam2 : cam1).ignore(quad);
      this.darkness.push(quad);
    }

    // Prime the ground before the first frame so the world isn't empty on
    // arrival. startFollow doesn't move a camera until its first update, so
    // the cameras are pointed by hand first — otherwise both would still be
    // looking at the origin, and we'd stream in chunks nobody will see.
    cam1.centerOn(p1.sprite.x, p1.sprite.y);
    this.cam2.centerOn(p2.sprite.x, p2.sprite.y);
    cam1.preRender();
    this.cam2.preRender();
    for (let i = 0; i < 12; i++) this.field.update([cam1, this.cam2]);

    this.onStockpile?.(this.stockpile);
    this.onReady?.();
  }

  // ── terrain queries ───────────────────────────────────────────

  private biomeAtHex(col: number, row: number): BiomeType {
    const key = `${col},${row}`;
    let b = this.biomeCache.get(key);
    if (b === undefined) {
      b = biomeAt(col, row, this.seed);
      if (this.biomeCache.size > 4096) this.biomeCache.clear();
      this.biomeCache.set(key, b);
    }
    return b;
  }

  private biomeAtPoint(x: number, y: number): BiomeType {
    const h = worldToHex(x, y);
    return this.biomeAtHex(h.col, h.row);
  }

  private terrainAt(x: number, y: number): TerrainType {
    return terrainOf(this.biomeAtPoint(x, y));
  }

  /** Vertical offset of a hex's surface. Relief is per biome now: the sea
   *  sits in a basin, the bog a step down, bare rock a step up. */
  private dropAt(col: number, row: number): number {
    return dropFor(this.biomeAtHex(col, row));
  }

  // ── resource nodes, streamed with their chunk ─────────────────

  /**
   * Two art conventions in the pack, and they need different anchoring:
   *  • "boulder" is 65px wide — a full hex's worth of art, authored to be
   *    stamped at the tile's own top-left.
   *  • "pine" is a narrow prop that stands on the tile, with 8px of
   *    transparent padding below its trunk.
   * Collision is a separate invisible rect matched to the ground footprint,
   * so it can never drift from the art the way a body derived from a shifted
   * sprite origin does.
   */
  private loadChunkNodes(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    if (this.nodesByChunk.has(key)) return;
    const list: ResourceNode[] = [];

    for (let row = cy * CHUNK_ROWS; row < (cy + 1) * CHUNK_ROWS; row++) {
      for (let col = cx * CHUNK_COLS; col < (cx + 1) * CHUNK_COLS; col++) {
        if (inClearing(col, row, this.spawn)) continue;
        const biome = this.biomeAtHex(col, row);
        const entry = scatterAt(col, row, this.seed, biome);
        if (!entry) continue;

        const hex = `${col},${row}`;
        const delta = this.harvestDeltas.get(hex);
        if (delta && delta.remaining <= 0) continue; // worked out; stays gone
        const remaining = delta ? delta.remaining : entry.units;

        const c = hexToWorld(col, row);
        // Boulders are raised blocks. Sunk along with a lowered biome surface
        // they cut into the higher hexes at the border, so they sit at
        // un-dropped height — resting on the bog rather than in it.
        const drop = dropFor(biome);
        const cy2 = c.y + drop;

        let sprite: Phaser.GameObjects.Image;
        let bodyW: number;
        let bodyH: number;
        let bodyDY: number;
        if (entry.art === "boulder") {
          sprite = this.add
            .image(c.x - HEX_W / 2, c.y - 32, entry.texture)
            .setOrigin(0, 0);
          bodyW = 44;
          bodyH = 24;
          bodyDY = 6; // the boulder meets the ground just below hex center
        } else {
          sprite = this.add
            .image(c.x, cy2 + PINE_PAD, entry.texture)
            .setOrigin(0.5, 1);
          bodyW = 18;
          bodyH = 13; // trunk only — you can brush past the canopy
          bodyDY = 2;
        }
        sprite.setDepth(cy2);
        if (entry.tint) sprite.setTint(entry.tint);

        const blocker = this.add
          .rectangle(c.x, cy2 + bodyDY, bodyW, bodyH)
          .setVisible(false);
        this.physics.add.existing(blocker, true);
        this.obstacles.add(blocker);

        const material: MaterialType =
          entry.kind === "tree" ? "wood" : entry.kind === "rock" ? "stone" : "bogiron";
        const node: ResourceNode = {
          sprite,
          blocker,
          cx: c.x,
          cy: cy2,
          col,
          row,
          material,
          remaining,
        };
        list.push(node);
        this.nodeByHex.set(hex, node);
      }
    }
    this.nodesByChunk.set(key, list);
  }

  private unloadChunkNodes(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    const list = this.nodesByChunk.get(key);
    if (!list) return;
    for (const node of list) {
      this.nodeByHex.delete(`${node.col},${node.row}`);
      this.tweens.killTweensOf(node.sprite);
      node.sprite.destroy();
      node.blocker.destroy();
    }
    this.nodesByChunk.delete(key);
  }

  private spawnPlayer(slot: Slot, x: number, y: number, color: number): PlayerEntity {
    const skin = ALIEN_SKINS[slot];
    const sprite = this.physics.add.sprite(x, y, `${skin}_stand`);
    sprite.setScale(PLAYER_SCALE);
    sprite.setCollideWorldBounds(true);
    // body in texture pixels (frame ~66×92): a small box at the feet
    sprite.body!.setSize(40, 26);
    sprite.body!.setOffset(13, 62);

    const label = this.add
      .text(x, y, `P${slot}`, {
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        fontStyle: "bold",
        color: "#ffffff",
        backgroundColor: "rgba(0,0,0,0.35)",
        padding: { x: 4, y: 1 },
      })
      .setOrigin(0.5, 1)
      .setDepth(1e6);

    const entity: PlayerEntity = {
      slot,
      skin,
      sprite,
      label,
      net: idleInput(),
      prevA: false,
      color,
      driving: null,
      tool: null,
      nextHarvestAt: 0,
    };
    this.players.set(slot, entity);
    return entity;
  }

  /**
   * One arrow per viewport, pointing at the *other* player. Each is hidden
   * from the camera it isn't for — otherwise both would appear in both halves
   * of the split screen, each pointing at the wrong person.
   */
  private buildPointers(
    cam1: Phaser.Cameras.Scene2D.Camera,
    cam2: Phaser.Cameras.Scene2D.Camera,
  ): void {
    for (const slot of [1, 2] as const) {
      const other = slot === 1 ? 2 : 1;
      const color = other === 1 ? 0xf06eaa : 0xffcf4d;
      const arrow = this.add
        .triangle(0, 0, 0, -13, 12, 11, -12, 11, color)
        .setStrokeStyle(2, 0x0d1420, 0.85);
      const label = this.add
        .text(0, 20, "", {
          fontFamily: "system-ui, sans-serif",
          fontSize: "10px",
          fontStyle: "bold",
          color: "#e8f0fb",
          backgroundColor: "rgba(8,14,26,0.6)",
          padding: { x: 4, y: 1 },
        })
        .setOrigin(0.5, 0.5);
      const container = this.add
        .container(0, 0, [arrow, label])
        .setDepth(DEPTH_POINTER)
        .setVisible(false);
      // Constant on-screen size regardless of camera zoom.
      container.setScale(1 / CAMERA_ZOOM);
      (slot === 1 ? cam2 : cam1).ignore(container);
      this.pointers.set(slot, { container, arrow, label });
    }
  }

  private layoutCameras() {
    const w = this.scale.width;
    const h = this.scale.height;
    this.cameras.main.setViewport(0, 0, Math.floor(w / 2), h);
    this.cam2.setViewport(Math.floor(w / 2), 0, Math.ceil(w / 2), h);
  }

  /** Called by the screen shell when a controller input arrives. */
  setInput(slot: Slot, input: PlayerInput) {
    const p = this.players.get(slot);
    if (p) p.net = input;
  }

  setNickname(slot: Slot, nickname: string) {
    const p = this.players.get(slot);
    if (p) p.label.setText(nickname || `P${slot}`);
  }

  // ── stockpile ─────────────────────────────────────────────────

  private addStock(material: MaterialType, amount: number) {
    this.stockpile[material] += amount;
    this.onStockpile?.(this.stockpile);
    this.markDirty();
  }

  /** Remove a node from the world (harvested out, or restored as gone). */
  private removeNode(node: ResourceNode, animate: boolean) {
    this.nodeByHex.delete(`${node.col},${node.row}`);
    const { cx, cy } = chunkOfHex(node.col, node.row);
    const list = this.nodesByChunk.get(chunkKey(cx, cy));
    if (list) {
      const i = list.indexOf(node);
      if (i >= 0) list.splice(i, 1);
    }
    node.blocker.destroy(); // frees the hex for walking immediately
    if (!animate) {
      node.sprite.destroy();
      return;
    }
    this.tweens.add({
      targets: node.sprite,
      alpha: 0,
      scale: 0.6,
      duration: 250,
      onComplete: () => node.sprite.destroy(),
    });
  }

  // ── Fabricator ────────────────────────────────────────────────

  /** Diegetic fabrication time: the pad hums while the compile runs. */
  setFabricating(name: string) {
    this.clearFabricating();
    const ring = this.add
      .circle(this.pad.x, this.pad.y + 8, 20)
      .setStrokeStyle(3, 0x6c9ef8)
      .setDepth(1e6);
    this.tweens.add({
      targets: ring,
      radius: 46,
      alpha: { from: 1, to: 0 },
      duration: 900,
      repeat: -1,
      ease: "Cubic.easeOut",
    });
    const text = this.add
      .text(this.pad.x, this.pad.y - 46, `FABRICATING: ${name}…`, {
        fontFamily: "system-ui, sans-serif",
        fontSize: "12px",
        fontStyle: "bold",
        color: "#8fc1ff",
        backgroundColor: "rgba(0,0,0,0.45)",
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5, 1)
      .setDepth(1e6);
    this.fabFx = [ring, text];
  }

  clearFabricating() {
    for (const fx of this.fabFx) {
      this.tweens.killTweensOf(fx); // the ring tween repeats forever
      fx.destroy();
    }
    this.fabFx = [];
  }

  /**
   * Manufacture a Design: charge the bill and materialize it. Returns an
   * error string if the team can't afford it (nothing spawned or charged).
   */
  tryFabricate(design: PlaceableDesign, bySlot: Slot): string | null {
    this.clearFabricating();
    const { spec } = design;
    if (!canAfford(this.stockpile, spec.cost)) {
      return `Not enough materials for ${spec.displayName} — needs ${formatCost(spec.cost)}.`;
    }
    this.stockpile.wood -= spec.cost.wood;
    this.stockpile.stone -= spec.cost.stone;
    this.stockpile.bogiron -= spec.cost.bogiron;
    this.onStockpile?.(this.stockpile);
    this.placeDesign(design, bySlot);
    return null;
  }

  /** Put a design into the world without charging for it — the shared path
   *  for manufacturing and for restoring a saved world. Textures are keyed
   *  by design id, so repeat builds of one design share a single texture
   *  and the art is only fetched once. */
  private placeDesign(design: PlaceableDesign, bySlot: Slot, x?: number, y?: number) {
    const key = `fab-body-${design.id}`;
    const build = () => {
      if (design.spec.category === "tool") this.equipTool(design, key, bySlot);
      else this.buildVehicle(design, key, x, y);
      this.markDirty();
    };
    const placeholder = () => {
      if (!this.textures.exists(key)) {
        const g = this.add.graphics();
        g.fillStyle(0x8b98a9, 1);
        g.fillRoundedRect(0, 0, 64, 40, 8);
        g.generateTexture(key, 64, 40);
        g.destroy();
      }
      build();
    };

    if (this.textures.exists(key)) {
      build();
    } else if (design.artUrl) {
      this.load.image(key, design.artUrl);
      this.load.once(`filecomplete-image-${key}`, build);
      this.load.once(`loaderror`, (file: { key: string }) => {
        if (file.key === key) {
          console.warn("sprite failed to load, using placeholder:", design.artUrl);
          placeholder();
        }
      });
      this.load.start();
    } else {
      placeholder();
    }
  }

  /** Hand tools attach to the player who blueprinted them. */
  private equipTool(design: PlaceableDesign, bodyKey: string, bySlot: Slot) {
    const spec = design.spec;
    const p = this.players.get(bySlot) ?? this.players.get(1)!;
    if (p.tool) {
      p.tool.icon.destroy();
      p.tool.glow?.destroy();
    }
    const icon = this.add.image(p.sprite.x, p.sprite.y - 34, bodyKey).setDepth(1e6);
    const scale = 22 / Math.max(icon.width, icon.height);
    icon.setScale(scale);
    let glow: Phaser.GameObjects.Image | undefined;
    if (spec.emission?.kind === "light") {
      glow = this.add
        .image(p.sprite.x, p.sprite.y, "glow")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.8 + spec.emission.intensity * 1.5)
        .setDepth(DEPTH_LIGHT);
    }
    p.tool = { designId: design.id, spec, icon, glow };
    this.onToolEquipped?.(p.slot, spec);
    this.materializeFlash(p.sprite.x, p.sprite.y, 40);
  }

  private buildVehicle(
    design: PlaceableDesign,
    bodyKey: string,
    atX?: number,
    atY?: number,
  ) {
    const spec = design.spec;
    const { w, h } = spec.size;
    let x = atX ?? this.pad.x + 110 + (this.spawnCount % 3) * 30;
    let y = atY ?? this.pad.y + 60 + Math.floor(this.spawnCount / 3) * 30;
    if (atX === undefined) this.spawnCount++;
    // Structures live on the hex grid — snap to the nearest hex center.
    // (Future: 6-edge connections to neighboring structures.)
    if (spec.category !== "vehicle" && atX === undefined) {
      const hex = worldToHex(x, y);
      const c = hexToWorld(hex.col, hex.row);
      x = c.x;
      y = c.y + this.dropAt(hex.col, hex.row);
    }

    const body = this.add.image(0, 0, bodyKey);
    body.setDisplaySize(w, h);

    // Vehicles are generated complete (running gear and all), so library
    // parts would double up on the art. Structures still get theirs — lamps
    // and chimneys pair with the emission effects rather than duplicating
    // the silhouette.
    const parts =
      spec.category === "vehicle"
        ? []
        : spec.anchors.map((a) => {
            const img = this.add.image(a.x * w, a.y * h, `part-${a.part}`);
            return { img, kind: a.part, baseY: a.y * h };
          });

    const label = this.add
      .text(0, -h / 2 - 6, spec.displayName, {
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        fontStyle: "bold",
        color: "#dfe8f4",
        backgroundColor: "rgba(0,0,0,0.4)",
        padding: { x: 4, y: 1 },
      })
      .setOrigin(0.5, 1);

    const children: Phaser.GameObjects.GameObject[] = [body, ...parts.map((p) => p.img)];
    children.push(label);

    const container = this.add.container(x, y, children);
    container.setDepth(y);
    this.physics.add.existing(container);
    const bodyPhys = container.body as Phaser.Physics.Arcade.Body;
    bodyPhys.setSize(w, h);
    bodyPhys.setOffset(-w / 2, -h / 2);
    bodyPhys.setCollideWorldBounds(true);
    if (spec.category !== "vehicle") bodyPhys.setImmovable(true);
    this.physics.add.collider(container, this.obstacles);

    const vehicle: VehicleEntity = {
      designId: design.id,
      container,
      bodyImg: body,
      parts,
      spec,
      mods: normalizeModifiers(spec.locomotion.terrainModifiers, spec.locomotion.type),
      driver: null,
      passenger: null,
      nextHarvestAt: 0,
    };

    if (spec.emission?.kind === "smoke") {
      const chimney = spec.anchors.find((a) => a.part === "chimney");
      const em = this.add.particles(0, 0, "puff", {
        speedY: { min: -30, max: -14 },
        speedX: { min: -6, max: 6 },
        scale: { start: 0.7 + spec.emission.intensity, end: 2 },
        alpha: { start: 0.7, end: 0 },
        lifespan: 1200,
        frequency: 320 - spec.emission.intensity * 220,
      });
      em.startFollow(container, chimney ? chimney.x * w : 0, (chimney ? chimney.y * h : -h / 2) - 6);
      em.setDepth(1e6 - 2);
      if (spec.category === "vehicle") em.stop();
      vehicle.smoke = em;
    }
    if (spec.emission?.kind === "sparks") {
      const em = this.add.particles(0, 0, "spark", {
        speed: { min: 30, max: 90 },
        scale: { start: 1, end: 0 },
        lifespan: 350,
        frequency: 260 - spec.emission.intensity * 180,
      });
      em.startFollow(container);
      em.setDepth(1e6 - 2);
      if (spec.category === "vehicle") em.stop();
      vehicle.sparks = em;
    }

    if (spec.emission?.kind === "light") {
      const lamp = spec.anchors.find((a) => a.part === "lamp");
      vehicle.glowOffset = { x: lamp ? lamp.x * w : 0, y: lamp ? lamp.y * h : 0 };
      vehicle.glow = this.add
        .image(x + vehicle.glowOffset.x, y + vehicle.glowOffset.y, "glow")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.9 + spec.emission.intensity * 1.8)
        .setDepth(DEPTH_LIGHT);
    }

    this.vehicles.push(vehicle);
    this.materializeFlash(x, y, Math.max(w, h));
  }

  private materializeFlash(x: number, y: number, radius: number) {
    const flash = this.add.circle(x, y, 10, 0x8fc1ff, 0.7).setDepth(1e6);
    this.tweens.add({
      targets: flash,
      radius,
      alpha: 0,
      duration: 500,
      onComplete: () => flash.destroy(),
    });
  }

  // ── harvesting ────────────────────────────────────────────────

  /**
   * Nearest node within range. Looks up the hexes around the point rather
   * than scanning every node: in an endless world the resident node count
   * grows with view distance, and this has to stay O(1).
   */
  private nearestNode(x: number, y: number, range: number): ResourceNode | null {
    const h = worldToHex(x, y);
    const spanCol = Math.ceil(range / HEX_W) + 1;
    const spanRow = Math.ceil(range / ROW_H) + 1;
    let best: ResourceNode | null = null;
    let bestDist = Infinity;
    for (let dr = -spanRow; dr <= spanRow; dr++) {
      for (let dc = -spanCol; dc <= spanCol; dc++) {
        const node = this.nodeByHex.get(`${h.col + dc},${h.row + dr}`);
        if (!node) continue;
        const d = Phaser.Math.Distance.Between(x, y, node.cx, node.cy);
        if (d < range && d < bestDist) {
          best = node;
          bestDist = d;
        }
      }
    }
    return best;
  }

  /** One gathering tick: take 1 unit if allowed. Returns true on success. */
  private harvestHit(node: ResourceNode, materials: MaterialType[]): boolean {
    if (!materials.includes(node.material)) return false;
    node.remaining -= 1;
    this.harvestDeltas.set(`${node.col},${node.row}`, {
      col: node.col,
      row: node.row,
      remaining: Math.max(0, node.remaining),
    });
    this.addStock(node.material, 1);

    this.tweens.add({ targets: node.sprite, scale: { from: 1.12, to: 1 }, duration: 120 });
    this.floatText(node.cx, node.cy - 40, `+1 ${node.material}`, "#c9e77f");

    if (node.remaining <= 0) this.removeNode(node, true);
    return true;
  }

  // ── save / restore ────────────────────────────────────────────
  //
  // Terrain is a pure function of the room code, so a save carries only what
  // diverges from it: the stockpile, the hexes that have been worked, and
  // what has been built.

  snapshot(): WorldSnapshot {
    return {
      v: 2,
      seed: this.seedText,
      stockpile: { ...this.stockpile },
      harvested: [...this.harvestDeltas.values()],
      built: this.vehicles.map((v) => ({
        designId: v.designId,
        x: Math.round(v.container.x),
        y: Math.round(v.container.y),
      })),
      tools: [...this.players.values()]
        .filter((p) => p.tool)
        .map((p) => ({ slot: p.slot, designId: p.tool!.designId })),
    };
  }

  /** Apply a saved world over the generated terrain. `resolve` looks up a
   *  Design by id (the catalog arrives on the same socket). */
  applySnapshot(
    snap: WorldSnapshot,
    resolve: (designId: string) => PlaceableDesign | null,
  ): void {
    this.stockpile = { ...snap.stockpile };
    this.onStockpile?.(this.stockpile);

    for (const h of snap.harvested) {
      const key = `${h.col},${h.row}`;
      this.harvestDeltas.set(key, h);
      // Only chunks currently resident have a node to correct; the rest is
      // applied by loadChunkNodes when they stream in.
      const node = this.nodeByHex.get(key);
      if (!node) continue;
      if (h.remaining <= 0) this.removeNode(node, false);
      else node.remaining = h.remaining;
    }

    for (const b of snap.built) {
      const design = resolve(b.designId);
      if (design) this.placeDesign(design, 1, b.x, b.y);
    }
    for (const t of snap.tools) {
      const design = resolve(t.designId);
      if (design) this.placeDesign(design, t.slot);
    }
  }

  private floatText(x: number, y: number, text: string, color: string) {
    const t = this.add
      .text(x, y, text, {
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        fontStyle: "bold",
        color,
      })
      .setOrigin(0.5, 1)
      .setDepth(1e6);
    this.tweens.add({
      targets: t,
      y: y - 26,
      alpha: 0,
      duration: 800,
      ease: "Cubic.easeOut",
      onComplete: () => t.destroy(),
    });
  }

  // ── input & simulation ────────────────────────────────────────

  private keyboardInput(slot: Slot): PlayerInput | null {
    const k = this.keys;
    if (!k) return null;
    const [up, down, left, right, a, b] =
      slot === 1
        ? [k.W, k.S, k.A, k.D, k.F, k.G]
        : [k.UP, k.DOWN, k.LEFT, k.RIGHT, k.K, k.L];
    const x = (right.isDown ? 1 : 0) - (left.isDown ? 1 : 0);
    const y = (down.isDown ? 1 : 0) - (up.isDown ? 1 : 0);
    if (!x && !y && !a.isDown && !b.isDown) return null;
    const len = Math.hypot(x, y) || 1;
    return {
      stick: { x: x / len, y: y / len },
      buttons: { a: a.isDown, b: b.isDown },
    };
  }

  /** 4-direction animation from platformer frames: stand=down, walk=side
   *  (flipped for left), climb=up. */
  private animatePlayer(p: PlayerEntity, sx: number, sy: number, moving: boolean) {
    const s = p.sprite;
    if (!moving) {
      s.stop();
      s.setTexture(`${p.skin}_stand`);
      return;
    }
    if (Math.abs(sx) >= Math.abs(sy)) {
      s.setFlipX(sx < 0);
      s.play(`${p.skin}-walk`, true);
    } else if (sy < 0) {
      s.setFlipX(false);
      s.play(`${p.skin}-climb`, true);
    } else {
      s.setFlipX(false);
      s.stop();
      s.setTexture(`${p.skin}_stand`);
      s.setAngle(Math.sin(this.time.now / 70) * 4);
      return;
    }
    s.setAngle(0);
  }

  update() {
    const now = this.time.now;

    // Day/night. Dawn and dusk get most of the curve so the transition reads
    // as a sunset rather than a light switch.
    const t = (now % DAY_MS) / DAY_MS; // 0 = dawn, 0.5 = dusk
    const night = (1 - Math.cos(t * Math.PI * 2)) / 2; // 0 at noon, 1 at midnight
    const gloom = night * night * NIGHT_ALPHA;
    const cams = [this.cameras.main, this.cam2];
    for (let i = 0; i < this.darkness.length; i++) {
      const v = cams[i].worldView;
      // A hair oversized: rounding at the viewport edge otherwise leaves a
      // bright one-pixel seam along the split.
      this.darkness[i]
        .setPosition(v.centerX, v.centerY)
        .setSize(v.width + 4, v.height + 4)
        .setAlpha(gloom);
    }

    for (const v of this.vehicles) {
      if (!v.glow || !v.glowOffset) continue;
      v.glow.setPosition(v.container.x + v.glowOffset.x, v.container.y + v.glowOffset.y);
      // A lamp is invisible at noon and full strength at midnight.
      v.glow.setAlpha(0.25 + night * 0.75);
    }
    for (const p of this.players.values()) {
      const input = this.keyboardInput(p.slot) ?? p.net;
      const aEdge = input.buttons.a && !p.prevA;
      p.prevA = input.buttons.a;

      if (p.driving) {
        // Only whoever has the wheel steers; a passenger just rides along
        // (their camera follows their sprite, so it has to track the ride).
        if (p.driving.driver === p.slot) {
          this.driveVehicle(p, p.driving, input, now);
        } else {
          p.sprite.setPosition(p.driving.container.x, p.driving.container.y);
        }
        if (aEdge) this.exitVehicle(p);
        continue;
      }

      // on foot
      const feet = (p.sprite.body as Phaser.Physics.Arcade.Body).center;
      // Stranded = standing somewhere nothing on foot belongs (stepped off a
      // raft, or the ground changed under a restored save). Then every
      // direction stays open at a wading pace, so you can never be trapped.
      const stranded = !this.walkable(feet.x, feet.y);
      const mod = stranded ? 0.5 : WALK_MODS[this.terrainAt(feet.x, feet.y)];
      const speed = WALK_SPEED * mod * (input.buttons.b ? SPRINT_MULT : 1);
      const [vx, vy] = stranded
        ? [input.stick.x * speed, input.stick.y * speed]
        : this.slideAlongShore(feet, input.stick, speed);
      p.sprite.setVelocity(vx, vy);

      const moving = Math.hypot(input.stick.x, input.stick.y) > 0.1;
      this.animatePlayer(p, input.stick.x, input.stick.y, moving);

      // A near a node = gather (hold). Otherwise A-edge = enter / ping.
      const node = this.nearestNode(p.sprite.x, p.sprite.y, HARVEST_RANGE);
      if (node && input.buttons.a) {
        const rate = p.tool?.spec.harvest?.rate ?? HAND_RATE;
        const materials = p.tool?.spec.harvest?.materials ?? HAND_MATERIALS;
        if (now >= p.nextHarvestAt) {
          const hit = this.harvestHit(node, materials);
          if (!hit) {
            this.floatText(node.cx, node.cy - 40, "needs a better tool", "#ff9f9f");
            p.nextHarvestAt = now + 700;
          } else {
            p.nextHarvestAt = now + 1000 / rate;
          }
        }
      } else if (aEdge) {
        const vehicle = this.nearestEnterableVehicle(p);
        if (vehicle) this.enterVehicle(p, vehicle);
        else this.ping(p);
      }

      p.sprite.setDepth(p.sprite.y);
      p.label.setPosition(p.sprite.x, p.sprite.y - p.sprite.displayHeight + 6);
      if (p.tool) {
        p.tool.icon.setPosition(p.sprite.x + 16, p.sprite.y - 26);
        p.tool.glow?.setPosition(p.sprite.x, p.sprite.y);
        // a carried lamp earns its keep after dark, same as a vehicle's
        p.tool.glow?.setAlpha(0.25 + night * 0.75);
      }
    }

    this.runAutomation(now);
    this.updatePointers();
    // Last: the cameras have finished following by now, so the chunks we
    // stream are the ones about to be on screen rather than last frame's.
    this.field.update(cams);
  }

  /** Can a walker stand here? */
  private walkable(x: number, y: number): boolean {
    return !isLiquid(this.biomeAtPoint(x, y));
  }

  /**
   * Turn a stick direction into a velocity that follows the water's edge.
   *
   * Gating each axis independently is the obvious approach and it doesn't
   * work: hexes tile diagonally, so on a diagonal coastline the hex due east
   * can be dry while the one to the south-east is sea, and an axis gate
   * refuses the move entirely. You end up glued to the beach, shuffling.
   *
   * Instead: if the way you're pointing is blocked, try a fan of nearby
   * headings and take the open one closest to your intent, at the cosine of
   * how far it had to bend. That reads as sliding along the shore, which is
   * what a person walking a beach actually does.
   */
  private slideAlongShore(
    feet: Phaser.Math.Vector2,
    stick: StickState,
    speed: number,
  ): [number, number] {
    const len = Math.hypot(stick.x, stick.y);
    if (len < 0.05) return [0, 0];

    const base = Math.atan2(stick.y, stick.x);
    const open = (angle: number) =>
      this.walkable(
        feet.x + Math.cos(angle) * WALK_PROBE,
        feet.y + Math.sin(angle) * WALK_PROBE,
      );

    // 0 first, so unobstructed walking costs exactly one lookup.
    for (const bend of SHORE_FAN) {
      const angle = base + bend;
      if (!open(angle)) continue;
      const v = speed * len * Math.cos(bend);
      return [Math.cos(angle) * v, Math.sin(angle) * v];
    }
    return [0, 0]; // hemmed in on every side — the shore wins
  }

  /**
   * The partner arrow: only when they're close enough to be worth walking to,
   * and only when they aren't already on screen. Both conditions matter —
   * an arrow that's always up stops being information.
   */
  private updatePointers(): void {
    const cams: Record<Slot, Phaser.Cameras.Scene2D.Camera> = {
      1: this.cameras.main,
      2: this.cam2,
    };
    for (const slot of [1, 2] as const) {
      const ui = this.pointers.get(slot)!;
      const self = this.players.get(slot);
      const other = this.players.get(slot === 1 ? 2 : 1);
      if (!self || !other) {
        ui.container.setVisible(false);
        continue;
      }
      const cam = cams[slot];
      const v = cam.worldView;
      const d = Phaser.Math.Distance.Between(
        self.sprite.x,
        self.sprite.y,
        other.sprite.x,
        other.sprite.y,
      );
      const onScreen = v.contains(other.sprite.x, other.sprite.y);
      if (d > POINTER_RANGE || onScreen) {
        ui.container.setVisible(false);
        continue;
      }

      // Ride the inside edge of the viewport, on the ray from the centre of
      // this camera's view toward the other player.
      const inset = POINTER_INSET / cam.zoom;
      const cx = v.centerX;
      const cy = v.centerY;
      const dx = other.sprite.x - cx;
      const dy = other.sprite.y - cy;
      const halfW = Math.max(1, v.width / 2 - inset);
      const halfH = Math.max(1, v.height / 2 - inset);
      const k = Math.min(
        dx === 0 ? Infinity : halfW / Math.abs(dx),
        dy === 0 ? Infinity : halfH / Math.abs(dy),
      );
      ui.container.setPosition(cx + dx * k, cy + dy * k);
      ui.arrow.setRotation(Math.atan2(dy, dx) + Math.PI / 2);
      ui.label.setText(`${Math.round(d / HEX_W)}`);
      // Fade with distance: a faint arrow means "far", without a number.
      ui.container.setAlpha(1 - (d / POINTER_RANGE) * 0.45);
      ui.container.setVisible(true);
    }
  }

  /**
   * Structures that can harvest work their own patch, unattended — the first
   * automation in the game. Deliberately slower than doing it by hand: the
   * trade is that it keeps going while you're somewhere else.
   */
  private runAutomation(now: number) {
    for (const v of this.vehicles) {
      const hv = v.spec.harvest;
      if (!hv || v.spec.category !== "structure") continue;
      if (now < v.nextHarvestAt) continue;
      const reach = Math.max(v.spec.size.w, v.spec.size.h) / 2 + AUTOMATION_REACH;
      const node = this.nearestNode(v.container.x, v.container.y, reach);
      if (!node || !hv.materials.includes(node.material)) {
        v.nextHarvestAt = now + 1200; // nothing in reach — check back shortly
        continue;
      }
      this.harvestHit(node, hv.materials);
      v.nextHarvestAt = now + 1000 / (hv.rate * AUTOMATION_RATE);
      // a visible tick so you can tell it's earning its keep
      for (const part of v.parts) {
        if (part.kind === "drill") part.img.setAngle(part.img.angle === 0 ? 12 : 0);
      }
    }
  }

  private nearestEnterableVehicle(p: PlayerEntity): VehicleEntity | null {
    let best: VehicleEntity | null = null;
    let bestDist = Infinity;
    for (const v of this.vehicles) {
      if (v.spec.category !== "vehicle") continue;
      // Free seat? The driver's, or the passenger's on a two-seater.
      const seats = Math.max(1, v.spec.seats);
      const taken = (v.driver !== null ? 1 : 0) + (v.passenger !== null ? 1 : 0);
      if (taken >= seats) continue;
      const d = Phaser.Math.Distance.Between(
        p.sprite.x,
        p.sprite.y,
        v.container.x,
        v.container.y,
      );
      const range = ENTER_RANGE + Math.max(v.spec.size.w, v.spec.size.h) / 2;
      if (d < range && d < bestDist) {
        best = v;
        bestDist = d;
      }
    }
    return best;
  }

  private enterVehicle(p: PlayerEntity, v: VehicleEntity) {
    p.driving = v;
    if (v.driver === null) {
      v.driver = p.slot;
      if (v.spec.emission?.kind === "smoke") v.smoke?.start();
      if (v.spec.emission?.kind === "sparks") v.sparks?.start();
    } else {
      v.passenger = p.slot;
    }
    this.onRideChanged?.(p.slot, v.spec.displayName, v.driver === p.slot);
    p.sprite.setVisible(false);
    p.label.setVisible(false);
    if (p.tool) {
      p.tool.icon.setVisible(false);
      p.tool.glow?.setVisible(false);
    }
    (p.sprite.body as Phaser.Physics.Arcade.Body).enable = false;
  }

  private exitVehicle(p: PlayerEntity) {
    const v = p.driving!;
    const wasDriver = v.driver === p.slot;
    if (wasDriver) {
      const vb = v.container.body as Phaser.Physics.Arcade.Body;
      vb.setVelocity(0, 0);
      // engine off — settle the body back to rest
      v.bodyImg.setPosition(0, 0);
      v.bodyImg.setAngle(0);
      v.driver = null;
      v.smoke?.stop();
      v.sparks?.stop();
      this.markDirty(); // it was driven somewhere — persist where it ended up
    } else {
      v.passenger = null;
    }
    p.driving = null;
    this.onRideChanged?.(p.slot, null, false);

    // Step out to the side a passenger vacates, so the two don't stack — but
    // never step out into the sea. If both sides are wet you stay aboard the
    // hull that got you there.
    const prefer = wasDriver ? 1 : -1;
    const candidates = [prefer, -prefer].map((side) => ({
      x: v.container.x + side * (v.spec.size.w / 2 + 16),
      y: v.container.y + v.spec.size.h / 2 + 12,
    }));
    const spot = candidates.find((c) => this.walkable(c.x, c.y));
    if (!spot) {
      // Nowhere dry alongside: stay in the seat rather than drown.
      p.driving = v;
      if (wasDriver) v.driver = p.slot;
      else v.passenger = p.slot;
      this.onRideChanged?.(p.slot, v.spec.displayName, v.driver === p.slot);
      this.floatText(v.container.x, v.container.y - 30, "no dry ground", "#ff9f9f");
      return;
    }
    p.sprite.setPosition(spot.x, spot.y);
    p.sprite.setVisible(true);
    p.label.setVisible(true);
    if (p.tool) {
      p.tool.icon.setVisible(true);
      p.tool.glow?.setVisible(true);
    }
    (p.sprite.body as Phaser.Physics.Arcade.Body).enable = true;
  }

  private driveVehicle(p: PlayerEntity, v: VehicleEntity, input: PlayerInput, now: number) {
    const body = v.container.body as Phaser.Physics.Arcade.Body;
    const terrain = this.terrainAt(v.container.x, v.container.y);
    const mod = v.mods[terrain] ?? 0;
    const speed = v.spec.locomotion.speed * mod;
    let vx = input.stick.x * speed;
    let vy = input.stick.y * speed;

    // A machine can't enter ground its spec rates at zero — that's what makes
    // a raft the only way across the water, and a wheeled buggy stop at it.
    // Probed per axis at that axis's own half-extent: using max(w,h) for both
    // would have a long vehicle refusing to drive within half its *length* of
    // a shoreline it is nowhere near touching.
    const canEnter = (x: number, y: number) =>
      (v.mods[this.terrainAt(x, y)] ?? 0) > IMPASSABLE;
    if (mod > IMPASSABLE) {
      const aheadX = v.spec.size.w / 2 + 4;
      const aheadY = v.spec.size.h / 2 + 4;
      if (vx && !canEnter(v.container.x + Math.sign(vx) * aheadX, v.container.y)) vx = 0;
      if (vy && !canEnter(v.container.x, v.container.y + Math.sign(vy) * aheadY)) vy = 0;
    }
    body.setVelocity(vx, vy);
    v.container.setDepth(v.container.y);

    // keep the (hidden) player and their camera glued to the vehicle
    p.sprite.setPosition(v.container.x, v.container.y);

    // machine harvesters chew through any node they touch, hands-free
    const hv = v.spec.harvest;
    let harvesting = false;
    if (hv) {
      const node = this.nearestNode(
        v.container.x,
        v.container.y,
        Math.max(v.spec.size.w, v.spec.size.h) / 2 + 26,
      );
      if (node && hv.materials.includes(node.material)) {
        harvesting = true;
        if (now >= v.nextHarvestAt) {
          this.harvestHit(node, hv.materials);
          v.nextHarvestAt = now + 1000 / hv.rate;
        }
      }
    }

    // Facing: art is generated nose-right, so driving left just mirrors it.
    // Only horizontal intent flips it — steering straight up or down keeps
    // whichever way it was already pointing, instead of snapping about.
    if (body.velocity.x < -FLIP_DEADZONE) v.bodyImg.setFlipX(true);
    else if (body.velocity.x > FLIP_DEADZONE) v.bodyImg.setFlipX(false);

    // Engine vibration: the body shakes in place (never the container, which
    // physics owns). Idling shakes a little, driving shakes more — this is
    // what sells "running" now that wheels are baked into the art.
    const vel = Math.hypot(body.velocity.x, body.velocity.y);
    const shake = 0.5 + Math.min(1, vel / 180) * 1.1;
    v.bodyImg.setPosition(
      Math.sin(now / 23) * shake * 0.6,
      Math.sin(now / 17) * shake,
    );
    v.bodyImg.setAngle(Math.sin(now / 31) * shake * 0.5);

    // part animation (structures only — vehicles carry no library parts)
    for (const part of v.parts) {
      switch (part.kind) {
        case "wheel":
          part.img.rotation += (vel / 26) * 0.06 * (body.velocity.x >= 0 ? 1 : -1);
          break;
        case "drill":
          part.img.setAngle(vel > 5 || harvesting ? Math.sin(now / 25) * 10 : 0);
          break;
        case "track":
          if (vel > 5) part.img.y = part.baseY + Math.sin(now / 45) * 1;
          break;
        case "chimney":
        case "lamp":
          break;
        default:
          if (vel > 5) part.img.y = part.baseY + Math.sin(now / 90) * 2;
      }
    }
  }

  private ping(p: PlayerEntity) {
    const circle = this.add
      .circle(p.sprite.x, p.sprite.y, 12)
      .setStrokeStyle(3, p.color)
      .setDepth(1e6);
    this.tweens.add({
      targets: circle,
      radius: 64,
      alpha: 0,
      duration: 450,
      ease: "Cubic.easeOut",
      onComplete: () => circle.destroy(),
    });
  }

  // ── minimap ───────────────────────────────────────────────────

  /** Sampled by the HUD a few times a second — cheap, and never allocates
   *  anything the scene keeps. */
  minimapData(): MinimapData {
    const players = [...this.players.values()].map((p) => {
      const h = worldToHex(p.sprite.x, p.sprite.y);
      return { slot: p.slot, col: h.col, row: h.row, color: p.color };
    });
    const midX = players.reduce((s, p) => s + p.col, 0) / (players.length || 1);
    const midY = players.reduce((s, p) => s + p.row, 0) / (players.length || 1);
    const first = this.players.get(1);
    return {
      seed: this.seed,
      spawn: this.spawn,
      centre: { col: Math.round(midX), row: Math.round(midY) },
      players,
      built: this.vehicles
        .filter((v) => v.spec.category !== "vehicle")
        .map((v) => worldToHex(v.container.x, v.container.y)),
      biome: first
        ? this.biomeAtPoint(first.sprite.x, first.sprite.y)
        : "grass",
    };
  }

  /** Human name of the ground a player is standing on, for the HUD. */
  biomeLabel(slot: Slot): string {
    const p = this.players.get(slot);
    if (!p) return "";
    return BIOMES[this.biomeAtPoint(p.sprite.x, p.sprite.y)].label;
  }
}
