// Thin wrapper around PartySocket (ported from garage-chillen). Auto-sends
// `identify` on every (re-)open so reconnects restore identity automatically.

import PartySocket from "partysocket";
import type { ClientToServer, ServerToClient } from "../../party/protocol";
import type { Identity } from "./identity";

export type ConnectionStatus = "connecting" | "open" | "closed";

const QUEUE_MAX = 20;

export type Handlers = {
  onMessage: (msg: ServerToClient) => void;
  onStatus: (status: ConnectionStatus) => void;
};

export class RoomConnection {
  private socket: PartySocket;
  /** Messages sent before the socket opened (or while it's reconnecting).
   *  Presence/ui messages matter after the fact — lobby state, blueprints —
   *  so they wait; input is a live signal and is simply dropped. */
  private queue: ClientToServer[] = [];

  constructor(
    code: string,
    private role: "screen" | "controller",
    private identity: Identity,
    private handlers: Handlers,
    /** Screens only: this device also plays, using on-screen touch controls. */
    private touchHost = false,
  ) {
    this.handlers.onStatus("connecting");
    // In dev: same host:port as the page (Vite proxies /parties/* to
    // PartyKit on :1999). In prod: VITE_PARTYKIT_HOST points to the
    // deployed partykit host.
    this.socket = new PartySocket({
      host: import.meta.env.VITE_PARTYKIT_HOST || window.location.host,
      room: code,
    });

    this.socket.addEventListener("open", () => {
      this.handlers.onStatus("open");
      // identify first — the server keys everything else off it.
      this.send({
        scope: "presence",
        type: "identify",
        role: this.role,
        playerId: this.identity.playerId,
        nickname: this.identity.nickname,
        touchHost: this.touchHost || undefined,
      });
      const pending = this.queue;
      this.queue = [];
      for (const msg of pending) this.send(msg);
    });

    this.socket.addEventListener("close", () => {
      this.handlers.onStatus("closed");
    });

    this.socket.addEventListener("message", (e) => {
      let msg: ServerToClient;
      try {
        msg = JSON.parse(e.data) as ServerToClient;
      } catch {
        return;
      }
      this.handlers.onMessage(msg);
    });
  }

  send(msg: ClientToServer): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      if (msg.scope === "input") return; // stale by the time we reconnect
      if (this.queue.length < QUEUE_MAX) this.queue.push(msg);
      return;
    }
    this.socket.send(JSON.stringify(msg));
  }

  close(): void {
    this.socket.close();
  }
}
