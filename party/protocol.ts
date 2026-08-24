// Wire protocol shared between client and server.
//
// Roles:
//   • screen     — the shared TV/laptop screen. Runs the Phaser simulation
//                  (host-authoritative). Receives relayed controller inputs.
//   • controller — a phone. Sends joystick/button input; later also acts as
//                  the Fabricator sketch pad.
//
// The server is a thin relay + player registry. It never simulates anything.

export type Slot = 1 | 2;

export type PublicPlayer = {
  playerId: string;
  nickname: string;
  /** null when the room already had 2 players (spectator/overflow). */
  slot: Slot | null;
  connected: boolean;
};

// ─── presence ──────────────────────────────────────────────────────────────

export type IdentifyMsg = {
  scope: "presence";
  type: "identify";
  role: "screen" | "controller";
  playerId: string;
  nickname: string;
};

export type WelcomeMsg = {
  scope: "presence";
  type: "welcome";
  role: "screen" | "controller";
  /** Only meaningful for controllers. */
  slot: Slot | null;
  lobbyCode: string;
};

export type RosterMsg = {
  scope: "presence";
  type: "roster";
  players: PublicPlayer[];
  screenConnected: boolean;
};

// ─── input (controller → server → screen) ──────────────────────────────────

export type StickState = { x: number; y: number }; // each in [-1, 1]
export type ButtonState = { a: boolean; b: boolean };

export type InputMsg = {
  scope: "input";
  type: "input";
  stick: StickState;
  buttons: ButtonState;
};

/** Relayed to screens with sender identity attached. */
export type InputRelayMsg = {
  scope: "input";
  type: "input";
  playerId: string;
  slot: Slot;
  stick: StickState;
  buttons: ButtonState;
};

// ─── ui (screen ⇄ controller) ──────────────────────────────────────────────
//
// Generic channel for "the game wants your phone to show something" and the
// results coming back. Relayed opaquely by the server; `to` narrows delivery
// to one player's controller.

export type UiMsg = {
  scope: "ui";
  type: string;
  to?: string; // playerId; omitted = all controllers
  [key: string]: unknown;
};

// ─── fabricator ────────────────────────────────────────────────────────────

import type { Design, DesignSummary } from "./designs";

/** Controller → server: a blueprint submission. Relayed to screens too so
 *  the world can show the Fabricator working while the compile runs. */
export type BlueprintMsg = {
  scope: "ui";
  type: "blueprint";
  name: string;
  intent?: string;
  /** data:image/png;base64,... downscaled sketch (≤256px). */
  image?: string;
};

// ─── designs ───────────────────────────────────────────────────────────────
//
// The Fabricator produces Designs (permanent, stored server-side).
// Manufacturing spends materials to build one; a Design can be built any
// number of times. Screens get full designs (they render and simulate);
// phones get summaries (name + cost + affordability), never image payloads.

/** Server → screens: a new Design, plus the raw generated art to process. */
export type DesignAddedMsg = {
  scope: "ui";
  type: "design-added";
  design: Design;
  /** AI body sprite on a magenta background — the screen chroma-keys it
   *  and returns the result via `design-body`. */
  rawBody?: string;
};

/** Server → phones: the same event, without any image payload. */
export type DesignAddedSummaryMsg = {
  scope: "ui";
  type: "design-added";
  design: DesignSummary;
};

/** Screen → server: the chroma-keyed body sprite, for permanent storage.
 *  Server → screens: the processed art for a design. */
export type DesignBodyMsg = {
  scope: "ui";
  type: "design-body";
  designId: string;
  body: string;
};

/** Server → a joining client: everything it needs about existing designs. */
export type DesignCatalogMsg = {
  scope: "ui";
  type: "design-catalog";
  designs: Design[] | DesignSummary[];
};

/** Phone → server → screens: build this design (spends materials). */
export type ManufactureMsg = {
  scope: "ui";
  type: "manufacture";
  designId: string;
};

/** Screen → server: a design was successfully built (bumps timesBuilt). */
export type DesignBuiltMsg = {
  scope: "ui";
  type: "design-built";
  designId: string;
};

/** Screen → phones: current team stockpile, so phones can price designs. */
export type StockpileMsg = {
  scope: "ui";
  type: "stockpile";
  wood: number;
  stone: number;
  bogiron: number;
};

/** Server → everyone: the Fabricator could not compile the blueprint. */
export type FabricateErrorMsg = {
  scope: "ui";
  type: "fabricate-error";
  message: string;
};

// ─── world persistence ─────────────────────────────────────────────────────
//
// Terrain is deterministic from the room code (it seeds the world RNG), so a
// save is only the DELTAS from that baseline — a few KB even for a long
// game, instead of a serialized map.

export type WorldSnapshot = {
  v: 1;
  stockpile: { wood: number; stone: number; bogiron: number };
  /** Only nodes that have been touched; remaining 0 = harvested out. */
  harvested: { col: number; row: number; remaining: number }[];
  /** Manufactured objects, at their current position (vehicles get driven). */
  built: { designId: string; x: number; y: number }[];
  /** Equipped hand tools, by player slot. */
  tools: { slot: Slot; designId: string }[];
};

/** Screen → server: persist this snapshot (debounced). */
export type WorldSaveMsg = {
  scope: "ui";
  type: "world-save";
  snapshot: WorldSnapshot;
};

/** Server → screen on join: the saved world, or null for a fresh one. */
export type WorldStateMsg = {
  scope: "ui";
  type: "world-state";
  snapshot: WorldSnapshot | null;
};

// ─── unions ────────────────────────────────────────────────────────────────

export type ClientToServer = IdentifyMsg | InputMsg | UiMsg;
export type ServerToClient = WelcomeMsg | RosterMsg | InputRelayMsg | UiMsg;
