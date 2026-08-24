// Thin relay + design store. Keys players by persistent playerId (not
// connection id) so refreshes and wifi drops reconnect to the same slot —
// pattern ported from garage-chillen's PlayerRegistry, radically simplified
// for 2 players.
//
// The server owns three things the screen can't: the API keys (spec compile +
// image generation), the permanent Design store, and the saved world. It also
// remembers the current phase (lobby/playing) so a phone that joins or
// reconnects mid-game lands on the game pad. The world simulation stays
// entirely on the screen client.

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
  Phase,
  PresenceClientMsg,
  PublicPlayer,
  RosterMsg,
  Slot,
  WorldSaveMsg,
  WorldSnapshot,
  WorldStateMsg,
} from "./protocol";

/** Room-storage key for the saved world (deltas only — see WorldSnapshot). */
const WORLD_KEY = "world";

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
      case "world-save": {
        if (!fromScreen) break;
        const snap = (msg as unknown as WorldSaveMsg).snapshot;
        void this.room.storage.put(WORLD_KEY, snap).catch((err) => {
          console.error("world save failed:", err);
        });
        break;
      }
      case "design-built": {
        if (!fromScreen) break;
        void this.designs
          .noteBuilt((msg as unknown as { designId: string }).designId)
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
      rec.ready = false; // they'll re-ready when they come back
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
      // Catalog first, then the world — restoring built objects needs their
      // designs, and messages arrive in order.
      void this.sendCatalog(sender, true).then(() => this.sendWorld(sender));
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

  private async sendWorld(conn: Party.Connection) {
    const snapshot =
      ((await this.room.storage.get(WORLD_KEY)) as WorldSnapshot | undefined) ?? null;
    const msg: WorldStateMsg = { scope: "ui", type: "world-state", snapshot };
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
