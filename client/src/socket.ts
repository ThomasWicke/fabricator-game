// Thin wrapper around PartySocket (ported from garage-chillen). Auto-sends
// `identify` on every (re-)open so reconnects restore identity automatically.

import PartySocket from "partysocket";
import type { ClientToServer, ServerToClient } from "../../party/protocol";
import type { Identity } from "./identity";

export type ConnectionStatus = "connecting" | "open" | "closed";

export type Handlers = {
  onMessage: (msg: ServerToClient) => void;
  onStatus: (status: ConnectionStatus) => void;
};

export class RoomConnection {
  private socket: PartySocket;

  constructor(
    code: string,
    private role: "screen" | "controller",
    private identity: Identity,
    private handlers: Handlers,
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
      this.send({
        scope: "presence",
        type: "identify",
        role: this.role,
        playerId: this.identity.playerId,
        nickname: this.identity.nickname,
      });
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
    this.socket.send(JSON.stringify(msg));
  }

  close(): void {
    this.socket.close();
  }
}
