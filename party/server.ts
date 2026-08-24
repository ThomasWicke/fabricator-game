// Thin relay + design store. Keys players by persistent playerId (not
// connection id) so refreshes and wifi drops reconnect to the same slot —
// pattern ported from garage-chillen's PlayerRegistry, radically simplified
// for 2 players.
//
// The server owns two things the screen can't: the API keys (spec compile +
// image generation) and the permanent Design store. The world simulation
// stays entirely on the screen client.

import type * as Party from "partykit/server";
import { FabricatorEndpoint } from "./fabricator";
import { DesignStore, summarize, type Design } from "./designs";
import type {
  BlueprintMsg,
  ClientToServer,
  DesignAddedMsg,
  DesignAddedSummaryMsg,
  DesignBodyMsg,
  DesignCatalogMsg,
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
  designs: DesignStore;

  constructor(readonly room: Party.Room) {
    this.fabricator = new FabricatorEndpoint(room.env as Record<string, unknown>);
    this.designs = new DesignStore(
      room.storage as unknown as ConstructorParameters<typeof DesignStore>[0],
    );
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
      this.sendToScreens(relay);
      return;
    }

    if (msg.scope !== "ui") return;
    const fromScreen = this.screenConns.has(sender.id);

    switch (msg.type) {
      case "blueprint": {
        if (fromScreen) break;
        this.sendToScreens(raw); // drives the pad's FABRICATING animation
        const playerId = this.connToPlayer.get(sender.id);
        if (playerId) void this.draftDesign(msg as BlueprintMsg, playerId);
        break;
      }
      case "design-body": {
        // A screen finished chroma-keying: store it permanently and share
        // it with any other screen.
        if (!fromScreen) break;
        const m = msg as unknown as DesignBodyMsg;
        void this.designs.setBody(m.designId, m.body).then((d) => {
          if (d) this.sendToScreens(raw);
        });
        break;
      }
      case "design-built": {
        if (!fromScreen) break;
        void this.designs
          .noteBuilt((msg as { designId: string }).designId)
          .then((d) => {
            if (d) this.sendToControllers(designSummaryMsg(d));
          });
        break;
      }
      default: {
        // Opaque relay: manufacture (phone→screens), stockpile (screen→phones),
        // fabricate-error, …
        if (fromScreen) this.sendToControllers(raw, msg.to);
        else this.sendToScreens(raw);
      }
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

  // ── design pipeline ──────────────────────────────────────────

  private async draftDesign(msg: BlueprintMsg, byPlayerId: string) {
    try {
      if (await this.designs.isFull()) {
        throw new Error("The Fabricator's design memory is full.");
      }
      const prefix = "data:image/png;base64,";
      const sketchBase64 = msg.image?.startsWith(prefix)
        ? msg.image.slice(prefix.length)
        : undefined;

      const spec = await this.fabricator.compile({
        name: msg.name,
        intent: msg.intent,
        imageBase64: sketchBase64,
      });
      const rawBody = await this.fabricator.bodySprite(spec, sketchBase64);

      const design: Design = {
        id: crypto.randomUUID(),
        spec,
        createdBy: byPlayerId,
        createdAt: Date.now(),
        timesBuilt: 0,
        sketch: msg.image,
      };
      await this.designs.add(design);

      // Screens get the design plus the raw art to chroma-key; phones get a
      // summary they can price against the stockpile.
      const toScreens: DesignAddedMsg = {
        scope: "ui",
        type: "design-added",
        design,
        rawBody: rawBody ?? undefined,
      };
      this.sendToScreens(JSON.stringify(toScreens));
      this.sendToControllers(designSummaryMsg(design));
    } catch (err) {
      console.error("design failed:", err);
      const message =
        err instanceof Error && /overheated|memory is full/.test(err.message)
          ? err.message
          : "The Fabricator sputters and rejects the blueprint. Try again.";
      const fail: FabricateErrorMsg = { scope: "ui", type: "fabricate-error", message };
      this.room.broadcast(JSON.stringify(fail));
    }
  }

  // ── presence ─────────────────────────────────────────────────

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
      void this.sendCatalog(sender, true);
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
    void this.sendCatalog(sender, false);
    this.broadcastRoster();
  }

  private async sendCatalog(conn: Party.Connection, full: boolean) {
    const designs = await this.designs.all();
    const msg: DesignCatalogMsg = {
      scope: "ui",
      type: "design-catalog",
      designs: full ? designs : designs.map(summarize),
    };
    conn.send(JSON.stringify(msg));
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

  // ── send helpers ─────────────────────────────────────────────

  private sendToScreens(payload: string) {
    for (const id of this.screenConns) {
      this.room.getConnection(id)?.send(payload);
    }
  }

  private sendToControllers(payload: string, only?: string) {
    for (const rec of this.players.values()) {
      if (!rec.connectionId) continue;
      if (only && only !== rec.playerId) continue;
      this.room.getConnection(rec.connectionId)?.send(payload);
    }
  }
}

function designSummaryMsg(d: Design): string {
  const msg: DesignAddedSummaryMsg = {
    scope: "ui",
    type: "design-added",
    design: summarize(d),
  };
  return JSON.stringify(msg);
}
