// Wire protocol shared between client and server.
//
// Roles:
//   • screen     — the shared TV/laptop screen. Runs the Phaser simulation
//                  (host-authoritative) and owns the lobby: it decides when
//                  the expedition starts. Receives relayed controller inputs.
//   • controller — a phone. In the lobby it's a name/ready pad; in play it
//                  sends joystick/button input and acts as the sketch pad.
//
// The server is a thin relay + player registry. It never simulates anything;
// the only room state it owns is the roster, the saved world, and the current
// phase — the last so a phone joining or reconnecting mid-game lands on the
// game pad instead of the lobby.

export type Slot = 1 | 2;

/** Lobby = everyone is picking names; playing = the world is running. */
export type Phase = "lobby" | "playing";

export type PublicPlayer = {
  playerId: string;
  nickname: string;
  /** null when the room already had 2 players (spectator/overflow). */
  slot: Slot | null;
  connected: boolean;
  /** Lobby readiness. Ignored while playing. */
  ready: boolean;
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
  phase: Phase;
};

export type RosterMsg = {
  scope: "presence";
  type: "roster";
  players: PublicPlayer[];
  screenConnected: boolean;
  phase: Phase;
};

/** Controller → server: rename myself (lobby name editing). */
export type SetNicknameMsg = {
  scope: "presence";
  type: "set-nickname";
  nickname: string;
};

/** Controller → server: toggle lobby readiness. */
export type SetReadyMsg = {
  scope: "presence";
  type: "set-ready";
  ready: boolean;
};

/** Controller → server: trade P1/P2 seats with the other player. */
export type SwapSlotsMsg = {
  scope: "presence";
  type: "swap-slots";
};

/** Screen → server: the host started the expedition, or came back to the
 *  lobby. Only the screen may set this — it's the one running the sim. */
export type SetPhaseMsg = {
  scope: "presence";
  type: "set-phase";
  phase: Phase;
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
// Terrain is a pure function of the room code, so a save is only the DELTAS
// from that baseline — a few KB even for a long game, and a constant size no
// matter how far the expedition has walked.

/** Bump when a snapshot stops being readable. v1 belonged to the old bounded
 *  island world; its coordinates mean nothing on the continuous map, so those
 *  saves are dropped rather than misapplied. */
export const SNAPSHOT_VERSION = 2;

export type WorldSnapshot = {
  v: 2;
  /** The seed the terrain came from — the room code, unless a future lobby
   *  lets you type one. Stored so a save can be recognised as belonging to
   *  the world it describes. */
  seed: string;
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

export type PresenceClientMsg =
  | IdentifyMsg
  | SetNicknameMsg
  | SetReadyMsg
  | SwapSlotsMsg
  | SetPhaseMsg;

export type ClientToServer = PresenceClientMsg | InputMsg | UiMsg;
export type ServerToClient = WelcomeMsg | RosterMsg | InputRelayMsg | UiMsg;
