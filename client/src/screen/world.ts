// The shared world scene. Host-authoritative: this scene IS the simulation.
// Controllers only feed inputs in via setInput(); keyboard on the screen
// itself works as a dev fallback (P1: WASD + F/G, P2: arrows + K/L).
//
// Split-screen: two cameras over one world, one per player (DST-couch-co-op
// style), fixed vertical split for now.
//
// Terrain demo layout: sand beach on the west edge, a swamp band east of
// the spawn clearing — so "Swamp Buggy ≠ Car" is visible within seconds.

import Phaser from "phaser";
import type { ButtonState, Slot, StickState } from "../../../party/protocol";
import type { FabricatedSpec, TerrainType } from "../../../shared/fabricator/schema";
import {
  TILE,
  TILE_KEYS,
  makeExplorerTexture,
  makePadTexture,
  makePartTextures,
  makeRockTexture,
  makeTilesTexture,
  makeTreeTexture,
  mulberry32,
} from "./textures";

const WORLD_TILES = 80; // 80×80 tiles → 2560×2560 px
const WORLD_SIZE = WORLD_TILES * TILE;
const WALK_SPEED = 220;
const SPRINT_MULT = 1.65;
/** On-foot terrain penalties — the swamp is miserable without a machine. */
const WALK_MODS: Record<TerrainType, number> = { grass: 1, sand: 0.85, swamp: 0.35 };
const ENTER_RANGE = 70;

export type PlayerInput = { stick: StickState; buttons: ButtonState };

const idleInput = (): PlayerInput => ({
  stick: { x: 0, y: 0 },
  buttons: { a: false, b: false },
});

type PlayerEntity = {
  slot: Slot;
  sprite: Phaser.Physics.Arcade.Sprite;
  label: Phaser.GameObjects.Text;
  net: PlayerInput;
  prevA: boolean;
  color: number;
  driving: VehicleEntity | null;
};

type VehicleEntity = {
  container: Phaser.GameObjects.Container;
  parts: { img: Phaser.GameObjects.Image; kind: string; baseY: number }[];
  spec: FabricatedSpec;
  driver: Slot | null;
};

export class WorldScene extends Phaser.Scene {
  private seed = "fabricator";
  private players = new Map<Slot, PlayerEntity>();
  private vehicles: VehicleEntity[] = [];
  private terrain: TerrainType[][] = [];
  private obstacles!: Phaser.Physics.Arcade.StaticGroup;
  private cam2!: Phaser.Cameras.Scene2D.Camera;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private pad!: { x: number; y: number };
  private fabFx: Phaser.GameObjects.GameObject[] = [];
  private spawnCount = 0;

  constructor() {
    super("world");
  }

  init(data: { seed?: string }) {
    if (data.seed) this.seed = data.seed;
  }

  create() {
    // Dev/test hook: lets the harness inspect players and inject inputs.
    (window as unknown as { __world: WorldScene }).__world = this;

    makeTilesTexture(this);
    makeTreeTexture(this);
    makeRockTexture(this);
    makePadTexture(this);
    makePartTextures(this);
    makeExplorerTexture(this, "explorer-1", "#35d0ba", "#1d8a7a");
    makeExplorerTexture(this, "explorer-2", "#ff9f43", "#c26a1c");

    const rng = mulberry32(this.seed);

    // ── terrain + ground tilemap ────────────────────────────────
    // Sand beach: west edge. Swamp band: vertical strip east of spawn.
    const data: number[][] = [];
    for (let y = 0; y < WORLD_TILES; y++) {
      const row: number[] = [];
      const trow: TerrainType[] = [];
      for (let x = 0; x < WORLD_TILES; x++) {
        const wobble = Math.sin(y * 0.35) * 1.6 + (rng() - 0.5) * 2;
        let terrain: TerrainType = "grass";
        if (x < 6 + wobble) terrain = "sand";
        else if (x > 48 + wobble && x < 60 + wobble) terrain = "swamp";
        trow.push(terrain);

        let t: number;
        if (terrain === "sand") {
          t = TILE_KEYS.sandA + Math.floor(rng() * 2);
        } else if (terrain === "swamp") {
          t = TILE_KEYS.swampA + Math.floor(rng() * 2);
        } else {
          const r = rng();
          t = TILE_KEYS.grassA + Math.floor(rng() * 4);
          if (r > 0.965) t = TILE_KEYS.flowers;
          else if (r > 0.94) t = TILE_KEYS.dirt;
        }
        row.push(t);
      }
      data.push(row);
      this.terrain.push(trow);
    }
    const map = this.make.tilemap({ data, tileWidth: TILE, tileHeight: TILE });
    const tileset = map.addTilesetImage("tiles", "tiles", TILE, TILE, 0, 0, 0)!;
    map.createLayer(0, tileset, 0, 0);

    // ── obstacles (grass only, clear of spawn) ──────────────────
    this.obstacles = this.physics.add.staticGroup();
    const center = WORLD_SIZE / 2;
    const clearRadius = 7 * TILE;
    for (let i = 0; i < 170; i++) {
      const x = rng() * WORLD_SIZE;
      const y = rng() * WORLD_SIZE;
      if (Math.hypot(x - center, y - center) < clearRadius) continue;
      if (this.terrainAt(x, y) !== "grass") continue;
      const isTree = rng() < 0.7;
      const s = this.obstacles.create(x, y, isTree ? "tree" : "rock") as
        Phaser.Physics.Arcade.Sprite;
      s.setDepth(y);
      const bw = isTree ? 20 : 26;
      const bh = isTree ? 14 : 12;
      s.body!.setSize(bw, bh);
      s.body!.setOffset((s.width - bw) / 2, s.height - bh - 2);
    }

    // ── the Universal Fabricator pad ────────────────────────────
    this.pad = { x: center, y: center - 110 };
    this.add.image(this.pad.x, this.pad.y, "pad").setDepth(this.pad.y);

    // ── players ─────────────────────────────────────────────────
    const p1 = this.spawnPlayer(1, center - 40, center, "explorer-1", 0x35d0ba);
    const p2 = this.spawnPlayer(2, center + 40, center, "explorer-2", 0xff9f43);
    this.physics.add.collider(p1.sprite, this.obstacles);
    this.physics.add.collider(p2.sprite, this.obstacles);
    this.physics.add.collider(p1.sprite, p2.sprite);

    this.physics.world.setBounds(0, 0, WORLD_SIZE, WORLD_SIZE);

    // ── split-screen cameras ────────────────────────────────────
    const cam1 = this.cameras.main;
    cam1.setBounds(0, 0, WORLD_SIZE, WORLD_SIZE);
    cam1.startFollow(p1.sprite, true, 0.12, 0.12);
    cam1.setRoundPixels(true);

    this.cam2 = this.cameras.add();
    this.cam2.setBounds(0, 0, WORLD_SIZE, WORLD_SIZE);
    this.cam2.startFollow(p2.sprite, true, 0.12, 0.12);
    this.cam2.setRoundPixels(true);

    this.layoutCameras();
    this.scale.on("resize", () => this.layoutCameras());

    // ── keyboard dev fallback ───────────────────────────────────
    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,F,G,UP,DOWN,LEFT,RIGHT,K,L",
    ) as Record<string, Phaser.Input.Keyboard.Key>;
  }

  private terrainAt(x: number, y: number): TerrainType {
    const tx = Math.max(0, Math.min(WORLD_TILES - 1, Math.floor(x / TILE)));
    const ty = Math.max(0, Math.min(WORLD_TILES - 1, Math.floor(y / TILE)));
    return this.terrain[ty][tx];
  }

  private spawnPlayer(
    slot: Slot,
    x: number,
    y: number,
    texture: string,
    color: number,
  ): PlayerEntity {
    const sprite = this.physics.add.sprite(x, y, texture);
    sprite.setCollideWorldBounds(true);
    const bw = 18;
    const bh = 12;
    sprite.body!.setSize(bw, bh);
    sprite.body!.setOffset((sprite.width - bw) / 2, sprite.height - bh - 2);

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
      sprite,
      label,
      net: idleInput(),
      prevA: false,
      color,
      driving: null,
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

  // ── Fabricator visuals ────────────────────────────────────────

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

  /** Materialize a compiled spec next to the pad. The sketch (if any) is the
   *  body sprite — hybrid-lite: player art body + library part sprites. */
  spawnFabricated(spec: FabricatedSpec, imageDataUrl?: string) {
    this.clearFabricating();
    const key = `fab-body-${this.spawnCount++}`;
    const build = () => this.buildVehicle(spec, key);
    if (imageDataUrl) {
      this.textures.once(`addtexture-${key}`, build);
      this.textures.addBase64(key, imageDataUrl);
    } else {
      const g = this.add.graphics();
      g.fillStyle(0x8b98a9, 1);
      g.fillRoundedRect(0, 0, 64, 40, 8);
      g.generateTexture(key, 64, 40);
      g.destroy();
      build();
    }
  }

  private buildVehicle(spec: FabricatedSpec, bodyKey: string) {
    const { w, h } = spec.size;
    const x = this.pad.x + 110 + (this.spawnCount % 3) * 30;
    const y = this.pad.y + 60 + Math.floor(this.spawnCount / 3) * 30;

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

    // parts render under the label, over the body
    const container = this.add.container(x, y, [
      body,
      ...parts.map((p) => p.img),
      label,
    ]);
    container.setDepth(y);
    this.physics.add.existing(container);
    const bodyPhys = container.body as Phaser.Physics.Arcade.Body;
    bodyPhys.setSize(w, h);
    bodyPhys.setOffset(-w / 2, -h / 2);
    bodyPhys.setCollideWorldBounds(true);
    if (spec.category !== "vehicle") bodyPhys.setImmovable(true);
    this.physics.add.collider(container, this.obstacles);

    const vehicle: VehicleEntity = { container, parts, spec, driver: null };
    this.vehicles.push(vehicle);

    // materialization flash
    const flash = this.add
      .circle(x, y, 10, 0x8fc1ff, 0.7)
      .setDepth(1e6);
    this.tweens.add({
      targets: flash,
      radius: Math.max(w, h),
      alpha: 0,
      duration: 500,
      onComplete: () => flash.destroy(),
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

  update() {
    for (const p of this.players.values()) {
      const input = this.keyboardInput(p.slot) ?? p.net;
      const aEdge = input.buttons.a && !p.prevA;
      p.prevA = input.buttons.a;

      if (p.driving) {
        this.driveVehicle(p, p.driving, input);
        if (aEdge) this.exitVehicle(p);
        continue;
      }

      // on foot
      const mod = WALK_MODS[this.terrainAt(p.sprite.x, p.sprite.y)];
      const speed = WALK_SPEED * mod * (input.buttons.b ? SPRINT_MULT : 1);
      p.sprite.setVelocity(input.stick.x * speed, input.stick.y * speed);

      if (input.stick.x > 0.05) p.sprite.setFlipX(false);
      else if (input.stick.x < -0.05) p.sprite.setFlipX(true);
      const moving = Math.hypot(input.stick.x, input.stick.y) > 0.1;
      p.sprite.setAngle(moving ? Math.sin(this.time.now / 60) * 5 : 0);

      if (aEdge) {
        const vehicle = this.nearestEnterableVehicle(p);
        if (vehicle) this.enterVehicle(p, vehicle);
        else this.ping(p);
      }

      p.sprite.setDepth(p.sprite.y);
      p.label.setPosition(p.sprite.x, p.sprite.y - p.sprite.height + 4);
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
    (p.sprite.body as Phaser.Physics.Arcade.Body).enable = false;
  }

  private exitVehicle(p: PlayerEntity) {
    const v = p.driving!;
    const vb = v.container.body as Phaser.Physics.Arcade.Body;
    vb.setVelocity(0, 0);
    p.driving = null;
    v.driver = null;
    p.sprite.setPosition(v.container.x, v.container.y + v.spec.size.h / 2 + 20);
    p.sprite.setVisible(true);
    p.label.setVisible(true);
    (p.sprite.body as Phaser.Physics.Arcade.Body).enable = true;
  }

  private driveVehicle(p: PlayerEntity, v: VehicleEntity, input: PlayerInput) {
    const body = v.container.body as Phaser.Physics.Arcade.Body;
    const terrain = this.terrainAt(v.container.x, v.container.y);
    const mod = v.spec.locomotion.terrainModifiers[terrain];
    const speed = v.spec.locomotion.speed * mod;
    body.setVelocity(input.stick.x * speed, input.stick.y * speed);
    v.container.setDepth(v.container.y);

    // keep the (hidden) player and their camera glued to the vehicle
    p.sprite.setPosition(v.container.x, v.container.y);

    // part animation: wheels spin with speed, legs/floats bob
    const vel = Math.hypot(body.velocity.x, body.velocity.y);
    for (const part of v.parts) {
      if (part.kind === "wheel") {
        part.img.rotation +=
          (vel / 26) * 0.06 * (body.velocity.x >= 0 ? 1 : -1);
      } else if (vel > 5) {
        part.img.y = part.baseY + Math.sin(this.time.now / 90) * 2;
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
