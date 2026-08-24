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

export type ClientToServer = IdentifyMsg | InputMsg | UiMsg;
export type ServerToClient = WelcomeMsg | RosterMsg | InputRelayMsg | UiMsg;
