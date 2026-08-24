// Thin relay server. Keys players by persistent playerId (not connection id)
// so refreshes and wifi drops reconnect to the same slot — pattern ported
// from garage-chillen's PlayerRegistry, radically simplified for 2 players.

import type * as Party from "partykit/server";
import { FabricatorEndpoint } from "./fabricator";
import type {
  BlueprintMsg,
  ClientToServer,
  FabricatedMsg,
  FabricateErrorMsg,
  IdentifyMsg,
  PublicPlayer,
  RosterMsg,
  Slot,
} from "./protocol";

type PlayerRecord = {
  playerId: string;
  nickname: string;
  slot: Slot | null;
  connectionId: string | null;
};

const NICKNAME_MAX = 16;

export default class FabricatorServer implements Party.Server {
  players = new Map<string, PlayerRecord>(); // by playerId
  connToPlayer = new Map<string, string>(); // connectionId → playerId
  screenConns = new Set<string>();
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

    if (msg.scope === "presence" && msg.type === "identify") {
      this.handleIdentify(msg, sender);
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
        }),
      );
      this.broadcastRoster();
      return;
    }

    const nickname = msg.nickname.trim().slice(0, NICKNAME_MAX) || "anon";
    let rec = this.players.get(msg.playerId);
    if (rec) {
      // Reconnect (or duplicate identify): rebind the connection.
      if (rec.connectionId && rec.connectionId !== sender.id) {
        this.connToPlayer.delete(rec.connectionId);
      }
      rec.connectionId = sender.id;
      rec.nickname = nickname;
    } else {
      rec = {
        playerId: msg.playerId,
        nickname,
        slot: this.freeSlot(),
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
    }));
    const msg: RosterMsg = {
      scope: "presence",
      type: "roster",
      players,
      screenConnected: this.screenConns.size > 0,
    };
    this.room.broadcast(JSON.stringify(msg));
  }
}
