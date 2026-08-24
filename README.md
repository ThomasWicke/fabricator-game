# Fabricator (working title)

Two-player co-op survival/exploration prototype: a **shared screen** (TV/laptop)
runs the game world, and each player's **phone is the controller**. The central
mechanic (Phase 2) is the *Universal Fabricator* — players sketch + name an
invention on their phone and an AI compiles it into a functioning game object.

Design doc / plan: see the project plan in `~/.claude/plans/` (Universal
Fabricator — Co-op Survival Game PoC).

## Stack

- **Client:** Vite + TypeScript + Phaser 3 (world sim, split-screen cameras)
- **Networking:** PartyKit (thin relay + player registry; the *screen client*
  is the authoritative simulation host)
- Ported patterns from `garage-chillen` (protocol, socket wrapper, identity,
  `?pid=` test identities) and `pong-pilot` (room codes, QR join, wake lock)

## Run

```bash
npm run dev
```

Runs Vite (:5173) and PartyKit (:1999) concurrently; Vite proxies `/parties`
so everything is same-origin (needed for iOS Safari on LAN).

- `/` — landing: start a shared screen, or join as controller with a code
- `/screen/CODE` — the shared screen (Phaser world, QR join overlay)
- `/c/CODE` — phone controller (joystick right, A/B buttons left)
- `/test.html` — dev harness: screen + two controllers as iframes in one page,
  using `?pid=` throwaway identities

Keyboard fallback on the screen (for dev without phones):
**P1** WASD + F (ping) / G (sprint) · **P2** arrows + K (ping) / L (sprint).

## AI backend (Phase 2)

Sketch pad on the phone → PartyKit → provider-agnostic spec compiler →
object spawned in world with spec-driven locomotion (terrain modifiers make
Swamp Buggy ≠ Car).

- **Isomorphic compile module** in `shared/fabricator/` (schema + validator,
  cost function, prompt, provider adapters via raw `fetch`) — no env access,
  so the future BYOK milestone can run it browser-direct from the screen host.
- **Providers:** Gemini (`gemini-3.6-flash`, dev default — free tier) and
  Anthropic (`claude-sonnet-5`, optional quality anchor). Model IDs live in
  config (`shared/fabricator/provider.ts`), never inline.
  Free-tier note (probed 2026-08-24): the 2.5 family is retired, and
  `gemini-flash-latest` / `gemini-3.7-flash` are capacity-gated (requests
  hang past 25s). `gemini-3.6-flash` and `gemini-3.5-flash-lite` both work.
- **Key setup:** copy `.env.example` → `.env`, add `GOOGLE_API_KEY`
  (free at aistudio.google.com). `partykit dev` loads `.env` automatically.
  **No key → offline mock compiler** (keyword heuristics), so the harness
  works without any key.
- **Rate cap:** 20 fabrications/hour per room (`party/fabricator.ts`).
- Cost is computed **in code** from the spec (`shared/fabricator/cost.ts`),
  never by the LLM.

### Eval

```bash
npx tsx scripts/eval-compiler.ts
```

Runs 10 canned blueprints through each configured provider, asserts the
design invariants (Swamp Buggy swamp-modifier > Car's, Stone Hut is static,
…), and prints measured token usage per provider. Throttled to respect
Gemini free-tier rate limits.

## Phase 1 status

Controller + split-screen shell: two phones drive two explorers over a
procedurally-placeholder world (grass, sand beach west, swamp band east of
spawn); fixed vertical split, one camera per player. All placeholder art is
generated at runtime in `client/src/screen/textures.ts` — swap texture keys
for real sprites later.

In-world today: fabricate from the phone (✏️ BLUEPRINT), walk up to the
result and press A to enter/exit; driving speed = spec speed × terrain
modifier. The player's sketch (transparent PNG) is the vehicle body; wheels/
legs/floats come from the part library at spec-defined anchors.
