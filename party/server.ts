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
  DesignDeleteMsg,
  DesignAddedMsg,
  DesignAddedSummaryMsg,
  DesignBodyMsg,
  DesignCatalogMsg,
  FabricateErrorMsg,
  FabricateProgressMsg,
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

type PlayerRecord = {
  playerId: string;
  nickname: string;
  slot: Slot | null;
  connectionId: string | null;
  ready: boolean;
};

const NICKNAME_MAX = 16;

function sanitizeNickname(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, NICKNAME_MAX) : "";
}
/** Room-storage key for the saved world (deltas only — see WorldSnapshot). */
const WORLD_KEY = "world";
const DATA_URL_RE = /^data:(image\/[a-z+]+);base64,(.+)$/;

export class FabricatorServer extends Server<Env> {
  /** Connections are re-established on wake, so this in-memory state is
   *  rebuilt by clients re-identifying rather than persisted. */
  private players = new Map<string, PlayerRecord>();
  private connToPlayer = new Map<string, string>();
  private screenConns = new Set<string>();
  /** Lobby or playing. Held here so a phone joining or reconnecting mid-game
   *  lands on the game pad instead of the lobby. */
  private phase: Phase = "lobby";
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

    if (msg.scope === "presence") {
      this.handlePresence(msg, connection);
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
        // Screens submit these too: the shared screen has its own blueprint
        // pad so the game is playable on a keyboard and mouse alone, with no
        // phone in the room at all.
        this.sendToScreens(message); // drives the pad's FABRICATING animation
        const playerId = this.connToPlayer.get(connection.id);
        if (playerId) void this.draftDesign(msg as BlueprintMsg, playerId);
        break;
      }
      case "design-delete": {
        // From a phone this is a request; the screen is the only one who can
        // see whether the design has been built, so it decides and sends its
        // own. From a screen it is the decision. The requester is stamped on
        // so a refusal can be told to the one phone that asked — it used to
        // land as a toast on the TV while the phone's tap did silently
        // nothing.
        if (!fromScreen) {
          const playerId = this.connToPlayer.get(connection.id);
          this.sendToScreens(
            playerId ? JSON.stringify({ ...msg, from: playerId }) : message,
          );
          break;
        }
        void this.removeDesign((msg as unknown as DesignDeleteMsg).designId);
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
        // Opaque relay: manufacture (phone→screens), stockpile and
        // fabricator-range (screen→phones), fabricate-error, …
        if (fromScreen) {
          this.sendToControllers(message, msg.to);
          break;
        }
        // Phone→screen messages get the sender stamped on. The screen gates
        // building on who is standing at the Fabricator, and it cannot take
        // the phone's word for who that is. These are rare (a BUILD press),
        // so re-serialising to add the field costs nothing that matters.
        const playerId = this.connToPlayer.get(connection.id);
        this.sendToScreens(playerId ? JSON.stringify({ ...msg, from: playerId }) : message);
      }
    }
  }

  /** Delete a design and the art that belongs to it. The blobs are best
   *  effort: an orphaned sprite in R2 costs a few kilobytes, while a failed
   *  delete that aborted the whole thing would leave the design in the
   *  library with no way to try again. */
  private async removeDesign(designId: string): Promise<void> {
    const gone = await this.designs.remove(designId);
    if (!gone) return;
    for (const key of [`body/${designId}.png`, `sketch/${designId}.png`]) {
      try {
        await this.env.SPRITES.delete(key);
      } catch (err) {
        console.warn(`could not delete ${key}:`, err);
      }
    }
    this.broadcast(
      JSON.stringify({ scope: "ui", type: "design-removed", designId }),
    );
  }

  onClose(connection: Connection): void {
    // Every connection now carries a playerId, screens included, so this can
    // no longer branch on "was it a screen" to decide whether to clean up a
    // seat. It does both, and tells everyone if either changed.
    const wasScreen = this.screenConns.delete(connection.id);
    const playerId = this.connToPlayer.get(connection.id);
    this.connToPlayer.delete(connection.id);

    const rec = playerId ? this.players.get(playerId) : undefined;
    let seatChanged = false;
    if (rec && rec.connectionId === connection.id) {
      rec.connectionId = null; // slot stays reserved for reconnect
      rec.ready = false;
      seatChanged = true;
    }
    if (wasScreen || seatChanged) this.broadcastRoster();
  }

  // ── design pipeline ──────────────────────────────────────────

  private async draftDesign(msg: BlueprintMsg, byPlayerId: string) {
    try {
      if (await this.designs.isFull()) {
        throw new Error("The Fabricator's design memory is full.");
      }
      const sketch = decodeDataUrl(msg.image, MAX_SKETCH_BYTES);
      if (msg.image && !sketch) {
        throw new Error("That sketch is too large for the Fabricator's scanner.");
      }
      // A modification carries its parent: the compiler gets the spec to
      // iterate on, the artist gets the old body to keep recognisable. A
      // parent that has since been discarded degrades to a fresh compile.
      const parent = msg.parentId ? await this.designs.get(msg.parentId) : null;
      const parentArt = parent
        ? await this.env.SPRITES.get(`body/${parent.id}.png`)
            .then((o) => o?.arrayBuffer())
            .then((b) => (b ? bytesToBase64(new Uint8Array(b)) : undefined))
            .catch(() => undefined)
        : undefined;
      const { spec, model: compiler } = await this.fabricator.compile({
        name: msg.name,
        intent: msg.intent,
        imageBase64: sketch?.base64,
        parentSpec: parent?.spec,
      });
      // The spec exists; the remaining wait is all image generation. Telling
      // the room turns a 40-second silence into two legible stages.
      const progress: FabricateProgressMsg = {
        scope: "ui",
        type: "fabricate-progress",
        stage: "art",
        name: spec.displayName,
        compiler,
        to: byPlayerId,
      };
      this.sendToScreens(JSON.stringify(progress));
      this.sendToControllers(JSON.stringify(progress), byPlayerId);
      const body = await this.fabricator.bodySprite(spec, {
        sketch: sketch?.base64,
        parent: parentArt,
      });

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
        createdBySlot: msg.slot,
        createdAt: Date.now(),
        timesBuilt: 0,
        hasBody: false,
        hasSketch: !!sketch,
        parentId: parent?.id,
      };
      await this.designs.add(design);

      // Screens get the design plus the raw art to chroma-key; phones get a
      // summary they can price against the stockpile.
      const toScreens: DesignAddedMsg = {
        scope: "ui",
        type: "design-added",
        design,
        rawBody: body?.dataUrl,
        artModel: body?.model,
      };
      this.sendToScreens(JSON.stringify(toScreens));
      this.sendToControllers(designSummaryMsg(design));
    } catch (err) {
      console.error("design failed:", err);
      // Say what actually happened, in the machine's voice. The catch-all
      // used to swallow every distinct failure into one sentence, which made
      // "the model is overloaded" and "your sketch is 4MB" indistinguishable
      // to the person deciding whether to try again.
      const raw = err instanceof Error ? err.message : String(err);
      const message = /overheated|memory is full|too large/.test(raw)
        ? raw
        : /abort|timed? ?out/i.test(raw)
          ? "The Fabricator lost its train of thought — the design took too long. Try again."
          : /failed validation/.test(raw)
            ? "The Fabricator couldn't make sense of that blueprint. Try a clearer name or intent."
            : /API 4\d\d/.test(raw)
              ? "The Fabricator's uplink rejected the request. If this keeps happening, something is wrong on our side."
              : "The Fabricator sputters and rejects the blueprint. Try again.";
      const fail: FabricateErrorMsg = {
        scope: "ui",
        type: "fabricate-error",
        message,
        to: byPlayerId,
      };
      // Screens need it regardless (a pad animation to stop); of the phones,
      // only the submitter — the other player's screen buzzing about a
      // blueprint they never sent is noise.
      this.sendToScreens(JSON.stringify(fail));
      this.sendToControllers(JSON.stringify(fail), byPlayerId);
    }
  }

  private async storeBody(msg: DesignBodyMsg) {
    const decoded = decodeDataUrl(msg.body, MAX_BODY_BYTES);
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

  private handlePresence(msg: PresenceClientMsg, conn: Connection) {
    if (msg.type === "identify") {
      this.handleIdentify(msg, conn);
      return;
    }

    // Only the screen sets the phase — it's the one running the simulation.
    if (msg.type === "set-phase") {
      if (!this.screenConns.has(conn.id)) return;
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

    const playerId = this.connToPlayer.get(conn.id);
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

  private handleIdentify(msg: IdentifyMsg, conn: Connection) {
    if (msg.role === "screen") {
      this.screenConns.add(conn.id);
      // A screen has its own identity, and it needs one: it can submit
      // blueprints from its own Fabricator pad, and draftDesign has to know
      // who to credit. Without this the message was relayed — so the pad sat
      // there saying FABRICATING — and then quietly dropped, forever.
      this.connToPlayer.set(conn.id, msg.playerId);
      if (msg.touchHost) {
        // This screen is playing on its own touch controls, so it holds a
        // seat like any player. freeSlot() then hands a joining phone slot 2
        // rather than the seat somebody is already sitting in.
        const existing = this.players.get(msg.playerId);
        const rec = existing ?? {
          playerId: msg.playerId,
          nickname: sanitizeNickname(msg.nickname) || "Player 1",
          slot: 1 as Slot,
          connectionId: conn.id,
          ready: true,
        };
        rec.connectionId = conn.id;
        rec.slot = 1;
        rec.ready = true; // nothing to ready up: they're already here
        this.players.set(msg.playerId, rec);
        this.connToPlayer.set(conn.id, msg.playerId);
      }
      conn.send(
        JSON.stringify({
          scope: "presence",
          type: "welcome",
          role: "screen",
          slot: null,
          lobbyCode: this.name,
          phase: this.phase,
        }),
      );
      // Catalog first, then the world — restoring built objects needs their
      // designs, and messages arrive in order.
      void this.sendCatalog(conn, true).then(() => this.sendWorld(conn));
      this.broadcastRoster();
      return;
    }

    const nickname = sanitizeNickname(msg.nickname);
    let rec = this.players.get(msg.playerId);
    if (rec) {
      // Reconnect (or duplicate identify): rebind the connection.
      if (rec.connectionId && rec.connectionId !== conn.id) {
        this.connToPlayer.delete(rec.connectionId);
      }
      rec.connectionId = conn.id;
      // Keep the name they set in the lobby if this reconnect carries none.
      if (nickname) rec.nickname = nickname;
    } else {
      rec = {
        playerId: msg.playerId,
        nickname,
        slot: this.freeSlot(),
        connectionId: conn.id,
        ready: false,
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
        phase: this.phase,
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
      ready: p.ready,
    }));
    const msg: RosterMsg = {
      scope: "presence",
      type: "roster",
      players,
      screenConnected: this.screenConns.size > 0,
      phase: this.phase,
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

/** Sketches are ≤256px PNGs — tens of KB. Anything near this cap is not a
 *  sketch, and decoding it inside a Durable Object costs everyone. */
const MAX_SKETCH_BYTES = 400_000;
/** Generated body art runs bigger, but not megabytes bigger. */
const MAX_BODY_BYTES = 2_000_000;

function bytesToBase64(bytes: Uint8Array): string {
  // btoa takes a binary STRING; chunked so a big sprite doesn't blow the
  // argument limit of String.fromCharCode.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeDataUrl(
  dataUrl: string | undefined,
  maxBytes: number,
): { mimeType: string; base64: string; bytes: Uint8Array } | null {
  const m = dataUrl?.match(DATA_URL_RE);
  if (!m) return null;
  // Base64 is 4/3 the decoded size; checking before atob keeps the oversize
  // payload from ever being materialised.
  if (m[2].length > (maxBytes * 4) / 3) return null;
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
