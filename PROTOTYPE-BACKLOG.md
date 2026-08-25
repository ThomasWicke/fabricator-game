# Universal Fabricator — from working PoC to a game people want to keep playing

A product backlog, written as a handover. The PoC proves the thesis: sketches
become working machines, the world is endless, two people can play it on one
screen. What it does not yet do is make anyone *want* the next hour. That is
the whole job now.

**North star:** the moment the game is built around is *"I drew a thing, it
exists, and it changed what I can do."* Every item below either multiplies
that moment, removes what dulls it, or gives players a reason to need it
again. When an item serves none of those, it is in the Cut list.

**How fun will be measured** (prototype-grade, not analytics-grade):
- Unprompted second session — does a tester come back without being asked?
- Designs per hour — the invention loop is the game; if it isn't spinning, nothing else matters.
- "One more thing" utterances in playtests — the audible symptom of a goal gradient working.
- Time-to-first-fabrication for a fresh player, unaided. Target: under 4 minutes.

Status: `[ ]` open · priority `P0` (fun-critical) / `P1` (fun-multiplier) /
`P2` (nice) · effort `S`/`M`/`L` · milestones **M1 Spine → M2 Depth → M3 Cohesion**.

---

## Epic G · A reason to be here (the spine) — the biggest gap

The game has verbs and no sentence. Materials gate capabilities, but nothing
asks for the capabilities. Players stop when their curiosity does — usually at
minute 25, when they've built a car and a hut and ask "now what?"

- [ ] **G1 · The premise, on screen. P0/S/M1.** You crash-landed; the
      Fabricator is the ship's survived printer. Three sentences at expedition
      start, one image. Costs a day, reframes everything: gathering is
      salvage, the Fabricator is your way home, the map edge is hope.
- [ ] **G2 · The Beacon — a win condition. P0/M/M1.** One monumental
      end-goal build (rescue beacon / relay tower) whose bill is deliberately
      absurd: large amounts of ALL SIX materials. It is visible in the design
      library from minute one, permanently, greyed until affordable. The whole
      economy already points at it — six materials, four of them behind
      expeditions — it just needs the thing that demands them. Completing it
      ends the run with a scene + stats (days survived, designs made, hexes
      travelled) and offers "keep playing".
- [ ] **G3 · Fabricator repair tiers. P0/L/M1.** The machine survived the
      crash *damaged*. Tier 0 compiles tools only; repairing it (a material
      bill, growing per tier) unlocks structures, then vehicles, then the
      Beacon blueprint. This staggers the vocabulary so the first hour has
      unlock beats, gives early gathering a purpose, and makes the machine a
      character with an arc rather than a vending machine. (Deliberately
      deferred in the PoC plan; its time has come.)
- [ ] **G4 · Fabricator requests. P1/M/M2.** Between repairs, the machine
      asks for things: "Bring me 20 stone", then later "Build something that
      can cross water — I want to see the wreck offshore." Requests teach
      primitives one at a time, reward with repair progress or rare
      materials, and give aimless minutes a default direction. Hand-authored
      list (~15), not procedural.
- [ ] **G5 · The wreck sites. P1/M/M2.** 3–5 fixed-per-seed crash debris
      landmarks (reuse the landmark lattice) holding one-time material caches
      and one line of story each. Somewhere to point a first vehicle at.
- [ ] **G6 · Run stats & endscreen. P2/S/M3.** Even without finishing the
      Beacon: a "story of your expedition" panel from data already tracked —
      distance, designs, deaths, regions named. Ends sessions on a note
      instead of a tab-close.

## Epic F · The Fabricator as the star — multiply the core moment

The 40-second fabrication is the game's heartbeat, currently played as a
loading spinner. The moment a design arrives should be the best moment in
the game, every time.

- [ ] **F10 · The arrival ceremony. P0/M/M1.** The machine's ring builds
      up, the world dims a beat, the new object materialises with the flash
      *and its name and flavor line said large on screen* — the flavor text
      is the machine's personality and nobody reads it in a toast. 3 seconds
      of theatre, skippable by moving.
- [ ] **F11 · Compile while you play, loudly. P0/S/M1.** Submissions already
      run async; make the pending state a visible in-world object — a
      half-formed ghost rotating above the pad — so leaving to gather while
      it prints feels intended rather than like abandoning a request.
- [ ] **F12 · The design's spec, shown as a stat card. P1/S/M1.** Players
      can't love what they can't read: speed, terrain bars, damage/reach,
      capacity — a small card on the design row and on the arrival ceremony.
      The compiled spec is the receipt that the AI *understood them*; today
      it's invisible except through play.
- [ ] **F13 · Interesting failure, surfaced. P1/M/M2.** The prompt already
      asks for flawed-but-functional interpretations of over-ambitious asks;
      lean in: when the compiler clamps something hard (asked 1000 speed, got
      360), the flavor line should *acknowledge the compromise*. Pipe clamp
      deltas into the flavor request. The machine having opinions is content.
- [ ] **F14 · Design naming moments. P2/S/M2.** "Mk II" is prefilled on
      modify — go further: the library shows lineage trees, and the machine
      occasionally comments on a family ("the fourth barrow this week").
- [ ] **F15 · Blueprint queue. P2/S/M2.** Let a second blueprint be
      submitted while one is printing (queue of 2). Removes the only hard
      wait in the loop.

## Epic J · Game feel — the difference between functional and fun

Nothing here adds systems; all of it changes how the existing ones land in
the hands. This epic is cheap and disproportionately effective.

- [ ] **J1 · Harvest feedback. P0/S/M1.** Each hit: node shake scaled to
      damage, chip particles in the material's colour, the +1 popping with
      more pop. The 20th tree must feel as good as the first.
- [ ] **J2 · Movement feel. P0/S/M1.** Acceleration/deceleration curves on
      foot (60–100ms), footstep puffs on sand/snow, a lean into the sprint.
      Instant-velocity movement is the single biggest "this is a tech demo"
      signal in the current build.
- [ ] **J3 · Vehicle feel. P0/M/M1.** Turning inertia, terrain-dependent
      bounce, dust scaling with speed, a small camera lookahead when driving
      fast. Vehicles are the reward for the whole economy; driving must beat
      walking *emotionally*, not just numerically.
- [ ] **J4 · Combat readability. P1/S/M1.** Swing arc flash, hit-pause of
      2 frames on connect, enemy flash+knockback (exists) plus a death puff
      worth seeing. Telegraph before an enemy's first bite (wind-up hop) so
      damage never feels unannounced.
- [ ] **J5 · Night atmosphere. P1/S/M2.** The gloom exists; add: light
      sources bloom slightly, enemy eyes glint in the dark, dawn breaks with
      a 2-second warm sweep. Make lamps something you *want* before they're
      something you need.
- [ ] **J6 · Camera polish. P2/S/M2.** Soft zoom-out at speed, zoom-in at
      the Fabricator, deadzone tuning. One afternoon, permanent dividend.
- [ ] *(Audio is deliberately absent per your standing preference — one line
      here only so its absence reads as a decision, not an oversight.)*

## Epic S · Survival tuned to "cozy with teeth"

The stress-free promise is right for this game. But zero pressure means
zero relief, and relief is where cozy lives. The dial: danger is *legible,
avoidable, and always your fault*.

- [ ] **S20 · Nights get bolder, slowly. P0/S/M1.** Night N aggro bonus
      scales gently over the first 5 nights, then plateaus. The first night
      teaches, the fifth motivates walls and lamps. Numbers in enemies.ts,
      invariants extended (never faster than a walk, ever).
- [ ] **S21 · Wards and lamps that visibly work. P0/S/M1.** Show the warded
      radius briefly when a creature turns away at its edge. The player must
      SEE the fence doing its job or the rime was wasted.
- [ ] **S22 · Downed, not dead, in co-op. P1/M/M2.** Solo death keeps the
      respawn. In co-op, a player drops and can be revived by their partner
      within 30s — the strongest co-op glue there is, and it makes danger a
      shared story instead of a solo teleport.
- [ ] **S23 · Hunger rebalance. P1/S/M1.** Foraging currently trivialises
      food near spawn. Thin bush density with distance from the Fabricator so
      expeditions need either rations (pack), a farm, or a vehicle with
      storage — three different fabrication answers to one pressure.
- [ ] **S24 · Weather as texture, not threat. P2/M/M3.** Rain/snow particle
      passes with slight movement penalties, telegraphed a minute ahead.
      Worlds that DO something feel alive; keep it cosmetic-plus.

## Epic C · Co-op that is more than two solos

S10 from the old backlog, expanded. Right now two players are one player
twice. The couch format deserves verbs that need two bodies.

- [ ] **C1 · Two-person carry. P1/M/M2.** Both players grab one structure →
      walk speed unpenalised (vs. solo-carry slow). First-class "we did it
      together" verb, cheap on top of the existing carry system.
- [ ] **C2 · Passenger usefulness. P1/M/M2.** The passenger seat can swing
      a tool: driver drives, passenger harvests/fights. Turns every 2-seat
      vehicle into a co-op machine and answers "what do I do while you
      drive?"
- [ ] **C3 · Ping wheel. P2/S/M2.** The existing ping, plus three flavours
      (come / danger / loot) via hold-direction. Couch players talk, but
      phones-as-controllers means eyes down sometimes.
- [ ] **C4 · Split-screen merge when close. P2/M/M3.** The PoC plan's
      LEGO-style camera merge. Pure polish, big couch-feel payoff.
- [ ] **C5 · Shared goal display. P1/S/M1.** The Beacon/repair bill pinned
      as a small shared progress strip — the couch needs one thing both
      players can point at.

## Epic W · A world that asks to be crossed

Generation is strong; occupancy is thin. The map needs more nouns and the
nouns need verbs.

- [ ] **W20 · Neutral fauna. P1/M/M2.** 2–3 passive creatures (grazers,
      birds that scatter) that make the world alive and give the bog its
      monsters by contrast. No drops, no AI beyond flee — set dressing that
      moves.
- [ ] **W21 · Biome set-pieces beyond landmarks. P1/M/M2.** One unique
      per-biome feature worth photographing: hot springs in the snow (heal
      while standing), a desert glass crater, bog lights at night. One each,
      hand-designed, placed by the landmark lattice.
- [ ] **W22 · Water content. P1/M/M2.** The sea is the largest biome and
      has nothing in it: islands with rich ore, floating debris, deep-water
      "shadow" that nudges boats. Boats currently unlock an empty blue plain.
- [ ] **W23 · Rivers as ROUTES. P2/S/M2.** Boats on rivers should be the
      fast path inland — check widths are navigable, make riverbanks slightly
      resource-richer so following one feels like a road.
- [ ] **W24 · Nest raiding. P2/S/M2.** Destroying a nest (it fights back,
      spawning its brood) yields a material cache and quiets the area for a
      few days. Turns "annoying spawner" into "risk/reward site".
- [ ] **W25 · Region character. P2/M/M3.** Named regions get one dial each
      from their name-noun (a Weald is denser in trees, a Barrens thinner) —
      determinism preserved, names becoming slightly true.

## Epic P · Production lines — the hexgrid's promised land

The 6-neighbour foundation was built for this. It is the late-game the
prototype needs to prove ONCE, not build fully.

- [ ] **P1 · Adjacency chains, minimum viable. P1/L/M2.** A converter
      adjacent to a depot pulls from it; adjacent to another converter,
      chains. Visible item pips hopping between structures. Scope: adjacency
      only, no belts/routing. This is the "it's alive" screenshot the whole
      production system exists for.
- [ ] **P2 · Harvester structures. P2/M/M3.** A structure with `harvest`
      auto-works an adjacent node (already partially in runAutomation —
      finish and surface it). Complete chain: extractor → depot → kiln →
      pantry/stockpile, zero players present.

## Epic O · The first ten minutes

Testers who don't reach a fabrication never come back. Nothing in this epic
is a tutorial screen.

- [ ] **O1 · The scripted first minute. P0/M/M1.** Spawn beside the damaged
      machine (G1's three lines), one bush and three trees guaranteed within
      sight (spawn-area authored overrides), the machine asks for its first
      repair (G3 tier 0→1: "bring me 10 wood"), completing it opens the
      blueprint pad unprompted with "draw me an axe — anything axe-shaped".
      First fabrication inside 4 minutes, guaranteed by layout not by text.
- [ ] **O2 · Contextual one-liners, unified. P0/S/M1.** The hint system
      exists in pieces (hunger, carry prompts). Unify: one queue, one style,
      each hint fires once per world, ~12 total (first ore sighting → "bare
      hands can't take that", first night warning, first full pack…).
- [ ] **O3 · Empty-state coaching. P1/S/M1.** Already decent in the design
      library; extend to the belt (no tools yet → "sketch a tool at the
      Fabricator") and the map legend.
- [ ] **O4 · Sketchpad guidance. P1/S/M2.** Faint prompt art in the empty
      pad ("draw the SHAPE — wheels? legs? a hull?") teaching that the
      drawing matters, because testers who type a name and skip the sketch
      get worse machines and blame the game.

## Epic Q · Quality, trust, and the demo bar

- [ ] **Q1 · Reconnect hardening. P0/M/M1.** The "reconnecting" chip shows
      often on prod. Audit socket resume: phone re-identify, screen snapshot
      resend, input freshness. A couch demo that drops a controller for 10s
      is a failed demo regardless of everything else.
- [ ] **Q2 · Performance floor. P0/S/M1.** A frame-time budget line in the
      perf HUD, tested worlds with 100+ structures; particle pooling audit.
      Target: 60fps desktop, 30fps steady on a mid phone as touch host.
- [ ] **Q3 · Fabrication cost guard. P1/S/M1.** Per-room daily budget cap
      on API spend with a friendly "the Fabricator is resting" message, so a
      public room code can't drain the key. (Rate cap exists per-hour; add
      the daily ceiling + counter surfaced in logs.)
- [ ] **Q4 · Save slots per room, versioned. P2/M/M3.** One autosave is
      one bad save away from a lost expedition; keep 3 rolling snapshots.
- [ ] **Q5 · Playtest telemetry-lite. P1/S/M1.** Log-line counters (designs
      made, deaths, session length, commands of the cheat console) printed
      at teardown — enough to check the fun metrics without building
      analytics.
- [ ] **Q6 · A demo world. P2/S/M3.** One curated seed (found by search,
      not authored) documented as the demo: good spawn, close biomes, a
      wreck in sight. Demos deserve rehearsal.

## Explicitly cut (so it stays cut)

- PvP, griefing systems, or more than 2 players — the couch is the format.
- Procedural quests/dialogue beyond the ~15 hand-written requests.
- Meta-progression between worlds (unlocks that persist across seeds).
- BYOK / model picker UI. Multiplayer across the internet. Mod support.
- Durability/repair on tools, fuel on vehicles — friction without fantasy.
- Any audio, per standing preference.

## Sequencing

**M1 "The Spine"** — G1 G2 G3 · F10 F11 F12 · J1 J2 J3 · S20 S21 S23 · C5 ·
O1 O2 · Q1 Q2 Q5. Exit test: a stranger plays 45 minutes unprompted and can
say what they're trying to achieve.

**M2 "Depth"** — G4 G5 · F13 F15 · J4 J5 · S22 · C1 C2 C3 · W20 W21 W22
W23 W24 · P1 · O3 O4. Exit test: two testers argue about what to build next.

**M3 "Cohesion"** — G6 · J6 · S24 · C4 · W25 · P2 · Q4 Q6 + a full balance
pass driven by Q5's numbers. Exit test: the demo runs twice back-to-back
without an apology.

## Risks the plan is built around

1. **Fabrication latency is the loop's tax.** F11/F15 hide it, F10 spends
   it on ceremony; if testers still stall on it, queue depth and a faster
   compile model re-open (the eval harness makes the comparison cheap).
2. **Model quality variance.** A bad compile at a story beat (O1's axe)
   would poison the first impression — O1 should use mock-grade guaranteed
   fallbacks if the compile misfires (the mock compiler already exists).
3. **Scope gravity.** Epics W and P grow if unwatched. The milestone exit
   tests, not feature counts, gate progression.
4. **Cozy/teeth balance is a feel judgement** — S-epic numbers ship behind
   the cheat console (`/night`, `/bank-add`) so every playtest can probe
   both extremes in minutes.
