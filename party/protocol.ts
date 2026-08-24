// Wire protocol shared between client and server.
//
// Roles:
//   • screen     — the shared TV/laptop screen. Runs the Phaser simulation
//                  (host-authoritative) and owns the lobby: it configures the
//                  world and decides when the expedition starts.
//   • controller — a phone. In the lobby it's a name/ready pad; in play it
//                  sends joystick/button input and acts as the sketch pad.
//
// The server is a thin relay + player registry. It never simulates anything;
// the only room state it owns is the roster and the current phase (so a phone
// joining or reconnecting mid-game lands on the right screen).

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

/** Screen → server: the host started (or returned to) the lobby. */
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

import type { FabricatedSpec } from "../shared/fabricator/schema";

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

/** Server → everyone: the compiled result. */
export type FabricatedMsg = {
  scope: "ui";
  type: "fabricated";
  byPlayerId: string;
  spec: FabricatedSpec;
  image?: string;
};

/** Server → everyone: compile failed. */
export type FabricateErrorMsg = {
  scope: "ui";
  type: "fabricate-error";
  message: string;
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
