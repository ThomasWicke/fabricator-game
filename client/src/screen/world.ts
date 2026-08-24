// The shared world scene. Host-authoritative: this scene IS the simulation.
// Controllers only feed inputs in via setInput(); keyboard on the screen
// itself works as a dev fallback (P1: WASD + F/G, P2: arrows + K/L).
//
// Split-screen: two cameras over one world, one per player (DST-couch-co-op
// style), fixed vertical split for now.
//
// Terrain is a hexagonal grid (Kenney iso-hex tiles, CC0) stamped once into
// a static RenderTexture. Play is continuous — entities move freely in
// pixels — but terrain lookup and structure placement are hexagonal, and
// hexgrid.ts already knows each hex's 6 neighbors: the foundation for
// connecting fabricated structures into production lines later.
//
// Biomes: grass, sand beach (west), and the purple "bog" band (east) whose
// TerrainType is "swamp" — bogiron deposits only spawn there.
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
import { canAfford, formatCost } from "../../../shared/fabricator/cost";
import {
  HEX_W,
  ROW_H,
  hexImageTopLeft,
  hexToWorld,
  worldToHex,
} from "./hexgrid";
import {
  makePadTexture,
  makePartTextures,
  makeParticleTextures,
  mulberry32,
} from "./textures";

const COLS = 50;
const ROWS = 64;
const WORLD_W = COLS * HEX_W + HEX_W / 2;
// last row's slab side must fit: (ROWS-1)·ROW_H + full image height
const WORLD_H = (ROWS - 1) * ROW_H + 89;
const WALK_SPEED = 220;
const SPRINT_MULT = 1.65;
/** On-foot terrain penalties — the bog is miserable without a machine. */
const WALK_MODS: Record<TerrainType, number> = { grass: 1, sand: 0.85, swamp: 0.35 };
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
/** The bog surface sits this many px below the surrounding ground, so the
 *  biome border reads as a step down (and back up). Small enough that the
 *  tile above still covers the gap with its slab side. */
const SWAMP_DROP = 6;
/** Pines carry 8px of transparent padding below the trunk in every size
 *  variant, so origin(0.5,1) alone would bury them. */
const PINE_PAD = 8;

const HEX_ASSETS = [
  "tileGrass",
  "tileSand",
  "tileMagic",
  "pineGreen_low",
  "pineGreen_mid",
  "pineGreen_high",
  "rockStone",
  "bushGrass",
  "bushMagic",
  "flowerRed",
  "flowerBlue",
  "flowerWhite",
];
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
  parts: { img: Phaser.GameObjects.Image; kind: string; baseY: number }[];
  spec: FabricatedSpec;
  driver: Slot | null;
  nextHarvestAt: number;
  smoke?: Phaser.GameObjects.Particles.ParticleEmitter;
  sparks?: Phaser.GameObjects.Particles.ParticleEmitter;
};

type ResourceNode = {
  sprite: Phaser.GameObjects.GameObject & { x: number; y: number };
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

export class WorldScene extends Phaser.Scene {
  private seed = "fabricator";
  private players = new Map<Slot, PlayerEntity>();
  private vehicles: VehicleEntity[] = [];
  private nodes: ResourceNode[] = [];
  /** biome[row][col] */
  private biome: TerrainType[][] = [];
  private obstacles!: Phaser.Physics.Arcade.StaticGroup;
  private cam2!: Phaser.Cameras.Scene2D.Camera;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private pad!: { x: number; y: number };
  private fabFx: Phaser.GameObjects.GameObject[] = [];
  private spawnCount = 0;

  private nodeByHex = new Map<string, ResourceNode>();
  /** Nodes whose remaining count differs from the deterministic baseline —
   *  the only node state a save needs to carry. */
  private harvestDeltas = new Map<string, { col: number; row: number; remaining: number }>();

  stockpile: Stockpile = { ...STARTING_STOCK };
  /** Screen shell subscribes for the HUD. */
  onStockpile: ((s: Stockpile) => void) | null = null;
  onToolEquipped: ((slot: Slot, spec: FabricatedSpec) => void) | null = null;
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
    if (data.seed) this.seed = data.seed;
  }

  preload() {
    this.load.setPath("/assets/hex");
    for (const key of HEX_ASSETS) this.load.image(key, `${key}.png`);
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

    const rng = mulberry32(this.seed);

    // ── hex terrain, stamped once into a static RenderTexture ──
    const tileFor: Record<TerrainType, string> = {
      grass: "tileGrass",
      sand: "tileSand",
      swamp: "tileMagic",
    };
    for (let row = 0; row < ROWS; row++) {
      const brow: TerrainType[] = [];
      for (let col = 0; col < COLS; col++) {
        const wobble = Math.sin(row * 0.5) * 1.2 + (rng() - 0.5) * 1.6;
        let t: TerrainType = "grass";
        if (col < 4 + wobble) t = "sand";
        else if (col > 31 + wobble && col < 39 + wobble) t = "swamp";
        brow.push(t);
      }
      this.biome.push(brow);
    }

    // Full 3D tiles, rows drawn top→bottom: with ROW_H matched to the art
    // (see hexgrid.ts) each row's top faces cover the slab sides of the row
    // above, so the interior reads flat and only the southern edge shows
    // depth. Bog tiles are stamped SWAMP_DROP lower, which uncovers that
    // much of the neighbouring tile's slab — the step down into the bog.
    const ground = this.add.renderTexture(0, 0, WORLD_W, WORLD_H).setOrigin(0, 0);
    ground.setDepth(-10);
    ground.beginDraw();
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const t = this.biome[row][col];
        const tl = hexImageTopLeft(col, row);
        ground.batchDraw(tileFor[t], tl.x, tl.y + this.dropAt(col, row));
      }
    }
    // decorations are static → stamp them into the ground texture too
    for (let i = 0; i < 260; i++) {
      const col = Math.floor(rng() * COLS);
      const row = Math.floor(rng() * ROWS);
      const t = this.biome[row][col];
      if (t === "sand") continue;
      const c = hexToWorld(col, row);
      const deco =
        t === "swamp"
          ? "bushMagic"
          : ["bushGrass", "flowerRed", "flowerBlue", "flowerWhite"][Math.floor(rng() * 4)];
      const img = this.textures.get(deco).getSourceImage();
      ground.batchDraw(
        deco,
        c.x - img.width / 2,
        c.y - img.height + 4 + this.dropAt(col, row),
      );
    }
    ground.endDraw();

    // ── resource nodes on hex centers (double as obstacles) ─────
    this.obstacles = this.physics.add.staticGroup();
    const spawnHex = worldToHex(WORLD_W / 2, WORLD_H / 2, COLS, ROWS);

    /**
     * Two art conventions in the pack, and they need different anchoring:
     *  • "boulder" (rockStone) is 65px wide — a full hex's worth of art,
     *    authored to be stamped at the tile's own top-left.
     *  • "pine" is a narrow prop that stands on the tile, with 8px of
     *    transparent padding below its trunk.
     * Collision is a separate invisible rect matched to the ground
     * footprint, so it can never drift from the art the way a body derived
     * from a shifted sprite origin does.
     */
    const addNode = (
      col: number,
      row: number,
      texture: string,
      material: MaterialType,
      units: number,
      art: "boulder" | "pine",
      tint?: number,
    ) => {
      const c = hexToWorld(col, row);
      const drop = this.dropAt(col, row);
      const cy = c.y + drop;

      let s: Phaser.GameObjects.Image;
      let bodyW: number;
      let bodyH: number;
      let bodyDY: number;
      if (art === "boulder") {
        // Boulders are raised blocks. Sunk along with the bog surface they
        // cut into the higher grass hexes at the biome step, so they sit at
        // un-dropped height — resting on the bog rather than in it.
        const tl = hexImageTopLeft(col, row);
        s = this.add.image(tl.x, tl.y, texture).setOrigin(0, 0);
        bodyW = 44;
        bodyH = 24;
        bodyDY = 6; // the boulder meets the ground just below hex center
      } else {
        s = this.add.image(c.x, cy + PINE_PAD, texture).setOrigin(0.5, 1);
        bodyW = 18;
        bodyH = 13; // trunk only — you can brush past the canopy
        bodyDY = 2;
      }
      s.setDepth(cy);
      if (tint) s.setTint(tint);

      const blocker = this.add.rectangle(c.x, cy + bodyDY, bodyW, bodyH).setVisible(false);
      this.physics.add.existing(blocker, true);
      this.obstacles.add(blocker);
      const node: ResourceNode = {
        sprite: s,
        blocker,
        cx: c.x,
        cy,
        col,
        row,
        material,
        remaining: units,
      };
      this.nodes.push(node);
      this.nodeByHex.set(`${col},${row}`, node);
    };

    const usedHexes = new Set<string>();
    const tryPlace = (
      filter: (t: TerrainType) => boolean,
      place: (col: number, row: number) => void,
      count: number,
    ) => {
      let placed = 0;
      for (let i = 0; i < 4000 && placed < count; i++) {
        const col = Math.floor(rng() * COLS);
        const row = Math.floor(rng() * ROWS);
        const key = `${col},${row}`;
        if (usedHexes.has(key)) continue;
        if (!filter(this.biome[row][col])) continue;
        if (Math.abs(col - spawnHex.col) < 3 && Math.abs(row - spawnHex.row) < 4) continue;
        usedHexes.add(key);
        place(col, row);
        placed++;
      }
    };

    const pines = ["pineGreen_low", "pineGreen_mid", "pineGreen_high"];
    tryPlace(
      (t) => t === "grass",
      (col, row) => addNode(col, row, pines[Math.floor(rng() * 3)], "wood", 5, "pine"),
      90,
    );
    tryPlace(
      (t) => t === "grass",
      (col, row) => addNode(col, row, "rockStone", "stone", 4, "boulder"),
      40,
    );
    tryPlace(
      (t) => t === "swamp",
      (col, row) => addNode(col, row, "rockStone", "bogiron", 3, "boulder", 0xd9813f),
      30,
    );

    // ── the Universal Fabricator pad ────────────────────────────
    const padHex = hexToWorld(spawnHex.col, spawnHex.row - 2);
    this.pad = { x: padHex.x, y: padHex.y };
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
    const cx = WORLD_W / 2;
    const cy = WORLD_H / 2;
    const p1 = this.spawnPlayer(1, cx - 40, cy, 0xf06eaa);
    const p2 = this.spawnPlayer(2, cx + 40, cy, 0xffcf4d);
    this.physics.add.collider(p1.sprite, this.obstacles);
    this.physics.add.collider(p2.sprite, this.obstacles);
    this.physics.add.collider(p1.sprite, p2.sprite);

    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    // ── split-screen cameras ────────────────────────────────────
    const cam1 = this.cameras.main;
    cam1.setBounds(0, 0, WORLD_W, WORLD_H);
    cam1.setZoom(CAMERA_ZOOM);
    cam1.startFollow(p1.sprite, true, 0.12, 0.12);
    cam1.setRoundPixels(true);

    this.cam2 = this.cameras.add();
    this.cam2.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cam2.setZoom(CAMERA_ZOOM);
    this.cam2.startFollow(p2.sprite, true, 0.12, 0.12);
    this.cam2.setRoundPixels(true);

    this.layoutCameras();
    this.scale.on("resize", () => this.layoutCameras());

    // ── keyboard dev fallback ───────────────────────────────────
    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,F,G,UP,DOWN,LEFT,RIGHT,K,L",
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    this.onStockpile?.(this.stockpile);
    this.onReady?.();
  }

  private terrainAt(x: number, y: number): TerrainType {
    const h = worldToHex(x, y, COLS, ROWS);
    return this.biome[h.row]?.[h.col] ?? "grass";
  }

  /** Vertical offset of a hex's surface — bog hexes sit a step lower. */
  private dropAt(col: number, row: number): number {
    return this.biome[row]?.[col] === "swamp" ? SWAMP_DROP : 0;
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
    const i = this.nodes.indexOf(node);
    if (i >= 0) this.nodes.splice(i, 1);
    this.nodeByHex.delete(`${node.col},${node.row}`);
    node.blocker.destroy(); // frees the hex for walking immediately
    const s = node.sprite as unknown as Phaser.GameObjects.Sprite;
    if (!animate) {
      s.destroy();
      return;
    }
    this.tweens.add({
      targets: s,
      alpha: 0,
      scale: 0.6,
      duration: 250,
      onComplete: () => s.destroy(),
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
   * `artDataUrl` is already display-ready — the screen shell chroma-keys
   * generated art once, when the design is created.
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
        .setScale(0.5 + spec.emission.intensity * 0.8)
        .setAlpha(0.75)
        .setDepth(1e6 - 1);
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
    // Structures live on the hex grid — snap to the nearest free-ish hex
    // center. (Future: 6-edge connections to neighboring structures.)
    if (spec.category !== "vehicle" && atX === undefined) {
      const hex = worldToHex(x, y, COLS, ROWS);
      const c = hexToWorld(hex.col, hex.row);
      x = c.x;
      y = c.y + this.dropAt(hex.col, hex.row);
    }

    const body = this.add.image(0, 0, bodyKey);
    body.setDisplaySize(w, h);

    const parts = spec.anchors.map((a) => {
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

    if (spec.emission?.kind === "light") {
      const lampAnchor = spec.anchors.find((a) => a.part === "lamp");
      const glow = this.add
        .image(lampAnchor ? lampAnchor.x * w : 0, lampAnchor ? lampAnchor.y * h : 0, "glow")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.5 + spec.emission.intensity * 0.9)
        .setAlpha(0.75);
      children.push(glow);
    }
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
      parts,
      spec,
      driver: null,
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

  private nearestNode(x: number, y: number, range: number): ResourceNode | null {
    let best: ResourceNode | null = null;
    let bestDist = Infinity;
    for (const n of this.nodes) {
      const d = Phaser.Math.Distance.Between(x, y, n.cx, n.cy);
      if (d < range && d < bestDist) {
        best = n;
        bestDist = d;
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

    const s = node.sprite as unknown as Phaser.GameObjects.Sprite;
    this.tweens.add({ targets: s, scale: { from: 1.12, to: 1 }, duration: 120 });
    this.floatText(node.cx, node.cy - 40, `+1 ${node.material}`, "#c9e77f");

    if (node.remaining <= 0) this.removeNode(node, true);
    return true;
  }

  // ── save / restore ────────────────────────────────────────────
  //
  // Terrain regenerates deterministically from the room code, so a save
  // carries only what diverges from it.

  snapshot(): WorldSnapshot {
    return {
      v: 1,
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

  /** Apply a saved world over the freshly generated terrain. `resolve` looks
   *  up a Design by id (the catalog arrives on the same socket). */
  applySnapshot(
    snap: WorldSnapshot,
    resolve: (designId: string) => PlaceableDesign | null,
  ): void {
    this.stockpile = { ...snap.stockpile };
    this.onStockpile?.(this.stockpile);

    for (const h of snap.harvested) {
      const key = `${h.col},${h.row}`;
      this.harvestDeltas.set(key, h);
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
    for (const p of this.players.values()) {
      const input = this.keyboardInput(p.slot) ?? p.net;
      const aEdge = input.buttons.a && !p.prevA;
      p.prevA = input.buttons.a;

      if (p.driving) {
        this.driveVehicle(p, p.driving, input, now);
        if (aEdge) this.exitVehicle(p);
        continue;
      }

      // on foot
      const mod = WALK_MODS[this.terrainAt(p.sprite.x, p.sprite.y)];
      const speed = WALK_SPEED * mod * (input.buttons.b ? SPRINT_MULT : 1);
      p.sprite.setVelocity(input.stick.x * speed, input.stick.y * speed);

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
      }
    }
  }

  private nearestEnterableVehicle(p: PlayerEntity): VehicleEntity | null {
    let best: VehicleEntity | null = null;
    let bestDist = Infinity;
    for (const v of this.vehicles) {
      if (v.spec.category !== "vehicle" || v.driver !== null) continue;
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
    v.driver = p.slot;
    p.sprite.setVisible(false);
    p.label.setVisible(false);
    if (p.tool) {
      p.tool.icon.setVisible(false);
      p.tool.glow?.setVisible(false);
    }
    (p.sprite.body as Phaser.Physics.Arcade.Body).enable = false;
    if (v.spec.emission?.kind === "smoke") v.smoke?.start();
    if (v.spec.emission?.kind === "sparks") v.sparks?.start();
  }

  private exitVehicle(p: PlayerEntity) {
    const v = p.driving!;
    const vb = v.container.body as Phaser.Physics.Arcade.Body;
    vb.setVelocity(0, 0);
    this.markDirty(); // it was driven somewhere — persist where it ended up
    p.driving = null;
    v.driver = null;
    v.smoke?.stop();
    v.sparks?.stop();
    p.sprite.setPosition(v.container.x, v.container.y + v.spec.size.h / 2 + 20);
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
    const mod = v.spec.locomotion.terrainModifiers[terrain];
    const speed = v.spec.locomotion.speed * mod;
    body.setVelocity(input.stick.x * speed, input.stick.y * speed);
    v.container.setDepth(v.container.y);

    // keep the (hidden) player and their camera glued to the vehicle
    p.sprite.setPosition(v.container.x, v.container.y);

    // machine harvesters chew through any node they touch, hands-free
    const hv = v.spec.harvest;
    let harvesting = false;
    if (hv) {
      const reach = Math.max(v.spec.size.w, v.spec.size.h) / 2 + 26;
      const node = this.nearestNode(v.container.x, v.container.y, reach);
      if (node && hv.materials.includes(node.material)) {
        harvesting = true;
        if (now >= v.nextHarvestAt) {
          this.harvestHit(node, hv.materials);
          v.nextHarvestAt = now + 1000 / hv.rate;
        }
      }
    }

    // part animation
    const vel = Math.hypot(body.velocity.x, body.velocity.y);
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
}
