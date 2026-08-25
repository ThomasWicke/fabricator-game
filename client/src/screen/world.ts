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
import {
  MATERIALS,
  normalizeModifiers,
  type EmissionKind,
  type FabricatedSpec,
  type MaterialType,
  type TerrainType,
} from "../../../shared/fabricator/schema";
import { canAfford, formatCost } from "../../../shared/fabricator/cost";
import { BELT_MAX, nextBeltIndex } from "./belt";
import { HEX_POINTS, HEX_W, ROW_H, hexToWorld, worldToHex } from "./hexgrid";
import {
  CHUNK_COLS,
  CHUNK_ROWS,
  ChunkField,
  chunkKey,
  chunkOfHex,
  type ChunkKey,
} from "./chunks";
import {
  makeForageTexture,
  makeNestTexture,
  makePackTexture,
  makePadTexture,
  makeCarryTextures,
  makeParticleTextures,
  makeShadowTexture,
  mulberry32,
} from "./textures";
import {
  AGGRO_NIGHT_BONUS,
  AGGRO_RANGE,
  ENEMY_KEYS,
  HAND_COOLDOWN,
  HAND_DAMAGE,
  HAND_REACH,
  HUNGRY_SPEED,
  LEASH_RANGE,
  LOSE_RANGE,
  LOSE_TIME,
  SPECIES,
  SPRINT_MULT,
  WALK_SPEED,
  nestAt,
  type Species,
  type SpeciesId,
} from "./enemies";
import {
  BIOMES,
  BIOME_TILE_KEYS,
  DECOR_KEYS,
  LANDMARK_KEYS,
  SCATTER_KEYS,
  type BiomeType,
  biomeAt,
  findSpawn,
  inClearing,
  isLiquid,
  regionAt,
  regionName,
  sameRegion,
  scatterAt,
  terrainOf,
  tileAt,
  worldSeed,
  type Region,
} from "./worldgen";

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
const CAMERA_ZOOM = 1.45;
/** Narrow viewports show less world at the same magnification, so they pull
 *  back to compensate. Fractions of the above rather than their own numbers,
 *  so changing the zoom moves the whole ladder instead of compressing it. */
const ZOOM_NARROW = 0.72;
const ZOOM_MID = 0.84;
/** Bare hands: slow, and bogiron is beyond them. */
const HAND_RATE = 0.8;
const HAND_MATERIALS: CarryType[] = ["wood", "stone", "food"];
/** You land with enough to build the first harvester and nothing else. Every
 *  exotic starts at zero by construction — they exist to be walked to. */
const STARTING_STOCK: Record<MaterialType, number> = {
  ...(Object.fromEntries(MATERIALS.map((m) => [m, 0])) as Record<MaterialType, number>),
  wood: 25,
  stone: 15,
};
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

/** Ground colour kicked up by a vehicle, per movement class. Water is in the
 *  table only so the lookup is total; a hull leaves a wake, not dust, and the
 *  drive loop skips it. */
const DUST_TINT: Record<TerrainType, number> = {
  grass: 0x6f7a4e,
  sand: 0xd8c07a,
  swamp: 0x4d5a3a,
  rock: 0x8a8f99,
  snow: 0xe2ebf1,
  water: 0x2d5c86,
};

// ── wildlife ──────────────────────────────────────────────────────────────
//
// Threat you can always walk away from — or rather, run away from. The whole
// balance lives in three numbers: enemies are faster than a walk and slower
// than a sprint, they give up once you have been clear for a moment, and they
// never chase further than a screen from home.

/** How close a bite lands, and how often. */
const BITE_RANGE = 34;
const BITE_COOLDOWN = 1100;
const BITE_KNOCKBACK = 210;
/** Knockback per point of damage — a heavy weapon shoves harder. */
const HIT_KNOCKBACK = 26;
/** A nest keeps its brood topped up on this cadence. */
const NEST_RESPAWN_MS = 22_000;
/** Idle wandering: how far from the nest, and how often they pick a new spot. */
const WANDER_RANGE = 90;
const WANDER_EVERY = 2600;

// ── survival ──────────────────────────────────────────────────────────────
//
// Deliberately unhurried. Hunger is a reason to keep an eye on the land, not
// a timer: a full belly lasts about eight minutes, and running out slows you
// down well before it hurts you. Dying costs you the trip you were on — the
// load on your back — and nothing else.

const HEALTH_MAX = 100;
const HUNGER_MAX = 100;
/** Hunger per second, standing still. ~8 minutes from full to empty. */
const HUNGER_DRAIN = HUNGER_MAX / 480;
/** Multipliers on that drain. Effort costs; it just doesn't cost much. */
const HUNGER_WALK = 1.35;
const HUNGER_SPRINT = 2.1;
/** Below this you are hungry: slower, and the HUD says so. */
const HUNGER_LOW = 25;
/** Empty. Health goes now, slowly enough to walk somewhere about it. */
const STARVE_DAMAGE = 1.6;
/** Health regained per second while well fed. */
const HEAL_RATE = 1.4;
const HEAL_HUNGER = 50;
/** Hunger restored by one unit of forage. */
const FOOD_VALUE = 26;
/** Eat automatically below this. With only two buttons, an "eat" key would
 *  have to displace something you need more. */
const AUTO_EAT_AT = 34;

/**
 * The carried stack — the pile of logs and rock wobbling over your head.
 *
 * The whole effect is the lag. Parenting the items rigidly to the player
 * gives you a stiff pole; each one trailing the one beneath it gives a whip
 * that leans into corners and settles when you stop, and that is what makes
 * hauling twenty logs feel like hauling twenty logs.
 */
const STACK_STEP = 7;
/** Where the bottom of the stack sits, relative to the player's centre. */
const STACK_BASE = -26;
/** How hard each item is pulled toward the one below it, per second. */
const STACK_FOLLOW = 26;
/** The furthest one item may sit from the one below it.
 *
 *  Lag alone is not enough: it compounds along the pile, so a 24-log stack at
 *  a sprint ended up trailing 233px behind its owner — lying flat on the
 *  ground rather than leaning. Clamping each link bounds the total lean to
 *  links × this, so the stack can whip hard and still be a stack. */
const STACK_MAX_LEAN = 3;
/** Items shrink slightly with height, which reads as perspective and keeps a
 *  full pack from becoming a wall down the middle of the screen. */
const STACK_SHRINK = 0.006;

/** What one player can carry, in units, across everything in the pack. This
 *  is the whole reason to walk back to the Fabricator. */
const PACK_CAPACITY = 24;
/** Units per second moved from a standing player's pack into the shared
 *  stockpile. Automatic: being at the machine IS depositing. */
const DEPOSIT_RATE = 6;

/** How close you have to stand to use the Fabricator. Generous enough that
 *  "I'm at the machine" is obvious, tight enough that you have to go there. */
const FABRICATOR_RANGE = 120;

/** The partner arrow appears only inside this range — beyond it you're on
 *  your own expedition and an arrow is just clutter. */
const POINTER_RANGE = 1300;
/** Margin from the viewport edge the arrow rides at, in screen pixels. */
const POINTER_INSET = 52;

const ALIEN_SKINS = { 1: "alienPink", 2: "alienYellow" } as const;
const ALIEN_FRAMES = ["stand", "walk1", "walk2", "climb1", "climb2"];

export type PlayerInput = { stick: StickState; buttons: ButtonState };
export type Stockpile = Record<MaterialType, number>;

/** Everything a pack can hold. Food never reaches the shared stockpile —
 *  it is yours, and you eat it. */
export type CarryType = MaterialType | "food";
export type Pack = Record<CarryType, number>;

export const CARRIABLE: readonly CarryType[] = [...MATERIALS, "food"];
export const emptyPack = (): Pack =>
  Object.fromEntries(CARRIABLE.map((m) => [m, 0])) as Pack;
export const packLoad = (p: Pack): number =>
  CARRIABLE.reduce((sum, m) => sum + p[m], 0);

/** A tool on the belt. The body key is kept so re-equipping can rebuild the
 *  icon without going back to the design catalog. */
export type CarriedTool = { designId: string; spec: FabricatedSpec; bodyKey: string };

/** What the HUD draws for one player. */
export type Vitals = {
  health: number;
  hunger: number;
  pack: Pack;
  capacity: number;
};

/** What happened when a phone pressed BUILD. `carrying` means it went onto
 *  the builder's shoulder instead of into the world — nothing charged yet. */
export type FabricateOutcome =
  | { ok: true; carrying: boolean }
  | { ok: false; reason: string };

/** Does this harvest capability take that kind of thing?
 *
 *  A spec's `materials` are MaterialType — machines mine, they do not forage —
 *  while a node can also hold food, so the two lists only overlap partially.
 *  Comparing as strings keeps the widening in one place instead of casting at
 *  every call site. */
const gathers = (materials: readonly string[], m: CarryType): boolean =>
  materials.includes(m);

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
  prevB: boolean;
  color: number;
  driving: VehicleEntity | null;
  /** Everything blueprinted for this player to hold. A tool used to be a
   *  property of the person — one, forever — which stopped working the moment
   *  four different ores each needed their own harvester. */
  belt: CarriedTool[];
  /** Index into `belt`, or -1 for bare hands. Hands are a real choice: they
   *  gather wood, stone and food, which a single-ore drill does not. */
  equipped: number;
  /** Live visuals for whatever `equipped` points at. */
  tool: {
    designId: string;
    spec: FabricatedSpec;
    icon: Phaser.GameObjects.Image;
    glow?: Phaser.GameObjects.Image;
  } | null;
  nextHarvestAt: number;
  /** Standing at the Fabricator. Tracked so the change can be pushed to the
   *  phone exactly once, on the edge. */
  atFabricator: boolean;
  /** Which named region they were last in, so crossing out of it can be
   *  announced once rather than every frame. */
  region: Region | null;
  /** A fabricated structure being carried to wherever it should stand.
   *  Nothing is charged until it is put down, so walking away costs nothing. */
  carrying: CarriedStructure | null;
  /** What this player is hauling. Harvest fills it; standing at the
   *  Fabricator empties it into the shared stockpile. */
  pack: Pack;
  health: number;
  hunger: number;
  /** Fractional progress toward the next whole unit deposited. */
  depositCarry: number;
  /** Rate limit on bare-handed shoves. */
  nextShoveAt: number;
  /** The visible pile above their head, bottom-first.
   *
   *  `bx`/`by` are the item's place in the chain; the sprite is drawn at that
   *  plus a fixed jitter. Keeping the two apart matters — jittering the chain
   *  position itself would feed the offset into the next item up and the pile
   *  would drift sideways as it grew. */
  stack: {
    img: Phaser.GameObjects.Image;
    type: CarryType;
    bx: number;
    by: number;
    /** Stable per-item wonk, so the pile looks stacked by hand. */
    jx: number;
    tilt: number;
  }[];
};

/** One animal. Nests own them; chunks own the nests. */
type Enemy = {
  species: SpeciesId;
  def: Species;
  sprite: Phaser.Physics.Arcade.Sprite;
  home: { x: number; y: number };
  health: number;
  /** Who it is after, if anyone. */
  target: Slot | null;
  /** Seconds the target has been beyond LOSE_RANGE. */
  lostFor: number;
  nextBiteAt: number;
  nextWanderAt: number;
  wander: { x: number; y: number };
  /** Set while the hit flash is showing, so it isn't restarted every frame. */
  flashUntil: number;
  /** Killed, but still fading out. The sprite stays alive for most of a
   *  second while it fades, and without this flag it is still a valid target
   *  the whole time — so it can be killed again, and again, each one paying
   *  out another piece of food. */
  dying: boolean;
};

/** A burrow. Deterministic from the hex; streams in and out with its chunk. */
type Nest = {
  species: SpeciesId;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  brood: Enemy[];
  nextSpawnAt: number;
};

/** A pack left where somebody fell. Walk back and press A to take it. */
type DroppedPack = {
  sprite: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  contents: Pack;
  x: number;
  y: number;
};

/**
 * A hand-pumped particle source.
 *
 * Phaser's emitter is a GameObject and its particles live in its LOCAL space,
 * so moving the emitter to follow a machine drags every particle already in
 * the air along with it — exhaust ends up as a blob glued to the vehicle
 * instead of a trail left behind on the ground. So the emitter stays parked at
 * the world origin and never moves; we spawn each particle at an explicit
 * world point instead, and it stays where it was born.
 */
type Emission = {
  em: Phaser.GameObjects.Particles.ParticleEmitter;
  /** Milliseconds between particles. */
  everyMs: number;
  accum: number;
};

/** A structure in transit: ghost art over the player, the hex it would land
 *  on outlined underneath, and a prompt saying how to finish. */
type CarriedStructure = {
  design: PlaceableDesign;
  ghost: Phaser.GameObjects.Image;
  outline: Phaser.GameObjects.Polygon;
  prompt: Phaser.GameObjects.Text;
  /** Where it would go, recomputed each frame. */
  hex: { col: number; row: number };
  valid: boolean;
};

type VehicleEntity = {
  designId: string;
  container: Phaser.GameObjects.Container;
  /** The body art itself — shaken in place to sell a running engine. */
  bodyImg: Phaser.GameObjects.Image;
  spec: FabricatedSpec;
  /** terrainModifiers with the newer movement classes filled in — designs
   *  compiled before rock/snow/water existed still have to drive. */
  mods: Record<TerrainType, number>;
  driver: Slot | null;
  /** Second rider, when the spec has the seats for one. */
  passenger: Slot | null;
  nextHarvestAt: number;
  /** Fractional progress toward the next unit of food a farm hands out. */
  farmCarry?: number;
  /** Spec'd exhaust — smoke, steam or sparks — emitted behind the machine. */
  trail?: Emission;
  /** Ground kicked up by motion. Not spec'd: every vehicle gets it, tinted
   *  by whatever it happens to be driving over. */
  dust?: Emission;
  /** Light lives outside the container so it can render above the night
   *  overlay; container children are stuck at the container's depth. */
  glow?: Phaser.GameObjects.Image;
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
  material: CarryType;
  remaining: number;
  /** Berry overlay, on forage only. */
  berries?: Phaser.GameObjects.Image;
  /** Contact shadow, on boulders only. */
  shadow?: Phaser.GameObjects.Image;
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
  /** The named region the first active player is standing in. */
  region: string;
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
  private padRing!: Phaser.GameObjects.Arc;
  private padLabel!: Phaser.GameObjects.Text;
  private padPrompt!: Phaser.GameObjects.Text;
  private spawn = { col: 0, row: 0 };
  private fabFx: Phaser.GameObjects.GameObject[] = [];
  /** One night overlay per viewport: an endless world has no rectangle a
   *  single quad could cover, and the two cameras can be anywhere. */
  private darkness: Phaser.GameObjects.Rectangle[] = [];
  private spawnCount = 0;
  private field!: ChunkField;
  private rng!: () => number;
  /**
   * Who is actually playing. The world always holds two characters, but a
   * slot only wakes up when someone arrives for it — a phone taking the seat,
   * or a hand touching that half of the keyboard. Until then the second
   * player is parked and invisible, and player one gets the whole screen.
   */
  private activeSlots = new Set<Slot>([1]);
  /** Suppresses keyboard control while a screen overlay owns the keys. */
  private uiOpen = false;

  /** Arrow pointing at the other player, one per viewport. */
  private pointers = new Map<Slot, {
    container: Phaser.GameObjects.Container;
    arrow: Phaser.GameObjects.Triangle;
    label: Phaser.GameObjects.Text;
  }>();

  private nodeByHex = new Map<string, ResourceNode>();
  /** Hexes a structure already stands on — you cannot stack two on one tile. */
  private occupied = new Set<string>();
  /** Packs dropped where players fell, waiting to be collected. */
  private drops: DroppedPack[] = [];
  /** Nests by chunk, so wildlife streams in and out with the ground it
   *  lives on rather than simulating a whole planet's worth. */
  private nestsByChunk = new Map<ChunkKey, Nest[]>();
  private nodesByChunk = new Map<ChunkKey, ResourceNode[]>();
  /** Nodes whose remaining count differs from the deterministic baseline —
   *  the only node state a save needs to carry. Survives chunk unload, which
   *  is what makes a worked-out grove stay worked out when you walk back. */
  private harvestDeltas = new Map<string, { col: number; row: number; remaining: number }>();
  /** biomeAt is pure but not free, and the sim asks about the same few hexes
   *  every frame. Bounded so an endless world can't grow an endless cache. */
  private biomeCache = new Map<string, BiomeType>();
  private dropCache = new Map<string, number>();

  stockpile: Stockpile = { ...STARTING_STOCK };
  /** Screen shell subscribes for the HUD. */
  onStockpile: ((s: Stockpile) => void) | null = null;
  onToolEquipped:
    | ((slot: Slot, belt: { equipped: FabricatedSpec | null; count: number; index: number }) => void)
    | null = null;
  /** Fired when a player boards or leaves a vehicle, for the HUD. */
  onRideChanged: ((slot: Slot, vehicle: string | null, driving: boolean) => void) | null =
    null;
  /** Fired when a design actually becomes an object in the world. Separate
   *  from the BUILD press, because a structure is only really built once its
   *  carrier puts it down. */
  onDesignBuilt: ((designId: string) => void) | null = null;
  /** Fired on the edge when a player walks up to or away from the Fabricator.
   *  The shell relays it to that player's phone, which is where the blueprint
   *  pad and the build buttons live. */
  onFabricatorRange: ((slot: Slot, inRange: boolean) => void) | null = null;
  /** Fired when persistent state changed — the shell debounces a save. */
  onDirty: (() => void) | null = null;
  /** Fired once the scene exists and can accept a snapshot. */
  onReady: (() => void) | null = null;
  /** Fired when the viewport goes from solo to split, or back. */
  onSplitChanged: ((split: boolean) => void) | null = null;
  /** Fired when a second player arrives, so the HUD can greet them. */
  onSlotActivated: ((slot: Slot) => void) | null = null;
  /** Health, hunger and load, pushed whenever they change enough to redraw. */
  onVitals: ((slot: Slot, v: Vitals) => void) | null = null;

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
    for (const key of new Set([
      ...BIOME_TILE_KEYS,
      ...DECOR_KEYS,
      ...SCATTER_KEYS,
      ...LANDMARK_KEYS,
    ])) {
      this.load.image(key, `${key}.png`);
    }
    this.load.setPath("/assets/enemies");
    for (const key of ENEMY_KEYS) this.load.image(key, `${key}.png`);
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
    makeParticleTextures(this);
    makeForageTexture(this);
    makePackTexture(this);
    makeNestTexture(this);
    makeShadowTexture(this);
    makeCarryTextures(this);

    this.obstacles = this.physics.add.staticGroup();
    // Wildlife wanders and spawns with jitter; seeded so replaying the same
    // world behaves the same way rather than differing run to run.
    this.rng = mulberry32(`${this.seedText}|wildlife`);

    // ── the landing site ────────────────────────────────────────
    // Nothing is carved or cleared: findSpawn walks the field until it finds
    // ground that was already good, which is the endless world's version of
    // "generate a starting area".
    this.spawn = findSpawn(this.seed);
    const padWorld = hexToWorld(this.spawn.col, this.spawn.row);
    this.pad = { x: padWorld.x, y: padWorld.y };

    // ── terrain streaming ───────────────────────────────────────
    this.field = new ChunkField(this, this.seed, {
      onLoad: (cx, cy) => {
        this.loadChunkNodes(cx, cy);
        this.loadChunkNests(cx, cy);
      },
      onUnload: (cx, cy) => {
        this.unloadChunkNodes(cx, cy);
        this.unloadChunkNests(cx, cy);
      },
    });

    this.add.image(this.pad.x, this.pad.y, "pad").setDepth(this.pad.y);
    // The machine announces itself. A permanent plate says what it is; the
    // ring and the prompt only appear once someone is close enough to use it,
    // which is how you learn that standing here is what unlocks the phone.
    this.padRing = this.add
      .circle(this.pad.x, this.pad.y + 6, FABRICATOR_RANGE * 0.55)
      .setStrokeStyle(2, 0x6c9ef8, 0.7)
      .setDepth(this.pad.y - 1)
      .setVisible(false);
    this.padLabel = this.add
      .text(this.pad.x, this.pad.y - 34, "FABRICATOR", {
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: "11px",
        fontStyle: "bold",
        color: "#8fc1ff",
        backgroundColor: "rgba(8,14,26,0.55)",
        padding: { x: 6, y: 2 },
      })
      .setOrigin(0.5, 1)
      .setDepth(1e6);
    this.padPrompt = this.add
      .text(this.pad.x, this.pad.y + 46, "open BLUEPRINT on your phone", {
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        fontStyle: "bold",
        color: "#dfe8f4",
        backgroundColor: "rgba(8,14,26,0.6)",
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5, 0)
      .setDepth(1e6)
      .setVisible(false);

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
    // Player two exists from the start but stays out of sight until someone
    // shows up for them — an idle alien standing at the pad all game reads as
    // a bug, and it would keep half the screen busy watching nothing.
    if (!this.activeSlots.has(2)) {
      p2.sprite.setVisible(false);
      p2.label.setVisible(false);
      (p2.sprite.body as Phaser.Physics.Arcade.Body).enable = false;
    }
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
    // enableCapture: FALSE. Phaser's default is to preventDefault() every key
    // it watches, which silently eats W/A/S/D before they reach a focused
    // text field — so naming a blueprint on the screen's own Fabricator pad
    // produced a name with no W, A, S or D in it. Nothing here needs the
    // default suppressed: the page has nothing to scroll, and movement is
    // already held off by uiOpen while an overlay is up.
    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,F,G,UP,DOWN,LEFT,RIGHT,K,L",
      false,
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
    for (const p of this.players.values()) this.pushVitals(p);
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

  /** Vertical offset of a hex's surface — sea in a basin, bog a step down,
   *  high ground a step up. Cached alongside the biome because the sim asks
   *  about the same handful of hexes every frame. */
  private dropAt(col: number, row: number): number {
    const key = `${col},${row}`;
    let d = this.dropCache.get(key);
    if (d === undefined) {
      d = tileAt(col, row, this.seed).drop;
      if (this.dropCache.size > 4096) this.dropCache.clear();
      this.dropCache.set(key, d);
    }
    return d;
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
        const drop = this.dropAt(col, row);
        const cy2 = c.y + drop;

        let sprite: Phaser.GameObjects.Image;
        let bodyW: number;
        let bodyH: number;
        let bodyDY: number;
        let berries: Phaser.GameObjects.Image | undefined;
        let shadow: Phaser.GameObjects.Image | undefined;
        if (entry.art === "bush") {
          // Forage stands on the tile and is walked through — a berry bush
          // that body-blocks you would be infuriating, and the whole point of
          // food is that it is easy to reach.
          sprite = this.add.image(c.x, cy2 + 6, entry.texture).setOrigin(0.5, 1);
          berries = this.add
            .image(c.x + 4, cy2 - 4, "berries")
            .setOrigin(0.5, 1)
            .setDepth(cy2 + 0.5);
          bodyW = 0;
          bodyH = 0;
          bodyDY = 0;
        } else if (entry.art === "boulder") {
          // Stamped like a tile, and it has to move WITH its tile: relief can
          // raise ground as well as sink it, and a boulder pinned to the
          // un-dropped height sits several pixels below the mountainside it
          // is supposed to be standing on.
          // A contact shadow, drawn under the block: without it a rock whose
          // top face matches the ground it stands on shows only its shaded
          // sides, and reads as a notch rather than a lump.
          shadow = this.add
            .image(c.x, cy2 + 4, "shadow")
            .setDepth(cy2 - 1)
            .setAlpha(0.85);
          sprite = this.add
            .image(c.x - HEX_W / 2, cy2 - 32, entry.texture)
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

        // A zero-size body means "no obstacle" — forage only.
        const blocker = this.add
          .rectangle(c.x, cy2 + bodyDY, Math.max(1, bodyW), Math.max(1, bodyH))
          .setVisible(false);
        if (bodyW > 0) {
          this.physics.add.existing(blocker, true);
          this.obstacles.add(blocker);
        }

        // Trees and rocks are named for the thing, not the material; every
        // seam is named for its material already. The fallback used to be a
        // bare "bogiron", which quietly turned all four seams into the same
        // ore the moment there was more than one.
        const material: CarryType =
          entry.kind === "tree" ? "wood" : entry.kind === "rock" ? "stone" : entry.kind;
        const node: ResourceNode = {
          sprite,
          berries,
          shadow,
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
      node.berries?.destroy();
      node.shadow?.destroy();
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
      belt: [],
      equipped: -1,
      net: idleInput(),
      prevA: false,
      prevB: false,
      color,
      driving: null,
      tool: null,
      nextHarvestAt: 0,
      atFabricator: false,
      region: null,
      carrying: null,
      pack: emptyPack(),
      health: HEALTH_MAX,
      hunger: HUNGER_MAX,
      depositCarry: 0,
      nextShoveAt: 0,
      stack: [],
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

  /** Solo gets the whole frame; two players split it down the middle. */
  private layoutCameras() {
    const w = this.scale.width;
    const h = this.scale.height;
    const split = this.activeSlots.size > 1;

    // Zoom is tuned for a television across a room. A phone is a hand's width
    // away and has a fraction of the pixels, so the same magnification would
    // leave you peering through a letterbox at three hexes.
    const viewW = split ? w / 2 : w;
    const zoom =
      viewW < 520
        ? CAMERA_ZOOM * ZOOM_NARROW
        : viewW < 800
          ? CAMERA_ZOOM * ZOOM_MID
          : CAMERA_ZOOM;
    this.cameras.main.setZoom(zoom);
    this.cam2.setZoom(zoom);
    if (split) {
      this.cameras.main.setViewport(0, 0, Math.floor(w / 2), h);
      this.cam2.setViewport(Math.floor(w / 2), 0, Math.ceil(w / 2), h);
    } else {
      this.cameras.main.setViewport(0, 0, w, h);
      // Parked off to one side rather than resized: an invisible camera with a
      // zero-area viewport still reports a worldView, and chunk streaming
      // reads worldViews.
      this.cam2.setViewport(0, 0, 1, 1);
    }
    this.cam2.setVisible(split);
  }

  /**
   * Someone arrived for a slot. Idempotent, and one-way: a slot that has been
   * played never goes quiet again, so a phone dropping its connection doesn't
   * yank half the screen away mid-game.
   */
  private activateSlot(slot: Slot) {
    if (this.activeSlots.has(slot)) return;
    this.activeSlots.add(slot);

    const arriving = this.players.get(slot);
    const host = this.players.get(slot === 1 ? 2 : 1);
    if (arriving && host) {
      // Land beside the player already out there, not back at the Fabricator.
      // In an endless world "spawn at base" can mean a twenty-minute walk.
      const spot = this.freeSpotNear(host.sprite.x, host.sprite.y);
      arriving.sprite.setPosition(spot.x, spot.y);
      arriving.sprite.setVisible(true);
      arriving.label.setVisible(true);
      (arriving.sprite.body as Phaser.Physics.Arcade.Body).enable = true;
      this.materializeFlash(spot.x, spot.y, 48);
      this.floatText(spot.x, spot.y - 44, `Player ${slot} joins`, "#8fc1ff");
    }

    this.layoutCameras();
    this.onSplitChanged?.(this.activeSlots.size > 1);
    this.onSlotActivated?.(slot);
  }

  /** Called by the shell when the roster says a slot is occupied. */
  setSlotOccupied(slot: Slot) {
    this.activateSlot(slot);
  }

  /** Overlays on the screen take the keyboard while they are open. */
  setUiOpen(open: boolean) {
    this.uiOpen = open;
  }

  /** A walkable spot next to a point, spiralling out until one is dry. */
  private freeSpotNear(x: number, y: number): { x: number; y: number } {
    for (let ring = 1; ring < 8; ring++) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const px = x + Math.cos(a) * ring * 34;
        const py = y + Math.sin(a) * ring * 34;
        if (this.walkable(px, py)) return { x: px, y: py };
      }
    }
    return { x, y };
  }

  /** Called by the screen shell when a controller input arrives. */
  setInput(slot: Slot, input: PlayerInput) {
    const p = this.players.get(slot);
    if (!p) return;
    p.net = input;
    // A phone sending input is a player arriving, even if the roster
    // broadcast that would have said so got lost or arrived late.
    if (!this.activeSlots.has(slot)) this.activateSlot(slot);
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
    node.berries?.destroy();
    node.shadow?.destroy();
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
   * Manufacture a Design.
   *
   * Vehicles and tools materialise straight away and the bill is charged on
   * the spot. A structure instead goes onto the builder's shoulder as a ghost
   * and is charged when they put it down — so wandering off with one, or
   * changing your mind about where the smelter goes, costs nothing.
   */
  tryFabricate(design: PlaceableDesign, bySlot: Slot): FabricateOutcome {
    this.clearFabricating();
    const { spec } = design;
    if (!canAfford(this.stockpile, spec.cost)) {
      return {
        ok: false,
        reason: `Not enough materials for ${spec.displayName} — needs ${formatCost(spec.cost)}.`,
      };
    }
    if (spec.category === "structure") {
      const p = this.players.get(bySlot) ?? this.players.get(1)!;
      if (p.carrying) {
        return {
          ok: false,
          reason: `Put down the ${p.carrying.design.spec.displayName} first.`,
        };
      }
      this.startCarrying(p, design);
      return { ok: true, carrying: true };
    }
    this.charge(spec.cost);
    this.placeDesign(design, bySlot);
    this.onDesignBuilt?.(design.id);
    return { ok: true, carrying: false };
  }

  private charge(cost: FabricatedSpec["cost"]) {
    for (const m of MATERIALS) this.stockpile[m] -= cost[m];
    this.onStockpile?.(this.stockpile);
  }

  /** Resolve a design's art to a texture key, loading it if need be, then run
   *  `done`. Keyed by design id, so repeat builds of one design share a single
   *  texture and the art is only ever fetched once. */
  private withBodyTexture(design: PlaceableDesign, done: (key: string) => void) {
    const key = `fab-body-${design.id}`;
    const placeholder = () => {
      if (!this.textures.exists(key)) {
        const g = this.add.graphics();
        g.fillStyle(0x8b98a9, 1);
        g.fillRoundedRect(0, 0, 64, 40, 8);
        g.generateTexture(key, 64, 40);
        g.destroy();
      }
      done(key);
    };

    if (this.textures.exists(key)) {
      done(key);
    } else if (design.artUrl) {
      this.load.image(key, design.artUrl);
      this.load.once(`filecomplete-image-${key}`, () => done(key));
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

  /** Put a design into the world without charging for it — the shared path
   *  for manufacturing and for restoring a saved world. */
  private placeDesign(design: PlaceableDesign, bySlot: Slot, x?: number, y?: number) {
    this.withBodyTexture(design, (key) => {
      if (design.spec.category === "tool") this.equipTool(design, key, bySlot);
      else this.buildVehicle(design, key, x, y);
      this.markDirty();
    });
  }

  // ── carrying a structure ──────────────────────────────────────

  private startCarrying(p: PlayerEntity, design: PlaceableDesign) {
    const { w, h } = design.spec.size;
    this.withBodyTexture(design, (key) => {
      // The player may have picked up something else while the art loaded.
      if (p.carrying) return;
      const ghost = this.add
        .image(p.sprite.x, p.sprite.y, key)
        .setDisplaySize(w, h)
        .setAlpha(0.55)
        .setDepth(1e6 - 1);
      const outline = this.add
        .polygon(p.sprite.x, p.sprite.y, HEX_POINTS.flat(), 0x7fe08a, 0.16)
        // setOrigin(0) is load-bearing. Phaser sizes a Polygon from its
        // points' bounding box and then makes the display origin the CENTRE
        // of that box — which the renderer subtracts from every point. Our
        // points are already centred on (0,0), so the default origin drew the
        // outline half a hex up and to the left: it highlighted one hex and
        // the structure landed on another, which is exactly as confusing as
        // it sounds.
        .setOrigin(0, 0)
        .setDepth(1e6 - 3);
      outline.setStrokeStyle(2, 0x7fe08a, 0.95);
      const prompt = this.add
        .text(p.sprite.x, p.sprite.y + 26, "A place · B cancel", {
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: "10px",
          fontStyle: "bold",
          color: "#dfe8f4",
          backgroundColor: "rgba(8,14,26,0.6)",
          padding: { x: 5, y: 2 },
        })
        .setOrigin(0.5, 0)
        .setDepth(1e6);
      p.carrying = { design, ghost, outline, prompt, hex: { col: 0, row: 0 }, valid: false };
    });
  }

  /** Can a structure stand on this hex? */
  private canPlaceAt(col: number, row: number): boolean {
    if (isLiquid(this.biomeAtHex(col, row))) return false;
    if (this.nodeByHex.has(`${col},${row}`)) return false;
    if (this.occupied.has(`${col},${row}`)) return false;
    // Keep the Fabricator's own hex clear, or you can wall yourself out of
    // the one machine the whole game runs through.
    return !(col === this.spawn.col && row === this.spawn.row);
  }

  /** Track the carried ghost to its player and re-evaluate the hex under it. */
  private updateCarry(p: PlayerEntity) {
    const c = p.carrying;
    if (!c) return;
    // The FEET, not the sprite's middle. Everything else that asks "which
    // ground is this player on" — walkable, terrainAt, the shore slide — uses
    // the physics body's centre, and the sprite's own origin sits about 13px
    // higher, which is a quarter of a row. Asking a different question here
    // than the rest of the game asks is how the outline ends up on a hex the
    // player is not standing on.
    const feet = (p.sprite.body as Phaser.Physics.Arcade.Body).center;
    const hex = worldToHex(feet.x, feet.y);
    const centre = hexToWorld(hex.col, hex.row);
    const drop = this.dropAt(hex.col, hex.row);
    c.hex = hex;
    c.valid = this.canPlaceAt(hex.col, hex.row);

    c.ghost.setPosition(p.sprite.x, p.sprite.y - 26);
    c.ghost.setDepth(p.sprite.y + 1);
    c.outline.setPosition(centre.x, centre.y + drop);
    const tint = c.valid ? 0x7fe08a : 0xff6b6b;
    c.outline.setFillStyle(tint, 0.16);
    c.outline.setStrokeStyle(2, tint, 0.95);
    c.prompt.setPosition(p.sprite.x, p.sprite.y + 26);
    c.prompt.setText(c.valid ? "A place · B cancel" : "blocked · B cancel");
  }

  private dropCarry(p: PlayerEntity) {
    const c = p.carrying;
    if (!c) return;
    c.ghost.destroy();
    c.outline.destroy();
    c.prompt.destroy();
    p.carrying = null;
  }

  /** Commit a carried structure to the hex it is hovering over. */
  private placeCarried(p: PlayerEntity) {
    const c = p.carrying!;
    if (!c.valid) {
      this.floatText(p.sprite.x, p.sprite.y - 44, "can't build here", "#ff9f9f");
      return;
    }
    const cost = c.design.spec.cost;
    // Re-checked at placement, not at fabrication: the other player may have
    // spent the pile while this was being carried across the map.
    if (!canAfford(this.stockpile, cost)) {
      this.floatText(p.sprite.x, p.sprite.y - 44, `need ${formatCost(cost)}`, "#ff9f9f");
      return;
    }
    const centre = hexToWorld(c.hex.col, c.hex.row);
    this.charge(cost);
    this.placeDesign(c.design, p.slot, centre.x, centre.y + this.dropAt(c.hex.col, c.hex.row));
    this.onDesignBuilt?.(c.design.id);
    this.dropCarry(p);
  }

  /** Hand tools go onto the belt of the player who blueprinted them, and the
   *  newest is equipped — you built it because you wanted it now. */
  private equipTool(design: PlaceableDesign, bodyKey: string, bySlot: Slot) {
    const p = this.players.get(bySlot) ?? this.players.get(1)!;
    const already = p.belt.findIndex((t) => t.designId === design.id);
    if (already >= 0) {
      // Building a second copy of something you already carry just brings it
      // to hand: a belt with two identical drills on it is a worse belt.
      this.equip(p, already);
      return;
    }
    if (p.belt.length >= BELT_MAX) {
      // Replace what is in hand rather than refusing, so a full belt is never
      // a dead end — and never silently drops something you are not holding.
      const at = p.equipped >= 0 ? p.equipped : BELT_MAX - 1;
      p.belt[at] = { designId: design.id, spec: design.spec, bodyKey };
      this.equip(p, at);
      this.floatText(p.sprite.x, p.sprite.y - 52, "belt full — swapped", "#ffd98f");
      return;
    }
    p.belt.push({ designId: design.id, spec: design.spec, bodyKey });
    this.equip(p, p.belt.length - 1);
    this.materializeFlash(p.sprite.x, p.sprite.y, 40);
  }

  /** Put belt slot `index` in hand, or -1 for bare hands. */
  private equip(p: PlayerEntity, index: number) {
    if (p.tool) {
      p.tool.icon.destroy();
      p.tool.glow?.destroy();
      p.tool = null;
    }
    p.equipped = index >= 0 && index < p.belt.length ? index : -1;
    const held = p.equipped >= 0 ? p.belt[p.equipped] : null;
    if (held) {
      const icon = this.add.image(p.sprite.x, p.sprite.y - 34, held.bodyKey).setDepth(1e6);
      icon.setScale(22 / Math.max(icon.width, icon.height));
      let glow: Phaser.GameObjects.Image | undefined;
      if (held.spec.emission?.kind === "light") {
        glow = this.add
          .image(p.sprite.x, p.sprite.y, "glow")
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(0.8 + held.spec.emission.intensity * 1.5)
          .setDepth(DEPTH_LIGHT);
      }
      p.tool = { designId: held.designId, spec: held.spec, icon, glow };
      // A tool taken out while driving would otherwise hang in mid-air beside
      // an empty seat until the driver got out again.
      if (p.driving) {
        icon.setVisible(false);
        glow?.setVisible(false);
      }
    }
    this.pushBelt(p);
  }

  /**
   * Is this design part of the world right now?
   *
   * Deleting one that is would be worse than it looks: a built object is
   * saved as an id and a position, so the design going away means the
   * building silently fails to come back the next time the save is loaded.
   * The screen is the only place that can answer this — the server holds the
   * library, but the world lives here.
   */
  usesDesign(designId: string): { where: string } | null {
    for (const v of this.vehicles) {
      if (v.designId === designId) return { where: "it is standing in the world" };
    }
    for (const p of this.players.values()) {
      if (p.belt.some((t) => t.designId === designId)) return { where: "it is on a belt" };
      if (p.carrying?.design.id === designId) {
        return { where: "someone is carrying it" };
      }
    }
    return null;
  }

  /** Next thing on the belt, wrapping through bare hands. One control does
   *  the whole job, which is what lets a phone, a keyboard and a thumb on
   *  glass all offer it without inventing three different UIs. */
  cycleTool(slot: Slot) {
    const p = this.players.get(slot);
    if (!p || p.belt.length === 0) return;
    this.equip(p, nextBeltIndex(p.equipped, p.belt.length));
    const held = p.equipped >= 0 ? p.belt[p.equipped].spec.displayName : "bare hands";
    this.floatText(p.sprite.x, p.sprite.y - 52, held, "#8fc1ff");
  }

  private pushBelt(p: PlayerEntity) {
    this.onToolEquipped?.(p.slot, {
      equipped: p.equipped >= 0 ? p.belt[p.equipped].spec : null,
      count: p.belt.length,
      index: p.equipped,
    });
    this.markDirty();
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

    const container = this.add.container(x, y, [body, label]);
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
      spec,
      mods: normalizeModifiers(spec.locomotion.terrainModifiers, spec.locomotion.type),
      driver: null,
      passenger: null,
      nextHarvestAt: 0,
    };

    // ── emission ────────────────────────────────────────────────
    // The spec says what comes off the machine; where it comes off is the
    // renderer's business. Exhaust of every kind streams out behind — from
    // the back of a moving machine, upward from a standing one. Light is the
    // exception: it surrounds the thing rather than trailing from it.
    const em = spec.emission;
    if (em && em.kind !== "light") {
      vehicle.trail = this.makeTrail(em.kind, em.intensity);
    }
    if (em?.kind === "light") {
      vehicle.glow = this.add
        .image(x, y, "glow")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.9 + em.intensity * 1.8)
        .setDepth(DEPTH_LIGHT);
    }
    // Every vehicle kicks up its own ground, spec or no spec — it is the
    // cheapest thing that makes a machine read as moving rather than sliding.
    if (spec.category === "vehicle") {
      vehicle.dust = {
        em: this.add
          .particles(0, 0, "puff", {
            speed: { min: 4, max: 18 },
            angle: { min: 0, max: 360 },
            scale: { start: 0.35, end: 0.9 },
            alpha: { start: 0.38, end: 0 },
            lifespan: 480,
            emitting: false,
          })
          .setDepth(0),
        everyMs: 55,
        accum: 0,
      };
    }

    if (spec.category !== "vehicle") {
      const hex = worldToHex(x, y);
      this.occupied.add(`${hex.col},${hex.row}`);
    }

    this.vehicles.push(vehicle);
    this.materializeFlash(x, y, Math.max(w, h));
  }

  /** One emitter per emission kind. Rate and scale carry the intensity.
   *  All of them start idle and are pumped by hand — see Emission. */
  private makeTrail(kind: Exclude<EmissionKind, "light">, intensity: number): Emission {
    const make = (
      texture: string,
      config: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig,
      everyMs: number,
    ): Emission => ({
      em: this.add.particles(0, 0, texture, { ...config, emitting: false }).setDepth(0),
      everyMs,
      accum: 0,
    });

    switch (kind) {
      case "sparks":
        return make(
          "spark",
          {
            speed: { min: 30, max: 95 },
            angle: { min: 200, max: 340 }, // thrown up and out, then they fall
            gravityY: 190,
            scale: { start: 1, end: 0 },
            lifespan: 420,
          },
          240 - intensity * 170,
        );
      case "steam":
        // Steam is thinner and shorter-lived than smoke, and rises faster.
        return make(
          "puff",
          {
            speedY: { min: -52, max: -26 },
            speedX: { min: -10, max: 10 },
            scale: { start: 0.35 + intensity * 0.4, end: 1.5 },
            alpha: { start: 0.45, end: 0 },
            lifespan: 850,
          },
          190 - intensity * 120,
        );
      case "smoke":
      default: {
        const e = make(
          "puff",
          {
            speedY: { min: -30, max: -12 },
            speedX: { min: -8, max: 8 },
            scale: { start: 0.45 + intensity * 0.5, end: 1.7 },
            alpha: { start: 0.55, end: 0 },
            lifespan: 1400,
          },
          300 - intensity * 200,
        );
        e.em.setParticleTint(0x6f6a66);
        return e;
      }
    }
  }

  /**
   * Spawn particles at a world point, at the emission's own rate.
   *
   * The emitter never moves, so each particle stays where it was born — which
   * is the whole point of a trail. The guard caps how many can be spawned in
   * one tick, so a long frame (or a tab that was backgrounded) coughs out a
   * couple of particles rather than a hundred.
   */
  private pump(e: Emission, x: number, y: number, dtMs: number, depth: number): void {
    e.em.setDepth(depth);
    e.accum += dtMs;
    for (let i = 0; i < 4 && e.accum >= e.everyMs; i++) {
      e.accum -= e.everyMs;
      e.em.emitParticleAt(x, y);
    }
    if (e.accum > e.everyMs) e.accum = e.everyMs;
  }

  /**
   * Where a machine's exhaust comes out.
   *
   * Moving: at the body's edge, opposite the direction of travel — so it
   * leaves whichever end is currently the back, which is what "behind" has to
   * mean for something that can drive in any direction. Standing still: out
   * of the top, rising.
   */
  private trailOrigin(v: VehicleEntity): { x: number; y: number } {
    const { w, h } = v.spec.size;
    const body = v.container.body as Phaser.Physics.Arcade.Body | null;
    let vx = body?.velocity.x ?? 0;
    let vy = body?.velocity.y ?? 0;
    const len = Math.hypot(vx, vy);
    if (len < 10) return { x: v.container.x, y: v.container.y - h / 2 + 2 };
    vx /= len;
    vy /= len;
    // Distance from centre to the body's edge along the travel axis.
    const edge = Math.min(
      Math.abs(vx) > 1e-3 ? w / 2 / Math.abs(vx) : Infinity,
      Math.abs(vy) > 1e-3 ? h / 2 / Math.abs(vy) : Infinity,
    );
    return { x: v.container.x - vx * (edge + 4), y: v.container.y - vy * (edge + 4) };
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

  /**
   * One gathering tick: take 1 unit if allowed.
   *
   * `into` is the pack it goes into, or null to bank it straight to the
   * shared stockpile — which is what an unattended structure does, and its
   * whole advantage: it never has to walk anything home.
   */
  /** Why a swing produced nothing, so the caller can say which it was — a
   *  full pack and the wrong tool used to print both messages at once. */
  private harvestHit(
    node: ResourceNode,
    materials: readonly CarryType[],
    into: PlayerEntity | null,
  ): "ok" | "wrong-tool" | "full" {
    if (!gathers(materials, node.material)) return "wrong-tool";
    if (into && packLoad(into.pack) >= this.capacityOf(into)) return "full";
    node.remaining -= 1;
    this.harvestDeltas.set(`${node.col},${node.row}`, {
      col: node.col,
      row: node.row,
      remaining: Math.max(0, node.remaining),
    });
    if (into) {
      into.pack[node.material] += 1;
      // Born at the node, so the follow carries it up onto the pile.
      this.syncStack(into, node.cx, node.cy - 20);
      this.pushVitals(into);
    } else if (node.material !== "food") {
      this.addStock(node.material, 1);
    }
    this.markDirty();

    this.tweens.add({ targets: node.sprite, scale: { from: 1.12, to: 1 }, duration: 120 });
    this.floatText(node.cx, node.cy - 40, `+1 ${node.material}`, "#c9e77f");

    if (node.remaining <= 0) this.removeNode(node, true);
    return "ok";
  }

  // ── wildlife ──────────────────────────────────────────────────

  /** Nests for a chunk, from the same deterministic field as everything else. */
  private loadChunkNests(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    if (this.nestsByChunk.has(key)) return;
    const list: Nest[] = [];
    for (let row = cy * CHUNK_ROWS; row < (cy + 1) * CHUNK_ROWS; row++) {
      for (let col = cx * CHUNK_COLS; col < (cx + 1) * CHUNK_COLS; col++) {
        const biome = this.biomeAtHex(col, row);
        // nestAt keeps the landing site clear itself — it is where you learn
        // the game and where you run to, and neither works with a burrow
        // next door.
        const species = nestAt(col, row, this.seed, biome, this.spawn);
        if (!species) continue;
        const c = hexToWorld(col, row);
        const y = c.y + this.dropAt(col, row);
        list.push({
          species,
          x: c.x,
          y,
          sprite: this.add.image(c.x, y + 4, "nest").setOrigin(0.5, 0.8).setDepth(y - 2),
          brood: [],
          nextSpawnAt: 0,
        });
      }
    }
    if (list.length) this.nestsByChunk.set(key, list);
  }

  private unloadChunkNests(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    const list = this.nestsByChunk.get(key);
    if (!list) return;
    for (const nest of list) {
      for (const e of nest.brood) {
        this.tweens.killTweensOf(e.sprite);
        e.sprite.destroy();
      }
      nest.sprite.destroy();
    }
    this.nestsByChunk.delete(key);
  }

  private spawnEnemy(nest: Nest, now: number): void {
    const def = SPECIES[nest.species];
    const angle = this.rng() * Math.PI * 2;
    const x = nest.x + Math.cos(angle) * 26;
    const y = nest.y + Math.sin(angle) * 18;
    const sprite = this.physics.add.sprite(x, y, def.idle);
    sprite.setScale(def.size / sprite.height);
    sprite.body!.setSize(sprite.width * 0.7, sprite.height * 0.55);
    this.physics.add.collider(sprite, this.obstacles);
    nest.brood.push({
      species: nest.species,
      def,
      sprite,
      home: { x: nest.x, y: nest.y },
      health: def.health,
      target: null,
      lostFor: 0,
      nextBiteAt: 0,
      nextWanderAt: now,
      wander: { x, y },
      flashUntil: 0,
      dying: false,
    });
  }

  /**
   * The whole of enemy behaviour.
   *
   * Chase the nearest player in range; give up once they have been clear for
   * a moment or once home is too far behind; otherwise potter about near the
   * nest. Nothing here is clever — the point is that it is predictable, so
   * running is always the right answer and always works.
   */
  private runEnemies(now: number, dtMs: number, night: number): void {
    const dt = dtMs / 1000;
    const aggro = AGGRO_RANGE * (1 + night * AGGRO_NIGHT_BONUS);

    for (const list of this.nestsByChunk.values()) {
      for (const nest of list) {
        const def = SPECIES[nest.species];
        if (nest.brood.length < def.brood && now >= nest.nextSpawnAt) {
          nest.nextSpawnAt = now + NEST_RESPAWN_MS;
          this.spawnEnemy(nest, now);
        }

        for (let i = nest.brood.length - 1; i >= 0; i--) {
          const e = nest.brood[i];
          if (!e.sprite.active) {
            nest.brood.splice(i, 1);
            continue;
          }
          if (e.dying) continue; // fading out; it neither chases nor bites
          this.stepEnemy(e, now, dt, aggro);
        }
      }
    }
  }

  private stepEnemy(e: Enemy, now: number, dt: number, aggro: number): void {
    const body = e.sprite.body as Phaser.Physics.Arcade.Body;
    const homeDist = Phaser.Math.Distance.Between(
      e.sprite.x,
      e.sprite.y,
      e.home.x,
      e.home.y,
    );

    // ── who, if anyone, are we after ──
    // Standing on warded ground calls the whole thing off — for the animal,
    // not the player. Checked against the ANIMAL's position so a ward defends
    // its ground rather than following whoever built it around the map.
    let target: PlayerEntity | null = null;
    if (homeDist < LEASH_RANGE && !this.isWarded(e.sprite.x, e.sprite.y)) {
      let best = Infinity;
      for (const p of this.players.values()) {
        if (!this.activeSlots.has(p.slot) || p.driving) continue; // riders are safe
        // …and a player inside a ward is off the menu wherever the animal is.
        if (this.isWarded(p.sprite.x, p.sprite.y)) continue;
        const d = Phaser.Math.Distance.Between(e.sprite.x, e.sprite.y, p.sprite.x, p.sprite.y);
        // Already chasing? Keep at it out to LOSE_RANGE; otherwise you have
        // to come within aggro range to be noticed at all.
        const notice = e.target === p.slot ? LOSE_RANGE : aggro;
        if (d < notice && d < best) {
          best = d;
          target = p;
        }
      }
      if (target && best > LOSE_RANGE * 0.85) e.lostFor += dt;
      else e.lostFor = 0;
      if (e.lostFor > LOSE_TIME) target = null;
    }

    if (target) {
      if (e.target !== target.slot) e.lostFor = 0;
      e.target = target.slot;
    } else if (e.target !== null) {
      e.target = null;
      e.lostFor = 0;
    }

    // ── move ──
    const speed = e.def.speed * (WALK_MODS[this.terrainAt(e.sprite.x, e.sprite.y)] || 0.4);
    let goal: { x: number; y: number };
    if (target) {
      goal = { x: target.sprite.x, y: target.sprite.y };
    } else if (homeDist > WANDER_RANGE * 1.4) {
      goal = e.home; // too far out — head back
    } else {
      if (now >= e.nextWanderAt) {
        e.nextWanderAt = now + WANDER_EVERY * (0.5 + this.rng());
        const a = this.rng() * Math.PI * 2;
        const r = this.rng() * WANDER_RANGE;
        e.wander = { x: e.home.x + Math.cos(a) * r, y: e.home.y + Math.sin(a) * r };
      }
      goal = e.wander;
    }

    const dx = goal.x - e.sprite.x;
    const dy = goal.y - e.sprite.y;
    const dist = Math.hypot(dx, dy);
    const pace = target ? speed : speed * 0.38; // ambling, unless hunting
    if (dist > 6) {
      body.setVelocity((dx / dist) * pace, (dy / dist) * pace);
      e.sprite.setFlipX(dx < 0);
      e.sprite.setTexture(
        e.def.walk[Math.floor(now / 160) % e.def.walk.length],
      );
    } else {
      body.setVelocity(0, 0);
      e.sprite.setTexture(e.def.idle);
    }
    e.sprite.setDepth(e.sprite.y);

    if (e.flashUntil && now > e.flashUntil) {
      e.sprite.clearTint();
      e.flashUntil = 0;
    }

    // ── bite ──
    if (!target || now < e.nextBiteAt) return;
    if (Phaser.Math.Distance.Between(e.sprite.x, e.sprite.y, target.sprite.x, target.sprite.y) > BITE_RANGE) {
      return;
    }
    e.nextBiteAt = now + BITE_COOLDOWN;
    this.damagePlayer(target, e.def.damage, e.sprite.x, e.sprite.y);
  }

  private damagePlayer(p: PlayerEntity, amount: number, fromX: number, fromY: number) {
    p.health -= amount;
    const away = new Phaser.Math.Vector2(p.sprite.x - fromX, p.sprite.y - fromY)
      .normalize()
      .scale(BITE_KNOCKBACK);
    (p.sprite.body as Phaser.Physics.Arcade.Body).setVelocity(away.x, away.y);
    p.sprite.setTint(0xff6b6b);
    this.time.delayedCall(180, () => p.sprite.clearTint());
    this.floatText(p.sprite.x, p.sprite.y - 46, `−${amount}`, "#ff6b6b");
    this.cameras.main.shake(120, 0.006);
    if (p.health <= 0) this.killPlayer(p);
    else this.pushVitals(p);
  }

  /** Nearest living animal within `range` of a player, or null. */
  private enemyWithin(p: PlayerEntity, range: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = range;
    for (const list of this.nestsByChunk.values()) {
      for (const nest of list) {
        for (const e of nest.brood) {
          if (e.dying || !e.sprite.active) continue;
          const d = Phaser.Math.Distance.Between(
            p.sprite.x,
            p.sprite.y,
            e.sprite.x,
            e.sprite.y,
          );
          if (d < bestDist) {
            bestDist = d;
            best = e;
          }
        }
      }
    }
    return best;
  }

  /**
   * Swing at the nearest animal — with whatever you're carrying.
   *
   * Bare hands always work, which keeps being cornered survivable for someone
   * who has built nothing. A fabricated weapon is strictly a trade against
   * those numbers: further, harder, or faster, and the cost system charges
   * for all three.
   */
  private trySwing(p: PlayerEntity, now: number): boolean {
    if (now < p.nextShoveAt) return false;
    const w = p.tool?.spec.weapon;
    const reach = w?.reach ?? HAND_REACH;
    const target = this.enemyWithin(p, reach);
    if (!target) return false;

    const damage = w?.damage ?? HAND_DAMAGE;
    p.nextShoveAt = now + (w ? w.cooldown * 1000 : HAND_COOLDOWN);
    target.health -= damage;

    const away = new Phaser.Math.Vector2(
      target.sprite.x - p.sprite.x,
      target.sprite.y - p.sprite.y,
    )
      .normalize()
      .scale(damage * HIT_KNOCKBACK);
    (target.sprite.body as Phaser.Physics.Arcade.Body).setVelocity(away.x, away.y);
    target.sprite.setTexture(target.def.hit);
    target.sprite.setTint(0xffd0d0);
    target.flashUntil = now + 220;
    this.floatText(target.sprite.x, target.sprite.y - 26, `−${Math.round(damage)}`, "#ffd8a8");
    // An arc of the swing, so a long weapon visibly reaches further than a fist.
    const arc = this.add
      .circle(p.sprite.x, p.sprite.y, reach * 0.5, 0xffe9a8, 0.14)
      .setDepth(p.sprite.y - 1);
    this.tweens.add({
      targets: arc,
      radius: reach,
      alpha: 0,
      duration: 180,
      onComplete: () => arc.destroy(),
    });

    if (target.health <= 0) this.killEnemy(target, p);
    return true;
  }

  private killEnemy(e: Enemy, by: PlayerEntity) {
    if (e.dying) return;
    e.dying = true;
    e.sprite.setTexture(e.def.dead);
    e.sprite.clearTint();
    (e.sprite.body as Phaser.Physics.Arcade.Body).enable = false;
    this.tweens.add({
      targets: e.sprite,
      alpha: 0,
      duration: 700,
      delay: 250,
      onComplete: () => e.sprite.destroy(),
    });
    // Something to eat. Not much — hunting shouldn't out-earn foraging, it
    // should just mean a fight you won wasn't for nothing.
    if (packLoad(by.pack) < this.capacityOf(by)) {
      by.pack.food += 1;
      this.syncStack(by, e.sprite.x, e.sprite.y - 14);
      this.floatText(e.sprite.x, e.sprite.y - 30, "+1 food", "#c9e77f");
      this.pushVitals(by);
    }
  }

  // ── survival ──────────────────────────────────────────────────

  // ── the carried stack ─────────────────────────────────────────

  /** Stacking order, bottom to top. Grouped by kind rather than by pickup
   *  order: a woodpile with a rock in the middle of it looks like a mistake,
   *  and grouping falls out of the counts for free. */
  private static readonly STACK_ORDER: readonly CarryType[] = CARRIABLE;

  /**
   * Reconcile the visible pile to what's actually in the pack.
   *
   * New items are born wherever they came from — the tree, the boulder, the
   * pack on the ground — and the per-frame follow does the rest, so a log
   * flies up onto the stack without anyone writing a tween for it.
   */
  private syncStack(p: PlayerEntity, fromX?: number, fromY?: number) {
    const wanted: CarryType[] = [];
    for (const type of WorldScene.STACK_ORDER) {
      for (let i = 0; i < Math.floor(p.pack[type]); i++) wanted.push(type);
    }

    // Trim from the top, and re-key anything whose kind no longer matches.
    while (p.stack.length > wanted.length) p.stack.pop()!.img.destroy();
    for (let i = 0; i < p.stack.length; i++) {
      if (p.stack[i].type === wanted[i]) continue;
      p.stack[i].type = wanted[i];
      p.stack[i].img.setTexture(`carry-${wanted[i]}`);
    }
    for (let i = p.stack.length; i < wanted.length; i++) {
      const x = fromX ?? p.sprite.x;
      const y = fromY ?? p.sprite.y + STACK_BASE;
      const img = this.add
        .image(x, y, `carry-${wanted[i]}`)
        .setFlipX(i % 2 === 1)
        .setDepth(1e6 - 5);
      // Deterministic from the index, so an item doesn't jump when the pile
      // is rebuilt around it.
      const wobble = Math.sin(i * 12.9898) * 43758.5453;
      const frac = wobble - Math.floor(wobble);
      p.stack.push({
        img,
        type: wanted[i],
        bx: x,
        by: y,
        jx: (frac - 0.5) * 3.4,
        tilt: (frac - 0.5) * 0.16,
      });
    }
  }

  /** Drop the whole pile at once — death, or handing it over. */
  private clearStack(p: PlayerEntity) {
    for (const item of p.stack) item.img.destroy();
    p.stack.length = 0;
  }

  /** One item leaves the top and flies to the machine. The visible half of
   *  depositing: the counter going up is the receipt, this is the payment. */
  private flyTo(
    type: CarryType,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) {
    const img = this.add.image(from.x, from.y, `carry-${type}`).setDepth(1e6 - 4);
    const midX = (from.x + to.x) / 2;
    const midY = Math.min(from.y, to.y) - 46;
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 420,
      ease: "Quad.easeIn",
      onUpdate: (tw) => {
        // A quadratic arc, so it lobs into the machine rather than sliding.
        const t = tw.getValue() ?? 0;
        const u = 1 - t;
        img.x = u * u * from.x + 2 * u * t * midX + t * t * to.x;
        img.y = u * u * from.y + 2 * u * t * midY + t * t * (to.y + 6);
        img.setScale(1 - t * 0.5);
        img.setAlpha(1 - t * 0.35);
      },
      onComplete: () => {
        img.destroy();
        this.materializeFlash(to.x, to.y + 6, 22);
      },
    });
  }

  /**
   * Make the pile trail its owner. Each item chases the one below it, so the
   * lag compounds upward and the top of a full stack swings noticeably wide.
   */
  private updateStacks(dtMs: number) {
    const k = Math.min(1, (STACK_FOLLOW * dtMs) / 1000);
    for (const p of this.players.values()) {
      if (!p.stack.length) continue;
      // Riding a machine hides you, and your luggage with you.
      const visible = p.sprite.visible;
      let leadX = p.sprite.x;
      let leadY = p.sprite.y + STACK_BASE;
      for (let i = 0; i < p.stack.length; i++) {
        const item = p.stack[i];
        item.img.setVisible(visible);
        item.bx += (leadX - item.bx) * k;
        item.by += (leadY - item.by) * k;

        const dx = item.bx - leadX;
        const dy = item.by - leadY;
        const slack = Math.hypot(dx, dy);
        if (slack > STACK_MAX_LEAN) {
          item.bx = leadX + (dx / slack) * STACK_MAX_LEAN;
          item.by = leadY + (dy / slack) * STACK_MAX_LEAN;
        }
        // Lean by how far this item is trailing — the lag compounds upward,
        // so the top of the pile tips hardest and a corner looks like one.
        const lean = ((leadX - item.bx) / STACK_MAX_LEAN) * 0.22;
        item.img.setPosition(item.bx + item.jx, item.by);
        item.img.setRotation(lean + item.tilt);
        item.img.setScale(1 - i * STACK_SHRINK);
        item.img.setDepth(p.sprite.y + 1 + i * 0.01);
        leadX = item.bx;
        leadY = item.by - STACK_STEP;
      }
    }
  }

  /** What this player can carry: their own back, plus whatever they built to
   *  carry things in. */
  private capacityOf(p: PlayerEntity): number {
    return PACK_CAPACITY + (p.tool?.spec.storage?.capacity ?? 0);
  }

  private pushVitals(p: PlayerEntity) {
    this.onVitals?.(p.slot, {
      health: p.health,
      hunger: p.hunger,
      pack: { ...p.pack },
      capacity: this.capacityOf(p),
    });
  }

  /**
   * Hunger, health and eating, once per frame per living player.
   *
   * Eating is automatic. With two buttons already spoken for, an "eat" key
   * would have to displace something you need more often — and being told
   * you are starving while holding berries is not interesting, it is fiddly.
   */
  private runVitals(p: PlayerEntity, dtMs: number, moving: boolean, sprinting: boolean) {
    const dt = dtMs / 1000;
    const effort = sprinting ? HUNGER_SPRINT : moving ? HUNGER_WALK : 1;
    p.hunger = Math.max(0, p.hunger - HUNGER_DRAIN * effort * dt);

    if (p.hunger < AUTO_EAT_AT && p.pack.food > 0) {
      p.pack.food -= 1;
      this.syncStack(p);
      p.hunger = Math.min(HUNGER_MAX, p.hunger + FOOD_VALUE);
      this.floatText(p.sprite.x, p.sprite.y - 46, `ate · +${FOOD_VALUE}`, "#c9e77f");
    }

    if (p.hunger <= 0) {
      p.health -= STARVE_DAMAGE * dt;
      if (p.health <= 0) {
        this.killPlayer(p);
        return;
      }
    } else if (p.hunger > HEAL_HUNGER && p.health < HEALTH_MAX) {
      p.health = Math.min(HEALTH_MAX, p.health + HEAL_RATE * dt);
    }
    this.pushVitals(p);
  }

  /** Standing at the machine unloads your pack into the shared pile. There is
   *  no deposit button: arriving is the action. */
  private depositAtFabricator(p: PlayerEntity, dtMs: number) {
    this.depositInto(p, dtMs, this.pad);
  }

  private depositInto(p: PlayerEntity, dtMs: number, into: { x: number; y: number }) {
    // Whole units, paced by an accumulator — never a fraction per frame.
    // Materials are counted in whole things, and moving them a sliver at a
    // time accumulates float error: twenty wood deposited across a hundred
    // frames arrives as 19.983, which the HUD floors to 19. Nobody would
    // ever find that bug from the outside; they'd just feel robbed.
    p.depositCarry += (DEPOSIT_RATE * dtMs) / 1000;
    let units = Math.floor(p.depositCarry);
    if (units <= 0) return;
    p.depositCarry -= units;

    let any = false;
    for (const m of ["wood", "stone", "bogiron"] as const) {
      while (units > 0 && p.pack[m] >= 1) {
        // Throw from wherever the top of the pile currently is, before the
        // stack is rebuilt a line below — otherwise it launches from the
        // player's feet and the hand-off doesn't read.
        const top = p.stack[p.stack.length - 1]?.img;
        this.flyTo(m, top ?? { x: p.sprite.x, y: p.sprite.y + STACK_BASE }, into);
        p.pack[m] -= 1;
        this.stockpile[m] += 1;
        units -= 1;
        any = true;
      }
    }
    if (!any) return;
    this.syncStack(p);
    this.onStockpile?.(this.stockpile);
    this.pushVitals(p);
    this.markDirty();
  }

  /**
   * Death, the stress-free version: your load stays where you fell, you wake
   * up at the Fabricator, and the shared stockpile is never touched. The cost
   * of dying is the walk back to whatever you were carrying.
   */
  private killPlayer(p: PlayerEntity) {
    if (p.driving) this.exitVehicle(p);
    if (p.carrying) this.dropCarry(p);

    if (packLoad(p.pack) > 0) this.dropPack(p);
    p.pack = emptyPack();
    this.clearStack(p);
    // You come back winded, not fresh — but never so weak that waking up is
    // immediately another death.
    p.health = HEALTH_MAX * 0.6;
    p.hunger = HUNGER_MAX * 0.5;

    const spot = this.freeSpotNear(this.pad.x, this.pad.y + 60);
    p.sprite.setPosition(spot.x, spot.y);
    this.materializeFlash(spot.x, spot.y, 56);
    this.floatText(spot.x, spot.y - 46, "you wake at the Fabricator", "#8fc1ff");
    this.pushVitals(p);
    this.markDirty();
  }

  private dropPack(p: PlayerEntity) {
    const x = p.sprite.x;
    const y = p.sprite.y;
    const sprite = this.add.image(x, y, "pack").setDepth(y - 1);
    const label = this.add
      .text(x, y - 22, `${Math.floor(packLoad(p.pack))} carried`, {
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: "10px",
        fontStyle: "bold",
        color: "#ffcf8f",
        backgroundColor: "rgba(8,14,26,0.6)",
        padding: { x: 4, y: 1 },
      })
      .setOrigin(0.5, 1)
      .setDepth(1e6);
    this.drops.push({ sprite, label, contents: { ...p.pack }, x, y });
  }

  /** Pick up a dropped pack, as much of it as will fit. */
  private tryCollectDrop(p: PlayerEntity): boolean {
    const near = this.drops.find(
      (d) => Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, d.x, d.y) < 52,
    );
    if (!near) return false;
    let room = this.capacityOf(p) - packLoad(p.pack);
    let took = 0;
    for (const m of ["wood", "stone", "bogiron", "food"] as const) {
      if (room <= 0) break;
      const take = Math.min(near.contents[m], room);
      if (take <= 0) continue;
      near.contents[m] -= take;
      p.pack[m] += take;
      room -= take;
      took += take;
    }
    if (took <= 0) {
      this.floatText(p.sprite.x, p.sprite.y - 46, "no room", "#ff9f9f");
      return true;
    }
    this.syncStack(p, near.x, near.y - 14);
    this.floatText(near.x, near.y - 34, `+${Math.floor(took)} recovered`, "#c9e77f");
    if (packLoad(near.contents) <= 0.01) {
      near.sprite.destroy();
      near.label.destroy();
      this.drops.splice(this.drops.indexOf(near), 1);
    } else {
      near.label.setText(`${Math.floor(packLoad(near.contents))} carried`);
    }
    this.pushVitals(p);
    this.markDirty();
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
      tools: [...this.players.values()].flatMap((p) =>
        p.belt.map((t) => ({ slot: p.slot, designId: t.designId })),
      ),
      equipped: [...this.players.values()].map((p) => ({ slot: p.slot, index: p.equipped })),
      vitals: [...this.players.values()].map((p) => ({
        slot: p.slot,
        health: Math.round(p.health),
        hunger: Math.round(p.hunger),
        pack: { ...p.pack },
      })),
      drops: this.drops.map((d) => ({
        x: Math.round(d.x),
        y: Math.round(d.y),
        pack: { ...d.contents },
      })),
    };
  }

  /** Apply a saved world over the generated terrain. `resolve` looks up a
   *  Design by id (the catalog arrives on the same socket). */
  applySnapshot(
    snap: WorldSnapshot,
    resolve: (designId: string) => PlaceableDesign | null,
  ): void {
    // A save from before a material existed simply has no key for it. Merging
    // onto a full zeroed set means an old world opens with an empty seam
    // count rather than NaN the first time someone mines one.
    this.stockpile = {
      ...(Object.fromEntries(MATERIALS.map((m) => [m, 0])) as Stockpile),
      ...snap.stockpile,
    };
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
    // Restoring a belt equips each tool as it lands, so whatever was actually
    // in hand has to be put back afterwards. Without the record — an older
    // save — the last one restored stays in hand, which is what that save
    // meant when it only ever held one.
    for (const e of snap.equipped ?? []) {
      const p = this.players.get(e.slot);
      if (p) this.equip(p, e.index);
    }

    for (const v of snap.vitals ?? []) {
      const p = this.players.get(v.slot);
      if (!p) continue;
      p.health = v.health;
      p.hunger = v.hunger;
      p.pack = { ...emptyPack(), ...v.pack };
      this.syncStack(p);
      this.pushVitals(p);
    }
    // A pack you died next to is still there when you come back tomorrow.
    for (const d of snap.drops ?? []) {
      const sprite = this.add.image(d.x, d.y, "pack").setDepth(d.y - 1);
      const label = this.add
        .text(d.x, d.y - 22, `${Math.floor(d.pack.wood + d.pack.stone + d.pack.bogiron + d.pack.food)} carried`, {
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: "10px",
          fontStyle: "bold",
          color: "#ffcf8f",
          backgroundColor: "rgba(8,14,26,0.6)",
          padding: { x: 4, y: 1 },
        })
        .setOrigin(0.5, 1)
        .setDepth(1e6);
      this.drops.push({ sprite, label, contents: { ...emptyPack(), ...d.pack }, x: d.x, y: d.y });
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
    // While a screen overlay is up, the keyboard belongs to it — otherwise
    // typing a blueprint's name walks your character into the bog.
    if (!k || this.uiOpen) return null;
    const [up, down, left, right, a, b] =
      slot === 1
        ? [k.W, k.S, k.A, k.D, k.F, k.G]
        : [k.UP, k.DOWN, k.LEFT, k.RIGHT, k.K, k.L];
    const x = (right.isDown ? 1 : 0) - (left.isDown ? 1 : 0);
    const y = (down.isDown ? 1 : 0) - (up.isDown ? 1 : 0);
    if (!x && !y && !a.isDown && !b.isDown) return null;
    // Touching the second player's keys IS the second player arriving.
    if (!this.activeSlots.has(slot)) this.activateSlot(slot);
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
    const dtMs = this.game.loop.delta;

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
      if (!v.glow) continue;
      // Light surrounds the machine rather than hanging off a lamp anchor.
      v.glow.setPosition(v.container.x, v.container.y);
      // Invisible at noon and full strength at midnight.
      v.glow.setAlpha(0.25 + night * 0.75);
    }
    for (const p of this.players.values()) {
      // Nobody is playing this slot yet; its character stays parked.
      if (!this.activeSlots.has(p.slot)) {
        this.keyboardInput(p.slot); // still watched, so arriving wakes it up
        continue;
      }
      const input = this.keyboardInput(p.slot) ?? p.net;
      const aEdge = input.buttons.a && !p.prevA;
      const bEdge = input.buttons.b && !p.prevB;
      p.prevA = input.buttons.a;
      p.prevB = input.buttons.b;

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
      const sprinting = input.buttons.b;
      // Hungry legs are slow legs — the warning arrives well before the harm.
      const hungerMod = p.hunger < HUNGER_LOW ? HUNGRY_SPEED : 1;
      const speed = WALK_SPEED * mod * hungerMod * (sprinting ? SPRINT_MULT : 1);
      const [vx, vy] = stranded
        ? [input.stick.x * speed, input.stick.y * speed]
        : this.slideAlongShore(feet, input.stick, speed);
      p.sprite.setVelocity(vx, vy);

      const moving = Math.hypot(input.stick.x, input.stick.y) > 0.1;
      this.animatePlayer(p, input.stick.x, input.stick.y, moving);
      this.runVitals(p, dtMs, moving, sprinting && moving);
      if (p.atFabricator) this.depositAtFabricator(p, dtMs);

      // Carrying a structure takes over both buttons: A puts it down on the
      // outlined hex, B calls the whole thing off. Nothing else — you can't
      // gather or board a vehicle with a smelter on your shoulder.
      if (p.carrying) {
        this.updateCarry(p);
        if (aEdge) this.placeCarried(p);
        else if (bEdge) {
          this.floatText(p.sprite.x, p.sprite.y - 44, "put back", "#8fc1ff");
          this.dropCarry(p);
        }
        p.sprite.setDepth(p.sprite.y);
        p.label.setPosition(p.sprite.x, p.sprite.y - p.sprite.displayHeight + 6);
        continue;
      }

      // A near a node = gather (hold). Otherwise A-edge = enter / ping.
      //
      // Unless something is actually on you: with one action button, gathering
      // wins ties, and standing at a tree with a spider biting your ankles
      // would mean pressing A to chop wood while you take damage. Anything
      // inside biting distance takes the button.
      const underAttack = aEdge && this.enemyWithin(p, BITE_RANGE + 10);
      const node = underAttack
        ? null
        : this.nearestNode(p.sprite.x, p.sprite.y, HARVEST_RANGE);
      if (node && input.buttons.a) {
        const rate = p.tool?.spec.harvest?.rate ?? HAND_RATE;
        const materials = p.tool?.spec.harvest?.materials ?? HAND_MATERIALS;
        if (now >= p.nextHarvestAt) {
          const hit = this.harvestHit(node, materials, p);
          if (hit === "ok") {
            p.nextHarvestAt = now + 1000 / rate;
          } else {
            // Name the ore. "Needs a better tool" standing in front of four
            // different seams tells you nothing about which tool to build.
            this.floatText(
              node.cx,
              node.cy - 40,
              hit === "full" ? "pack is full" : `needs a ${node.material} harvester`,
              "#ff9f9f",
            );
            p.nextHarvestAt = now + 700;
          }
        }
      } else if (aEdge) {
        // Priority order is what you'd reach for: your dropped load first,
        // then a machine to climb into, then the ping.
        if (this.tryCollectDrop(p)) {
          // collected
        } else if (this.trySwing(p, now)) {
          // saw something off
        } else {
          const vehicle = this.nearestEnterableVehicle(p);
          if (vehicle) this.enterVehicle(p, vehicle);
          else this.ping(p);
        }
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

    this.updateStacks(dtMs);
    this.trackRegions();
    this.runStructureServices(dtMs);
    this.runEnemies(now, dtMs, night);
    this.runStructureEmissions();
    this.runAutomation(now);
    this.updateFabricatorPresence(now);
    this.updatePointers();
    // Last: the cameras have finished following by now, so the chunks we
    // stream are the ones about to be on screen rather than last frame's.
    this.field.update(cams);
  }

  /**
   * Who is standing at the Fabricator. Fired on the edge only, so the phone
   * gets one message when you arrive and one when you leave rather than
   * thirty a second.
   */
  private updateFabricatorPresence(now: number): void {
    let anyone = false;
    const nearSlots: Slot[] = [];
    for (const p of this.players.values()) {
      // A parked player is standing on the pad but isn't anybody, so they
      // must not keep the machine lit up in a solo game.
      if (!this.activeSlots.has(p.slot)) continue;
      const near =
        Phaser.Math.Distance.Between(p.sprite.x, p.sprite.y, this.pad.x, this.pad.y) <
        FABRICATOR_RANGE;
      anyone ||= near;
      if (near) nearSlots.push(p.slot);
      if (near === p.atFabricator) continue;
      p.atFabricator = near;
      this.onFabricatorRange?.(p.slot, near);
      if (near) this.floatText(this.pad.x, this.pad.y - 52, "Fabricator ready", "#8fc1ff");
    }

    this.padRing.setVisible(anyone);
    this.padPrompt.setVisible(anyone);
    this.padLabel.setAlpha(anyone ? 1 : 0.55);
    if (anyone) {
      // Name the actual key for whoever is standing here. The phone is the
      // other way in, not the only one, and a prompt that only mentions it
      // reads as "you need a phone" to someone playing on a keyboard.
      this.padPrompt.setText(
        `press ${nearSlots.join(" or ")} · or BLUEPRINT on your phone`,
      );
    }
    if (anyone) {
      // A slow breath rather than a tween: no object to leak, and it stops
      // dead the moment nobody is there.
      const pulse = (Math.sin(now / 420) + 1) / 2;
      this.padRing.setScale(0.94 + pulse * 0.1);
      this.padRing.setAlpha(0.35 + pulse * 0.4);
    }
  }

  /** The authoritative range check. The phone disables its own buttons, but a
   *  message can still arrive late or from a stale view, so building is
   *  verified here — where the simulation actually lives. */
  isAtFabricator(slot: Slot): boolean {
    return this.players.get(slot)?.atFabricator ?? false;
  }

  /**
   * Announce when someone walks into new country.
   *
   * The name is computed, never stored — the same ground is the Ashen Reach
   * on both screens and in every future session because both machines derive
   * it from the seed rather than agreeing on it.
   */
  private trackRegions() {
    for (const p of this.players.values()) {
      if (!this.activeSlots.has(p.slot)) continue;
      const h = worldToHex(p.sprite.x, p.sprite.y);
      const region = regionAt(h.col, h.row, this.seed);
      if (p.region && sameRegion(p.region, region)) continue;
      const first = p.region === null;
      p.region = region;
      if (!first) {
        this.floatText(p.sprite.x, p.sprite.y - 52, regionName(region, this.seed), "#dfe8f4");
      }
    }
  }

  /** Where a player is, in words. */
  regionNameFor(slot: Slot): string {
    const p = this.players.get(slot);
    if (!p) return "";
    const h = worldToHex(p.sprite.x, p.sprite.y);
    return regionName(regionAt(h.col, h.row, this.seed), this.seed);
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
      if (!this.activeSlots.has(slot) || this.activeSlots.size < 2) {
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

  /** A structure is always running, so its exhaust rises whether or not
   *  anyone is watching. Vehicles are pumped from the drive loop instead —
   *  they only smoke while someone has the wheel. */
  private runStructureEmissions(): void {
    const dt = this.game.loop.delta;
    for (const v of this.vehicles) {
      if (v.spec.category === "vehicle" || !v.trail) continue;
      const o = this.trailOrigin(v);
      this.pump(v.trail, o.x, o.y, dt, o.y);
    }
  }

  /**
   * Everything a building does just by standing there: depots take your load,
   * farms hand out food, wards keep the wildlife off.
   *
   * All three are proximity effects on the ground around the thing, which is
   * why they are structures-only in the schema — a depot you can drive away
   * is just a pack, and a ward that follows you is a bodyguard.
   */
  private runStructureServices(dtMs: number) {
    for (const v of this.vehicles) {
      if (v.spec.category !== "structure") continue;
      const reach = Math.max(v.spec.size.w, v.spec.size.h) / 2 + 46;

      for (const p of this.players.values()) {
        if (!this.activeSlots.has(p.slot) || p.driving) continue;
        const d = Phaser.Math.Distance.Between(
          p.sprite.x,
          p.sprite.y,
          v.container.x,
          v.container.y,
        );
        if (d > reach) continue;

        // A depot is a second Fabricator as far as unloading goes. Building
        // one next to a distant grove is the whole point: it turns a long
        // haul into a short one.
        if (v.spec.storage) this.depositInto(p, dtMs, v.container);

        // A farm tops you up while you stand in it.
        if (v.spec.nourish && packLoad(p.pack) < this.capacityOf(p)) {
          v.farmCarry = (v.farmCarry ?? 0) + (v.spec.nourish.rate * dtMs) / 60_000;
          if (v.farmCarry >= 1) {
            v.farmCarry -= 1;
            p.pack.food += 1;
            this.syncStack(p, v.container.x, v.container.y - 10);
            this.pushVitals(p);
            this.markDirty();
          }
        }
      }
    }
  }

  /** Is this spot inside something's warded ground? */
  private isWarded(x: number, y: number): boolean {
    for (const v of this.vehicles) {
      const r = v.spec.ward?.radius;
      if (!r) continue;
      if (Phaser.Math.Distance.Between(x, y, v.container.x, v.container.y) < r) return true;
    }
    return false;
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
      if (!node || !gathers(hv.materials, node.material)) {
        v.nextHarvestAt = now + 1200; // nothing in reach — check back shortly
        continue;
      }
      // Unattended: banks straight to the shared pile, since a building has
      // no legs to carry anything home with.
      this.harvestHit(node, hv.materials, null);
      v.nextHarvestAt = now + 1000 / (hv.rate * AUTOMATION_RATE);
      // A visible tick so you can tell it is earning its keep, now that there
      // is no bolted-on drill to waggle: the whole machine flinches.
      this.tweens.killTweensOf(v.bodyImg);
      v.bodyImg.setScale(1);
      this.tweens.add({
        targets: v.bodyImg,
        scaleX: { from: 1.06, to: 1 },
        scaleY: { from: 0.94, to: 1 },
        duration: 220,
        ease: "Quad.easeOut",
      });
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
      if (node && gathers(hv.materials, node.material)) {
        harvesting = true;
        if (now >= v.nextHarvestAt) {
          // Into the driver's pack: a machine hauls for whoever is aboard.
          this.harvestHit(node, hv.materials, p);
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
    // Chewing through a boulder judders harder than driving does — with the
    // running gear baked into the art, this is the only feedback that the
    // machine is actually biting something.
    const shake = (0.5 + Math.min(1, vel / 180) * 1.1) * (harvesting ? 2.1 : 1);
    v.bodyImg.setPosition(
      Math.sin(now / 23) * shake * 0.6,
      Math.sin(now / 17) * shake,
    );
    v.bodyImg.setAngle(Math.sin(now / 31) * shake * 0.5);

    const dt = this.game.loop.delta;

    // Exhaust leaves whichever end is currently the back.
    if (v.trail) {
      const o = this.trailOrigin(v);
      this.pump(v.trail, o.x, o.y, dt, o.y);
    }

    // Ground spray, from under the machine and tinted by what it's driving
    // over. Water gets none: a hull leaves a wake, not a dust cloud, and a
    // wake is a different effect than this one.
    if (v.dust) {
      const terrain = this.terrainAt(v.container.x, v.container.y);
      if (vel > 40 && terrain !== "water") {
        const y = v.container.y + v.spec.size.h / 2 - 2;
        v.dust.em.setParticleTint(DUST_TINT[terrain]);
        this.pump(v.dust, v.container.x - Math.sign(body.velocity.x) * 6, y, dt, y - 1);
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
    const players = [...this.players.values()]
      .filter((p) => this.activeSlots.has(p.slot))
      .map((p) => {
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
      region: first ? this.regionNameFor(first.slot) : "",
    };
  }

  /** Human name of the ground a player is standing on, for the HUD. */
  biomeLabel(slot: Slot): string {
    const p = this.players.get(slot);
    if (!p) return "";
    return BIOMES[this.biomeAtPoint(p.sprite.x, p.sprite.y)].label;
  }
}
