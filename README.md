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

### Body sprites (paid tier)

With billing enabled on the Google key, fabrication generates an AI body
sprite: spec + the player's sketch (as shape reference) →
`gemini-3.1-flash-image` (Nano Banana 2, ~10s, ~$0.07) → a body on a solid
magenta background → chroma-keyed, despilled, and cropped client-side
(`client/src/screen/chroma.ts`) → the vehicle body, with library parts
bolted on at spec anchors. Failures at the art step fall back to the sketch;
tools always keep the sketch (they render as 22px icons). Controllers never
receive the image payload (~500KB stays on the screen path). Sketch-signal
test confirmed the drawing genuinely shapes the spec (anchor count/layout
and body aspect follow the sketch), so it's worth feeding to the image
model.

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
modifier. The player's sketch (transparent PNG) is the vehicle body; parts
come from the part library at spec-defined anchors.

## Hex world & art

Terrain is a **hexagonal grid** (Kenney "Hexagon Tiles", CC0 — see
`client/public/assets/hex/LICENSE.txt`), stamped once into a static
RenderTexture. Play is continuous (free pixel movement), but terrain lookup
and structure placement are hexagonal — `client/src/screen/hexgrid.ts` has
the odd-r offset math including 6-neighbor adjacency, the foundation for
connecting fabricated structures edge-to-edge into production lines later.
Structures already snap to hex centers.

Biomes: grass, sand beach (west), purple bog band (east; internally the
"swamp" terrain type — bogiron only spawns there). Kenney's matching pines/
rocks are the wood/stone nodes; bogiron is the same rock tinted rust.

Players are Kenney's aliens (CC0, `client/public/assets/aliens/`) with
4-direction movement from platformer frames: stand = facing camera,
walk1/2 = sides (flipped), climb1/2 = walking away.

## v1 economy & primitives

- **Materials:** wood (trees), stone (rocks), **bogiron** (deposits that only
  spawn in the swamp). Trees/rocks/deposits are harvestable nodes feeding a
  shared team stockpile (HUD bottom bar). Starting stock: 25 wood, 15 stone.
- **Gathering:** hold A near a node. Bare hands are slow and can't touch
  bogiron; a fabricated tool (category "tool", auto-equips to its author)
  brings its own rate + material list. Vehicles with `harvest` chew nodes
  they touch while driven.
- **Fabrication is charged:** cost is a per-material bill computed in code
  (`shared/fabricator/cost.ts`). Swamp-capable locomotion is priced in
  bogiron → the progression gate is: gather wood/stone by hand → fabricate
  a drill tool (never costs bogiron, by construction) → trek into the swamp
  → gather bogiron → build the swamp vehicle. Can't afford it → the
  Fabricator rejects and nothing is charged.
- **Primitives:** locomotion (speed × terrain modifiers), `harvest` {rate,
  materials}, `emission` {light|smoke|sparks, intensity} — glow sprites,
  smoke puffs (running only while driven), sparks.
- **Parts:** wheel, track, leg, float, drill, chimney, lamp — procedural
  sprites with per-kind animations (wheels spin, drills jitter, tracks
  vibrate, lamps glow).

### HUD

Layered inside the game frame (a DOM overlay on top of the canvas, not a bar
beside it), so text stays crisp at any DPI and it reads as part of the game.
Player cards sit over their own half of the split screen and show name,
connection and equipped tool; the shared team stockpile is centred between
them; fabrication results and rejections appear as a transient strip at the
bottom. Sizing is `em`-based off a `clamp(…vh)` root so the whole HUD scales
with the display — it stays legible on a TV across a room.

Deterministic tests: `npx tsx scripts/test-cost.ts` (17 checks, no API).
