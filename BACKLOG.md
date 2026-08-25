# Universal Fabricator — backlog

The Fabrication pipeline works as a PoC. This backlog is about the **game around
it**: a world worth exploring, survival stakes, and an interface that feels like
a game rather than a test harness.

Status: `[ ]` open · `[~]` in progress · `[x]` done

---

## World — continuous, deterministic, efficient

The island is gone. The world is unbounded and generated on demand from the room
code, using every biome in the Kenney hexagon pack.

- [x] **W1 · Ditch world configuration.** Remove the lobby size/bog/shore/scatter
      knobs, `shared/world-settings.ts`, and the settings carried in world saves.
      The room code is the seed; there is nothing to tune.
- [x] **W2 · Continuous biome generation.** Unbounded hex coordinates. Three
      low-frequency noise fields (elevation, moisture, temperature) select from
      all ten Kenney biomes: water, sand, grass, autumn, dirt, magic (bog),
      stone, rock, snow, lava. Pure function of `(col, row, seed)` — no map array,
      no bounds.
- [x] **W3 · Chunked rendering.** Terrain streams as per-chunk RenderTextures
      around the two cameras, with an LRU cap. Resource nodes and their collision
      bodies spawn and despawn with their chunk. Seam-free: each chunk redraws the
      one row and column that bleed into it, so chunk quads tile exactly and
      depth ordering never has to arbitrate.
- [x] **W4 · Minimap.** In-HUD canvas showing the biome field around the players,
      both players, the Fabricator, and built structures.
- [x] **W5 · Partner pointer.** An arrow at the edge of each viewport pointing at
      the other player — only when they are close enough to matter but not
      already on screen.
- [x] **W6 · Water and impassable ground.** Water blocks walking; `float`
      locomotion crosses it. Lava is impassable. Shorelines get wave trim.
- [x] **W7 · Biome-appropriate props.** Cactus in the desert, autumn trees in the
      woodland, snow rocks in the tundra, mossy boulders in the wet, hills as
      relief — instead of one pine and one boulder everywhere.
- [x] **W8 · Landmarks.** Rare hand-authored set pieces (ruins, groves, bog
      hollows) placed deterministically, so exploring has destinations.
- [x] **W9 · Named regions.** "Snowfield · 180 hexes out" becomes "the Ashen
      Reach", so two players can arrange to meet somewhere. Must be a pure
      function of (hex, seed) like the rest of the world — the same ground
      carries the same name in every session and on both screens, with no
      stored state and nothing to sync. Anything that needs a server round
      trip to agree on a name is the wrong design.
- [x] **W10 · Rivers.** Water only arrives as sea. A river running down the
      elevation gradient would give the map structure and make `float` worth
      building before you reach a coast.

## Presentation

- [x] **P1 · Start screen.** A real title screen with an animated background loop,
      not a form. Thematic: the Fabricator, its light, drifting particles.
- [x] **P2 · Lobby redesign.** Same treatment as the title: joining should feel
      like boarding an expedition.
- [x] **P3 · Controller theming.** The phone should look like a device from the
      same world as the screen — plated panels, indicator lights, the Fabricator's
      blue.
- [x] **P4 · Joystick polish.** Centre it on first touch (already the behaviour;
      make it read that way), with a visible ring, dead-zone, and travel feedback.
- [x] **P5 · Design thumbnails.** Show the fabricated sprite in the design library
      on the phone, so you can see what you are about to pay for.
- [x] **P6 · Survival HUD.** Health and hunger in the in-frame HUD, plus the
      carried-inventory strip.

## Playing without two phones

The keyboard fallback (P1 WASD+F/G, P2 arrows+K/L) turned out to be how the
game gets tried first — but it can only walk and gather, and the world always
assumed exactly two players.

- [x] **UX-1 · The Fabricator on the screen.** Blueprint pad and design store
      reachable from the keyboard, drawn with the mouse. Same gating as the
      phone: only at the machine.
- [x] **UX-2 · Solo, and drop-in co-op.** One player gets the whole screen. The
      split appears the moment a second player arrives — a phone joining, or
      someone touching the arrow keys — and they land next to player one rather
      than a continent away.
- [x] **UX-3 · Control hints.** Say what the keys are, in the game, where you
      need them.

## One device, no controller

The game already runs on a laptop alone, or on any device with a phone paired
to it. What it can't do is run on a single phone or tablet — which is the most
likely way somebody tries it for the first time.

- [x] **M1 · Touch controls on the screen itself.** When the screen is opened on
      a touch device, overlay the pad directly onto the game the way Minecraft
      does on mobile: floating stick, action buttons, Fabricator. Input goes
      straight to the simulation — no room to join, no second device, no server
      round trip.
- [x] **M2 · A HUD that fits a phone.** Minimap, player card, hints and the
      Fabricator panel all sized for a small screen, in either orientation.
- [x] **M3 · Let a friend still join.** A phone joining a touch-hosted game
      becomes player two, not player one — the person holding the tablet should
      not have their character taken off them.

## Fabrication

- [x] **F1 · The Fabricator is a place.** BLUEPRINT and DESIGNS only open when
      you are standing at the machine. Walking up to it is what starts a design.
- [x] **F2 · Structure placement.** Carry a fabricated structure as a translucent
      ghost, highlight the hex under it, place it centred on that hex with the
      action button.
- [x] **F3 · Extend the capability matrix.** Four new primitives beyond
      locomotion/harvest/emission: `weapon` (damage, reach, cooldown), `storage`
      (a bigger pack on a tool, a depot on a structure), `nourish` (a farm that
      grows food), `ward` (ground that wildlife keeps off). `production` was
      left out on purpose — with three materials there is no conversion worth
      making, so it needs a reason to exist before it needs code.
- [x] **F4 · Terrain classes in the spec.** `terrainModifiers` grows to cover the
      new movement classes (rock, snow, water) so vehicles can be built for the
      new biomes. `float` becomes the water unlock.
- [x] **F5 · Emission rewrite.** Drop the chimney/wheel/lamp anchor parts
      entirely. Exhaust emits *behind* the machine relative to travel; light emits
      *around* it. Smoke, steam, sparks, dust as a shared trail system.
- [ ] **F6 · Modification loop.** Feed an existing design back into the Fabricator
      with a new sketch to produce a variant.

## Player systems

- [x] **S1 · Inventory.** Per-player carried items with capacity, distinct from
      the shared stockpile. Picking up, dropping, and depositing at the Fabricator.
- [x] **S8 · The carried stack.** You can see what you're hauling: logs, blocks
      and berries pile up over your head as you gather, whip behind you when
      you run, and lob one by one into the machine when you get home.
- [ ] **S2 · Tools.** Equip, swap, and holster fabricated tools. Still one
      permanently-attached tool per player — the pack exists now, so a tool
      should be an item in it rather than a property of the person.
- [x] **S3 · Weapons.** Fabricated weapons with a swing arc, damage, reach and
      cooldown, driven by the `weapon` primitive. Bare hands still work, so
      being cornered always has an answer.
- [x] **S4 · Health.** Damage, regeneration when fed and rested.
- [x] **S5 · Hunger.** Drains with time and effort; low hunger slows you before it
      hurts you.
- [x] **S6 · Food.** Berry bushes and fruit trees per biome, cooking at a
      fabricated fire, food as an inventory item.
- [x] **S7 · Death and respawn.** Stress-free: you wake up at the Fabricator, your
      carried inventory stays where you fell. The shared stockpile is never lost.

## Reasons to go somewhere

- [ ] **S9 · A material per hostile biome.** Bogiron gates the bog and gates it
      well. Nothing gates the snow, the bare rock or the desert, so the map's
      edges are scenery. One material each, wanted by something worth building.
- [ ] **S10 · Co-op verbs.** Actions with no single-player equivalent: carrying
      a structure between two people for less than it costs alone, or one
      driving while the other works from the passenger seat. Right now two
      players are just one player twice.

## Housekeeping

- [ ] **H1 · Eval the new primitives.** `scripts/eval-compiler.ts` predates
      weapon/storage/nourish/ward. Canned blueprints asserting that a spear
      compiles to a weapon and a silo to storage would catch prompt
      regressions — costs real API calls to run, so it stays opt-in.
- [ ] **H2 · Design deletion.** The store only ever grows, capped at 500. There
      is no way to throw out a failed experiment.

## Enemies — stress-free by design

- [x] **E1 · Dwellings.** Enemies belong to a nest placed deterministically in
      hostile biomes, and spawn from it.
- [x] **E2 · Chase AI with a leash.** Always slower than a running player. Aggro
      drops after a threshold of time out of reach, or distance from the nest.
- [x] **E3 · Combat.** Contact damage both ways, knockback, hit flashes.
- [x] **E4 · Enemy art.** Kenney enemy pack, mapped to biomes (slimes in the bog,
      spiders in the woods, snakes in the desert).

---

## Known bugs carried over

- [x] **ART-1 · Chroma key assumes magenta.** The key is learned from the
      border, removal is a flood fill inward, and the result is sanity-checked
      before it is trusted — a background it cannot read leaves the sprite
      untouched rather than destroying it.
