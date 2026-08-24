// Cloudflare Worker entry. One origin serves three things:
//   /parties/main/<room>  → the Durable Object room (WebSocket)
//   /sprites/<key>        → generated art from R2
//   everything else       → the built client (assets binding, SPA fallback)

import { routePartykitRequest } from "partyserver";
import { FabricatorServer } from "./party/server";

export { FabricatorServer };

/** Sprites are immutable once written (keyed by design id), so they can be
 *  cached hard. */
const SPRITE_CACHE = "public, max-age=31536000, immutable";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/sprites/")) {
      const key = decodeURIComponent(url.pathname.slice("/sprites/".length));
      if (!key || key.includes("..")) return new Response("Bad key", { status: 400 });
      const object = await env.SPRITES.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", SPRITE_CACHE);
      return new Response(object.body, { headers });
    }

    return (
      (await routePartykitRequest(request, env as never)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
