// Thin relay server. Keys players by persistent playerId (not connection id)
// so refreshes and wifi drops reconnect to the same slot — pattern ported
// from garage-chillen's PlayerRegistry, radically simplified for 2 players.
//
// The only room state beyond the roster is `phase`: the screen owns it (it
// runs the sim), the server just remembers it so a phone that joins or
// reconnects mid-game gets the game pad instead of the lobby.

import type * as Party from "partykit/server";
import { FabricatorEndpoint } from "./fabricator";
import type {
  BlueprintMsg,
  ClientToServer,
  FabricatedMsg,
  FabricateErrorMsg,
  IdentifyMsg,
  Phase,
  PresenceClientMsg,
  PublicPlayer,
  RosterMsg,
  Slot,
} from "./protocol";

type PlayerRecord = {
  playerId: string;
  nickname: string;
  slot: Slot | null;
  ready: boolean;
  connectionId: string | null;
};

const NICKNAME_MAX = 16;

function sanitizeNickname(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, NICKNAME_MAX) : "";
}

export default class FabricatorServer implements Party.Server {
  players = new Map<string, PlayerRecord>(); // by playerId
  connToPlayer = new Map<string, string>(); // connectionId → playerId
  screenConns = new Set<string>();
  phase: Phase = "lobby";
  fabricator: FabricatorEndpoint;

  constructor(readonly room: Party.Room) {
    this.fabricator = new FabricatorEndpoint(room.env as Record<string, unknown>);
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: ClientToServer;
    try {
      msg = JSON.parse(raw) as ClientToServer;
    } catch {
      return;
    }

    if (msg.scope === "presence") {
      this.handlePresence(msg, sender);
      return;
    }

    if (msg.scope === "input" && msg.type === "input") {
      const playerId = this.connToPlayer.get(sender.id);
      if (!playerId) return;
      const rec = this.players.get(playerId);
      if (!rec || rec.slot === null) return;
      const relay = JSON.stringify({
        scope: "input",
        type: "input",
        playerId,
        slot: rec.slot,
        stick: msg.stick,
        buttons: msg.buttons,
      });
      for (const id of this.screenConns) {
        this.room.getConnection(id)?.send(relay);
      }
      return;
    }

    if (msg.scope === "ui") {
      // Opaque relay. Screen → controllers (optionally one), controller → screens.
      const fromScreen = this.screenConns.has(sender.id);
      const out = JSON.stringify(msg);
      if (fromScreen) {
        for (const rec of this.players.values()) {
          if (!rec.connectionId) continue;
          if (msg.to && msg.to !== rec.playerId) continue;
          this.room.getConnection(rec.connectionId)?.send(out);
        }
      } else {
        for (const id of this.screenConns) {
          this.room.getConnection(id)?.send(out);
        }
      }
      // The server itself acts on blueprint submissions.
      if (!fromScreen && msg.type === "blueprint") {
        const playerId = this.connToPlayer.get(sender.id);
        if (playerId) void this.fabricate(msg as BlueprintMsg, playerId);
      }
    }
  }

  private handlePresence(msg: PresenceClientMsg, sender: Party.Connection) {
    if (msg.type === "identify") {
      this.handleIdentify(msg, sender);
      return;
    }

    // Only the screen sets the phase — it's the one running the simulation.
    if (msg.type === "set-phase") {
      if (!this.screenConns.has(sender.id)) return;
      if (msg.phase !== "lobby" && msg.phase !== "playing") return;
      if (this.phase === msg.phase) return;
      this.phase = msg.phase;
      // A fresh lobby starts with nobody ready.
      if (msg.phase === "lobby") {
        for (const rec of this.players.values()) rec.ready = false;
      }
      this.broadcastRoster();
      return;
    }

    const playerId = this.connToPlayer.get(sender.id);
    const rec = playerId ? this.players.get(playerId) : undefined;
    if (!rec) return;

    if (msg.type === "set-nickname") {
      const nickname = sanitizeNickname(msg.nickname);
      if (nickname === rec.nickname) return;
      rec.nickname = nickname;
      this.broadcastRoster();
      return;
    }

    if (msg.type === "set-ready") {
      const ready = msg.ready === true;
      if (ready === rec.ready) return;
      rec.ready = ready;
      this.broadcastRoster();
      return;
    }

    if (msg.type === "swap-slots") {
      if (this.phase !== "lobby" || rec.slot === null) return;
      const other = [...this.players.values()].find(
        (p) => p !== rec && p.slot !== null,
      );
      const mine = rec.slot;
      rec.slot = mine === 1 ? 2 : 1;
      if (other) other.slot = mine;
      this.broadcastRoster();
    }
  }

  private async fabricate(msg: BlueprintMsg, byPlayerId: string) {
    try {
      const prefix = "data:image/png;base64,";
      const spec = await this.fabricator.compile({
        name: msg.name,
        intent: msg.intent,
        imageBase64: msg.image?.startsWith(prefix)
          ? msg.image.slice(prefix.length)
          : undefined,
      });
      const done: FabricatedMsg = {
        scope: "ui",
        type: "fabricated",
        byPlayerId,
        spec,
        image: msg.image,
      };
      this.room.broadcast(JSON.stringify(done));
    } catch (err) {
      console.error("fabricate failed:", err);
      const fail: FabricateErrorMsg = {
        scope: "ui",
        type: "fabricate-error",
        message:
          err instanceof Error && err.message.includes("overheated")
            ? err.message
            : "The Fabricator sputters and rejects the blueprint. Try again.",
      };
      this.room.broadcast(JSON.stringify(fail));
    }
  }

  onClose(conn: Party.Connection) {
    if (this.screenConns.delete(conn.id)) {
      this.broadcastRoster();
      return;
    }
    const playerId = this.connToPlayer.get(conn.id);
    if (!playerId) return;
    this.connToPlayer.delete(conn.id);
    const rec = this.players.get(playerId);
    if (rec && rec.connectionId === conn.id) {
      rec.connectionId = null; // slot stays reserved for reconnect
      rec.ready = false;
      this.broadcastRoster();
    }
  }

  private handleIdentify(msg: IdentifyMsg, sender: Party.Connection) {
    if (msg.role === "screen") {
      this.screenConns.add(sender.id);
      sender.send(
        JSON.stringify({
          scope: "presence",
          type: "welcome",
          role: "screen",
          slot: null,
          lobbyCode: this.room.id,
          phase: this.phase,
        }),
      );
      this.broadcastRoster();
      return;
    }

    const nickname = sanitizeNickname(msg.nickname);
    let rec = this.players.get(msg.playerId);
    if (rec) {
      // Reconnect (or duplicate identify): rebind the connection.
      if (rec.connectionId && rec.connectionId !== sender.id) {
        this.connToPlayer.delete(rec.connectionId);
      }
      rec.connectionId = sender.id;
      // Keep the name they set in the lobby if this reconnect carries none.
      if (nickname) rec.nickname = nickname;
    } else {
      rec = {
        playerId: msg.playerId,
        nickname,
        slot: this.freeSlot(),
        ready: false,
        connectionId: sender.id,
      };
      this.players.set(msg.playerId, rec);
    }
    this.connToPlayer.set(sender.id, msg.playerId);
    sender.send(
      JSON.stringify({
        scope: "presence",
        type: "welcome",
        role: "controller",
        slot: rec.slot,
        lobbyCode: this.room.id,
        phase: this.phase,
      }),
    );
    this.broadcastRoster();
  }

  private freeSlot(): Slot | null {
    const taken = new Set(
      [...this.players.values()].map((p) => p.slot).filter((s) => s !== null),
    );
    if (!taken.has(1)) return 1;
    if (!taken.has(2)) return 2;
    return null;
  }

  private broadcastRoster() {
    const players: PublicPlayer[] = [...this.players.values()].map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      slot: p.slot,
      connected: p.connectionId !== null,
      ready: p.ready,
    }));
    const msg: RosterMsg = {
      scope: "presence",
      type: "roster",
      players,
      screenConnected: this.screenConns.size > 0,
      phase: this.phase,
    };
    this.room.broadcast(JSON.stringify(msg));
  }
}
