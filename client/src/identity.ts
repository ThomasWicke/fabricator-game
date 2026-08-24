// Persistent local identity (ported from garage-chillen, minus avatars).
// UUID is generated once per browser and reused across visits so the server
// can rebind reconnects to the same player slot.

import { v4 as uuidv4 } from "uuid";

export type Identity = {
  playerId: string;
  nickname: string;
};

const KEY = "fab.identity";

export function ensureIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (parsed.playerId) {
        return { playerId: parsed.playerId, nickname: parsed.nickname ?? "" };
      }
    }
  } catch {
    // fall through to fresh identity
  }
  const fresh: Identity = { playerId: uuidv4(), nickname: "" };
  localStorage.setItem(KEY, JSON.stringify(fresh));
  return fresh;
}

/**
 * Testing aid: `?pid=someone` plays as a throwaway identity instead of the
 * one in localStorage — so several tabs/iframes can join the same room from
 * ONE browser profile (used by /test.html). Optional `&nick=`.
 */
export function identityFromUrl(): Identity | null {
  const q = new URLSearchParams(window.location.search);
  const pid = q.get("pid")?.trim();
  if (!pid) return null;
  return {
    playerId: `url-${pid}`,
    nickname: (q.get("nick") ?? pid).slice(0, 16),
  };
}

export function resolveIdentity(): Identity {
  return identityFromUrl() ?? ensureIdentity();
}
