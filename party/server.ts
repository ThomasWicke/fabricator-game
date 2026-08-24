// The room: a Durable Object (via partyserver) that relays input, owns the
// API keys, and stores designs + the saved world.
//
// The world simulation itself lives on the screen client — this stays a
// relay plus a store, which is what keeps it cheap and portable.
//
// Players are keyed by persistent playerId (not connection id) so refreshes
// and wifi drops reconnect to the same slot.

import { Server, type Connection, type WSMessage } from "partyserver";
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
  WorldSaveMsg,
  WorldSnapshot,
  WorldStateMsg,
} from "./protocol";

type PlayerRecord = {
  playerId: string;
  nickname: string;
  slot: Slot | null;
  connectionId: string | null;
};

const NICKNAME_MAX = 16;
/** Room-storage key for the saved world (deltas only — see WorldSnapshot). */
const WORLD_KEY = "world";
const DATA_URL_RE = /^data:(image\/[a-z+]+);base64,(.+)$/;

export class FabricatorServer extends Server<Env> {
  /** Connections are re-established on wake, so this in-memory state is
   *  rebuilt by clients re-identifying rather than persisted. */
  private players = new Map<string, PlayerRecord>();
  private connToPlayer = new Map<string, string>();
  private screenConns = new Set<string>();
  private fabricator!: FabricatorEndpoint;
  private designs!: DesignStore;

  onStart(): void {
    this.fabricator = new FabricatorEndpoint(
      this.env as unknown as Record<string, unknown>,
    );
    this.designs = new DesignStore(this.ctx.storage);
  }

  // NOTE: partyserver's argument order is (connection, message) — the
  // reverse of PartyKit's (message, sender).
  onMessage(connection: Connection, message: WSMessage): void {
    if (typeof message !== "string") return;
    let msg: ClientToServer;
    try {
      msg = JSON.parse(message) as ClientToServer;
    } catch {
      return;
    }

    if (msg.scope === "presence" && msg.type === "identify") {
      this.handleIdentify(msg, connection);
      return;
    }

    if (msg.scope === "input" && msg.type === "input") {
      const playerId = this.connToPlayer.get(connection.id);
      if (!playerId) return;
      const rec = this.players.get(playerId);
      if (!rec || rec.slot === null) return;
      this.sendToScreens(
        JSON.stringify({
          scope: "input",
          type: "input",
          playerId,
          slot: rec.slot,
          stick: msg.stick,
          buttons: msg.buttons,
        }),
      );
      return;
    }

    if (msg.scope !== "ui") return;
    const fromScreen = this.screenConns.has(connection.id);

    switch (msg.type) {
      case "blueprint": {
        if (fromScreen) break;
        this.sendToScreens(message); // drives the pad's FABRICATING animation
        const playerId = this.connToPlayer.get(connection.id);
        if (playerId) void this.draftDesign(msg as BlueprintMsg, playerId);
        break;
      }
      case "design-body": {
        // A screen finished chroma-keying: park it in R2 and tell everyone
        // the design now has art (they fetch it over HTTP).
        if (!fromScreen) break;
        void this.storeBody(msg as unknown as DesignBodyMsg);
        break;
      }
      case "world-save": {
        if (!fromScreen) break;
        void this.ctx.storage
          .put(WORLD_KEY, (msg as unknown as WorldSaveMsg).snapshot)
          .catch((err) => console.error("world save failed:", err));
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
        if (fromScreen) this.sendToControllers(message, msg.to);
        else this.sendToScreens(message);
      }
    }
  }

  onClose(connection: Connection): void {
    if (this.screenConns.delete(connection.id)) {
      this.broadcastRoster();
      return;
    }
    const playerId = this.connToPlayer.get(connection.id);
    if (!playerId) return;
    this.connToPlayer.delete(connection.id);
    const rec = this.players.get(playerId);
    if (rec && rec.connectionId === connection.id) {
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
      const sketch = decodeDataUrl(msg.image);
      const spec = await this.fabricator.compile({
        name: msg.name,
        intent: msg.intent,
        imageBase64: sketch?.base64,
      });
      const rawBody = await this.fabricator.bodySprite(spec, sketch?.base64);

      const id = crypto.randomUUID();
      if (sketch) {
        await this.env.SPRITES.put(`sketch/${id}.png`, sketch.bytes, {
          httpMetadata: { contentType: sketch.mimeType },
        });
      }
      const design: Design = {
        id,
        spec,
        createdBy: byPlayerId,
        createdAt: Date.now(),
        timesBuilt: 0,
        hasBody: false,
        hasSketch: !!sketch,
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
      this.broadcast(JSON.stringify(fail));
    }
  }

  private async storeBody(msg: DesignBodyMsg) {
    const decoded = decodeDataUrl(msg.body);
    if (!decoded) return;
    try {
      await this.env.SPRITES.put(`body/${msg.designId}.png`, decoded.bytes, {
        httpMetadata: { contentType: decoded.mimeType },
      });
      const d = await this.designs.markBody(msg.designId);
      if (!d) return;
      // Everyone just needs to know the art exists; they fetch it by URL.
      const ready: DesignBodyMsg = {
        scope: "ui",
        type: "design-body",
        designId: msg.designId,
        body: "",
      };
      this.sendToScreens(JSON.stringify(ready));
      this.sendToControllers(designSummaryMsg(d));
    } catch (err) {
      console.error("sprite upload failed:", err);
    }
  }

  // ── presence ─────────────────────────────────────────────────

  private handleIdentify(msg: IdentifyMsg, conn: Connection) {
    if (msg.role === "screen") {
      this.screenConns.add(conn.id);
      conn.send(
        JSON.stringify({
          scope: "presence",
          type: "welcome",
          role: "screen",
          slot: null,
          lobbyCode: this.name,
        }),
      );
      // Catalog first, then the world — restoring built objects needs their
      // designs, and messages arrive in order.
      void this.sendCatalog(conn, true).then(() => this.sendWorld(conn));
      this.broadcastRoster();
      return;
    }

    const nickname = msg.nickname.trim().slice(0, NICKNAME_MAX) || "anon";
    let rec = this.players.get(msg.playerId);
    if (rec) {
      // Reconnect (or duplicate identify): rebind the connection.
      if (rec.connectionId && rec.connectionId !== conn.id) {
        this.connToPlayer.delete(rec.connectionId);
      }
      rec.connectionId = conn.id;
      rec.nickname = nickname;
    } else {
      rec = {
        playerId: msg.playerId,
        nickname,
        slot: this.freeSlot(),
        connectionId: conn.id,
      };
      this.players.set(msg.playerId, rec);
    }
    this.connToPlayer.set(conn.id, msg.playerId);
    conn.send(
      JSON.stringify({
        scope: "presence",
        type: "welcome",
        role: "controller",
        slot: rec.slot,
        lobbyCode: this.name,
      }),
    );
    void this.sendCatalog(conn, false);
    this.broadcastRoster();
  }

  private async sendCatalog(conn: Connection, full: boolean) {
    const designs = await this.designs.all();
    const msg: DesignCatalogMsg = {
      scope: "ui",
      type: "design-catalog",
      designs: full ? designs : designs.map(summarize),
    };
    conn.send(JSON.stringify(msg));
  }

  private async sendWorld(conn: Connection) {
    const snapshot =
      ((await this.ctx.storage.get(WORLD_KEY)) as WorldSnapshot | undefined) ?? null;
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
    }));
    const msg: RosterMsg = {
      scope: "presence",
      type: "roster",
      players,
      screenConnected: this.screenConns.size > 0,
    };
    this.broadcast(JSON.stringify(msg));
  }

  // ── send helpers ─────────────────────────────────────────────

  private sendToScreens(payload: string) {
    for (const id of this.screenConns) {
      this.getConnection(id)?.send(payload);
    }
  }

  private sendToControllers(payload: string, only?: string) {
    for (const rec of this.players.values()) {
      if (!rec.connectionId) continue;
      if (only && only !== rec.playerId) continue;
      this.getConnection(rec.connectionId)?.send(payload);
    }
  }
}

function decodeDataUrl(
  dataUrl: string | undefined,
): { mimeType: string; base64: string; bytes: Uint8Array } | null {
  const m = dataUrl?.match(DATA_URL_RE);
  if (!m) return null;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mimeType: m[1], base64: m[2], bytes };
}

function designSummaryMsg(d: Design): string {
  const msg: DesignAddedSummaryMsg = {
    scope: "ui",
    type: "design-added",
    design: summarize(d),
  };
  return JSON.stringify(msg);
}
