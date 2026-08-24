// Persistent local identity (ported from garage-chillen, minus avatars).
// UUID is generated once per browser and reused across visits so the server
// can rebind reconnects to the same player slot. The nickname is edited in
// the lobby and remembered for the next session.

import { v4 as uuidv4 } from "uuid";

export type Identity = {
  playerId: string;
  nickname: string;
};

const KEY = "fab.identity";
export const NICKNAME_MAX = 16;

export function sanitizeNickname(raw: string): string {
  return raw.replace(/\s+/g, " ").trimStart().slice(0, NICKNAME_MAX);
}

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
  try {
    localStorage.setItem(KEY, JSON.stringify(fresh));
  } catch {
    // private mode / storage disabled — identity just won't survive a reload
  }
  return fresh;
}

/** Remember a name chosen on the landing page or in the lobby. No-op for
 *  `?pid=` throwaway identities, which shouldn't stomp the real one. */
export function rememberNickname(nickname: string): void {
  if (identityFromUrl()) return;
  const current = ensureIdentity();
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...current, nickname: sanitizeNickname(nickname) }),
    );
  } catch {
    // ignore — see ensureIdentity
  }
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
    nickname: (q.get("nick") ?? pid).slice(0, NICKNAME_MAX),
  };
}

export function resolveIdentity(): Identity {
  return identityFromUrl() ?? ensureIdentity();
}
