// Shared-screen shell. Two views on one connection:
//
//   lobby   — the join QR and code, who's in and what they're called, and
//             whether this room has a saved world to resume.
//   playing — the Phaser world, fed by relayed controller inputs.
//
// The screen owns the phase: phones follow whatever it announces, so a phone
// that joins late or reconnects lands on the right UI. Loading the screen
// always lands in the lobby — the world isn't running yet, so the phones
// shouldn't be showing a game pad either.
//
// The in-game HUD is a DOM layer stacked *inside* the game frame (over the
// canvas) rather than a bar beside it: crisp text at any DPI, and it reads as
// part of the game. Player cards sit over their own half of the split screen;
// the team stockpile is centred between them because it's shared.

import Phaser from "phaser";
import QRCode from "qrcode";
import { canAfford, formatCost } from "../../../shared/fabricator/cost";
import { resolveIdentity } from "../identity";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import { startBackdrop } from "../backdrop";
import { createSketchPad } from "../sketch";
import { createTouchPad } from "../touchpad";
import { UPLINK_ID, UPLINK_SPEC } from "../../../party/uplink";
import { FAB_TIERS, WorldScene, type MinimapData, type PlaceableDesign } from "./world";
import { CHUNK_COLS, CHUNK_ROWS, chunkOfHex } from "./chunks";
import {
  BIOMES,
  type BiomeType,
  biomeAt,
  drawBiomeMap,
  findSpawn,
  worldSeed,
} from "./worldgen";
import { chromaKeyBodySprite } from "./chroma";
import { SNAPSHOT_VERSION } from "../../../party/protocol";
import type {
  DesignAddedMsg,
  DesignBodyMsg,
  DesignCatalogMsg,
  Phase,
  PublicPlayer,
  Slot,
  WorldSnapshot,
  WorldStateMsg,
} from "../../../party/protocol";
import { designArtUrl, type Design } from "../../../party/designs";
// MATERIALS is IMPORTED, never re-declared. A local copy lived here since
// before the ores existed, and because every call site read as `MATERIALS`
// it survived the sweep that fixed world.ts, controller.ts and the protocol.
// It silently capped this whole file at three materials: no basalt, glass or
// rime chip could render, the stockpile handler only ever updated three
// counters, and the Communications repair bill showed its bogiron while
// hiding its glass.
import { MATERIALS, type MaterialType } from "../../../shared/fabricator/schema";

const ICONS: Record<MaterialType, string> = {
  wood: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1" y="5" width="11.5" height="7" rx="3.2" fill="#8a6a48"/><ellipse cx="12.4" cy="8.5" rx="2.5" ry="3.5" fill="#a8845e"/><ellipse cx="12.4" cy="8.5" rx="1.1" ry="1.7" fill="#6d5236"/></svg>`,
  stone: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 12.5 L4 5.2 L8 3 L13.2 6.2 L14 12.5 Z" fill="#98a0ab"/><path d="M4 5.2 L8 3 L11.2 5.1 L6.2 7 Z" fill="#c2c9d3"/></svg>`,
  bogiron: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 12.5 L4 5.2 L8 3 L13.2 6.2 L14 12.5 Z" fill="#463b32"/><circle cx="6" cy="8.2" r="1.4" fill="#d9813f"/><circle cx="10.2" cy="7" r="1.1" fill="#e8a468"/><circle cx="9" cy="10.6" r="1" fill="#c97b3d"/></svg>`,
  // The three seams read by silhouette, not colour: at 15px on a dark bar a
  // tinted copy of the same rock is four identical grey lumps.
  basalt: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 13 L3 6 L6 3 L9 6 L9 13 Z" fill="#4d4a63"/><path d="M9 13 L9 7 L11.5 4.6 L13.6 7 L13.6 13 Z" fill="#39374b"/><path d="M3 6 L6 3 L9 6 Z" fill="#6b6787"/></svg>`,
  glass: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 1.6 L12.6 8 L8 14.4 L3.4 8 Z" fill="#7fe4d8" opacity="0.85"/><path d="M8 1.6 L12.6 8 L8 8 Z" fill="#c4f5ee"/><path d="M8 8 L12.6 8 L8 14.4 Z" fill="#4fbfb2"/></svg>`,
  rime: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><g stroke="#9fc7ff" stroke-width="1.5" stroke-linecap="round"><path d="M8 2 L8 14"/><path d="M2.8 5 L13.2 11"/><path d="M13.2 5 L2.8 11"/></g><circle cx="8" cy="8" r="1.7" fill="#dbeaff"/></svg>`,
};


/** One player's corner of the HUD: who they are, what they're holding, and
 *  the two bars that say whether they're in trouble. */
function vitalsCard(slot: Slot): string {
  return `
    <div class="player-card p${slot} glass" id="card-p${slot}">
      <span class="dot"></span>
      <span class="who">
        <span class="name" id="name-p${slot}">Player ${slot}</span>
        <span class="tool" id="tool-p${slot}">waiting to join…</span>
        <span class="bars">
          <span class="vital" title="Health — refills on its own while you are fed.">
            <svg class="vic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.6 1.8 6.3a2.6 2.6 0 1 1 3.7-3.7l.5.5.5-.5a2.6 2.6 0 1 1 3.7 3.7Z" fill="#6fcf7f"/></svg>
            <span class="bar health"><i id="hp-p${slot}"></i></span>
          </span>
          <span class="vital" title="Food — forage berries from bushes; you eat automatically when hungry. Empty means starving.">
            <svg class="vic" viewBox="0 0 12 12" aria-hidden="true"><circle cx="5" cy="5" r="3.4" fill="#e3b25a"/><path d="M7.6 7.6 10.4 10.4" stroke="#e3b25a" stroke-width="2.2" stroke-linecap="round"/></svg>
            <span class="bar hunger"><i id="hg-p${slot}"></i></span>
          </span>
        </span>
        <span class="carry" id="carry-p${slot}"></span>
      </span>
    </div>`;
}

export function startScreen(code: string) {
  const upperCode = code.toUpperCase();
  const controllerUrl = `${window.location.origin}/c/${code}`;

  const resourceMarkup =
    MATERIALS.map(
      (m) =>
        `<div class="res${m === "wood" || m === "stone" ? "" : " ore"}" id="res-${m}" title="${m}">${ICONS[m]}<span class="n" id="n-${m}">0</span></div>`,
    ).join("") +
    // The pantry: banked food, shown like an ore — absent until it exists.
    `<div class="res ore" id="res-food" title="pantry — banked food; fed to whoever is hungry at the Fabricator">` +
    `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="6.4" cy="6.4" r="4.4" fill="#e3b25a"/><path d="M9.8 9.8 13.4 13.4" stroke="#e3b25a" stroke-width="2.6" stroke-linecap="round"/></svg>` +
    `<span class="n" id="n-food">0</span></div>`;

  const app = document.getElementById("app")!;

  /**
   * A phone or tablet opening the screen route plays on its own: the pad is
   * drawn over the game rather than living on a second device. Coarse pointer
   * is the right test — it asks whether the primary input is a finger, not
   * how wide the window happens to be.
   */
  const touchHost = window.matchMedia("(pointer: coarse)").matches;

  // ── state that outlives the view switch ─────────────────────
  // The design catalog and the saved world both arrive right after connecting,
  // while the lobby is still up, and have to survive into the game.
  const designs = new Map<string, Design>();
  // playerId → slot, from roster broadcasts (routes fabricated tools to
  // whoever drew the blueprint).
  const slotByPlayerId = new Map<string, Slot>();
  let lastStock: Record<MaterialType, number> | null = null;
  /** Last known Fabricator proximity per slot, so a phone that reconnects
   *  mid-game is told the truth instead of waiting for the next edge. */
  const fabRange: Record<Slot, boolean> = { 1: false, 2: false };
  let pendingSnapshot: WorldSnapshot | null | undefined;
  // The room code IS the world. There is nothing to configure: a new code is
  // a new planet, and the same code always regenerates the same one.
  const seed = worldSeed(upperCode);
  let roster: PublicPlayer[] = [];
  let phase: Phase = "lobby";
  let scene: WorldScene | null = null;
  // ── the fabrication patience budget ───────────────────────────
  // A fabrication that has truly died must not leave the pad spinning
  // forever. 90s covers a slow compile plus slow art with room to spare;
  // each progress message re-arms it, so only genuine silence trips it.
  // Outer scope, because the socket handler that arms it outlives any view.
  // One timer, but a COUNT of outstanding fabrications: with two players
  // fabricating at once, the first design landing must not disarm the
  // watchdog that the second one is still relying on.
  let fabTimeout: ReturnType<typeof setTimeout> | null = null;
  let fabOutstanding = 0;
  const disarmFabTimeout = () => {
    fabOutstanding = Math.max(0, fabOutstanding - 1);
    if (fabOutstanding === 0 && fabTimeout) {
      clearTimeout(fabTimeout);
      fabTimeout = null;
    }
  };
  const armFabTimeout = (fresh = true) => {
    if (fresh) fabOutstanding++;
    if (fabTimeout) clearTimeout(fabTimeout);
    fabTimeout = setTimeout(() => {
      fabTimeout = null;
      fabOutstanding = 0;
      scene?.clearFabricating();
      toast("The Fabricator has gone quiet — that design isn't coming. Try again.", true);
    }, 90_000);
  };
  let connStatus = "connecting";
  /** The lobby's animated hex field. Torn down when the world starts — it's a
   *  rAF loop, and the game needs every frame it can get. */
  let stopBackdrop: (() => void) | null = null;

  // Per-view hooks, replaced on every render.
  let onRoster: () => void = () => {};
  let onConnStatus: () => void = () => {};
  let onSnapshot: () => void = () => {};
  /** Set once the game view exists. The socket is listening long before that,
   *  so both are no-ops until there is something to act on. */
  /**
   * A rolling trace of what the Fabricator is doing, shown by /log in the
   * cheat console. The pipeline spans two machines and four stages, and its
   * only visible states were a spinner and a toast — when a sprite came back
   * wrong there was nowhere to look.
   */
  const trace: string[] = [];
  const traceLine = (line: string) => {
    const t = new Date().toISOString().slice(11, 19);
    trace.push(`${t} ${line}`);
    if (trace.length > 60) trace.shift();
    console.log(`[fab] ${line}`); // also in devtools, where stack traces live
  };
  let requestDiscardRef: (id: string, requester?: string) => void = () => {};
  let renderFabListRef: () => void = () => {};
  /** Set by startGame; restores a saved world once both it and the scene
   *  are in hand. A no-op while the lobby is up. */
  let tryRestore: () => void = () => {};

  const placeable = (d: Design): PlaceableDesign => ({
    id: d.id,
    spec: d.spec,
    artUrl: designArtUrl(d),
  });

  keepScreenAwake();

  // ── lobby view ──────────────────────────────────────────────
  function renderLobby() {
    phase = "lobby";
    app.innerHTML = `
      <div class="lobby" id="lobby-root">
        <div class="lobby-layer">
          <header class="lobby-head">
            <span class="brand"><b>VIBETECH</b>PRIVATEER</span>
            <span class="spacer"></span>
            <span class="conn" id="conn-status">${connStatus}</span>
          </header>

          <div class="lobby-body">
            <section class="lobby-panel">
              <div class="panel-title"><span class="step">1</span> Grab your phones</div>
              <div class="join-block">
                <canvas id="qr-canvas"></canvas>
                <div class="join-copy">
                  <div class="label">room code</div>
                  <div class="big-code">${upperCode}</div>
                  <div class="url">${controllerUrl}</div>
                  <div class="label">or open the site and type the code</div>
                </div>
              </div>
              <div class="slots" id="slots"></div>
              <div class="spectators" id="spectators"></div>
            </section>

            <section class="lobby-panel">
              <div class="panel-title"><span class="step">2</span> The claim</div>
              <div class="world-preview">
                <canvas id="world-map" width="300" height="300"></canvas>
                <div class="world-legend" id="world-legend"></div>
              </div>
              <div class="lobby-note" id="world-note">Checking for a saved world…</div>
            </section>
          </div>

          <footer class="lobby-foot">
            <span class="hint" id="start-hint"></span>
            <span class="spacer"></span>
            <button class="primary" id="start-btn">OPEN THE CLAIM</button>
          </footer>
        </div>
      </div>
    `;

    stopBackdrop?.();
    stopBackdrop = startBackdrop(document.getElementById("lobby-root")!);

    const statusEl = document.getElementById("conn-status")!;
    onConnStatus = () => {
      statusEl.textContent = connStatus;
    };

    QRCode.toCanvas(
      document.getElementById("qr-canvas") as HTMLCanvasElement,
      controllerUrl,
      { width: 190, margin: 1 },
    ).catch(() => {});

    const slotsEl = document.getElementById("slots")!;
    const spectatorsEl = document.getElementById("spectators")!;
    const noteEl = document.getElementById("world-note")!;

    // ── landing site preview ──────────────────────────────────
    // The generator is Phaser-free precisely so this preview is the same
    // function the expedition lands in — what you see here is the ground you
    // will actually be standing on. There is nothing to tune: the room code
    // is the world, and the map simply extends past the edges of this frame
    // in every direction, for as far as anyone cares to walk.
    const mapEl = document.getElementById("world-map") as HTMLCanvasElement;
    const legendEl = document.getElementById("world-legend")!;
    const spawn = findSpawn(seed);

    drawBiomeMap(mapEl, seed, spawn, 0.55);
    drawSpawnMarker(mapEl);

    // Which biomes are actually within reach of the landing site, in order of
    // how much of the neighbourhood they cover. A legend of the whole palette
    // would advertise ground you'd have to cross a sea to reach.
    {
      const seen = new Map<BiomeType, number>();
      for (let dr = -80; dr <= 80; dr += 2) {
        for (let dc = -80; dc <= 80; dc += 2) {
          const b = biomeAt(spawn.col + dc, spawn.row + dr, seed);
          seen.set(b, (seen.get(b) ?? 0) + 1);
        }
      }
      legendEl.innerHTML = [...seen]
        .filter(([, n]) => n > 20) // ignore a stray hex of something exotic
        .sort((a, b) => b[1] - a[1])
        .map(
          ([b]) =>
            `<span class="biome"><i style="background:${BIOMES[b].color}"></i>${BIOMES[b].label}</span>`,
        )
        .join("");
    }

    const startHint = document.getElementById("start-hint")!;
    const startBtn = document.getElementById("start-btn") as HTMLButtonElement;

    onSnapshot = () => {
      if (pendingSnapshot === undefined) return; // still waiting on the server
      if (!pendingSnapshot) {
        noteEl.innerHTML =
          "<b>Untouched ground.</b> This is where you come down — and the map " +
          "keeps going in every direction, as far as you care to walk. " +
          `Room <b>${upperCode}</b> always leads back to this same planet.`;
        startBtn.textContent = "OPEN THE CLAIM";
        return;
      }
      const snap = pendingSnapshot;
      const stock = snap.stockpile;
      noteEl.innerHTML =
        `<b>An open claim's ledger found.</b> ${snap.built.length} object` +
        `${snap.built.length === 1 ? "" : "s"} built, ` +
        `${snap.harvested.length} resource node` +
        `${snap.harvested.length === 1 ? "" : "s"} worked, ` +
        // Whatever is actually in it: a resumed expedition that has been to
        // the snow should say so, and one that never left the grass should
        // not list four empty seams.
        `stockpile ${
          MATERIALS.filter((m) => (stock[m] ?? 0) >= 1)
            .map((m) => `${Math.floor(stock[m] ?? 0)} ${m}`)
            .join(" · ") || "empty"
        }.`;
      startBtn.textContent = "REOPEN THE CLAIM";
    };
    onSnapshot();

    onRoster = () => {
      const bySlot = new Map<Slot, PublicPlayer>();
      for (const p of roster) {
        if (p.slot) bySlot.set(p.slot, p);
      }
      slotsEl.innerHTML = ([1, 2] as const)
        .map((slot) => {
          const p = bySlot.get(slot);
          const state = !p
            ? "empty"
            : !p.connected
              ? "offline"
              : p.ready
                ? "ready"
                : "joined";
          const stateText = {
            empty: "waiting for a phone",
            offline: "disconnected",
            ready: "ready",
            joined: "picking a name…",
          }[state];
          const name = p?.nickname || (p ? `Player ${slot}` : "—");
          return `
            <div class="slot-card p${slot} ${state}">
              <span class="dot"></span>
              <div class="slot-text">
                <div class="slot-name">${escapeHtml(name)}</div>
                <div class="slot-state">P${slot} · ${stateText}</div>
              </div>
            </div>
          `;
        })
        .join("");

      const spectators = roster.filter((p) => p.slot === null && p.connected).length;
      spectatorsEl.textContent = spectators
        ? `${spectators} more phone${spectators > 1 ? "s" : ""} connected — this build seats two.`
        : "";

      const active = roster.filter((p) => p.slot !== null && p.connected);
      const readyCount = active.filter((p) => p.ready).length;
      const allReady = active.length > 0 && readyCount === active.length;
      startHint.textContent = !active.length
        ? "No phones yet — you can still start and play with the keyboard (P1 WASD+F/G · P2 arrows+K/L)."
        : allReady
          ? `${active.length === 2 ? "Both players" : "Player"} ready — press START (or hit Enter).`
          : `${readyCount}/${active.length} ready.`;
      startBtn.classList.toggle("pulse", allReady);
    };
    onRoster();

    startBtn.addEventListener("click", () => startGame());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (document.activeElement instanceof HTMLInputElement) return;
      window.removeEventListener("keydown", onKey);
      startGame();
    };
    window.addEventListener("keydown", onKey);

    syncPhase();
  }

  // ── playing view ────────────────────────────────────────────
  function startGame() {
      phase = "playing";
      syncPhase();
      // The backdrop is a requestAnimationFrame loop; Phaser wants that budget.
      stopBackdrop?.();
      stopBackdrop = null;
      app.innerHTML = `
      <div class="screen">
        <div class="screen-stage${touchHost ? " touch pad-surface slot-1" : ""}" id="stage">
          <div class="split-divider"></div>

          <div class="hud">
            <div class="hud-top">
              ${vitalsCard(1)}

              <div class="resources glass">${resourceMarkup}</div>

              ${vitalsCard(2)}
            </div>

            <div class="hud-map glass" id="hud-map">
              <canvas id="minimap" width="150" height="150"></canvas>
              <div class="map-where" id="map-where"></div>
              <div class="map-at" id="map-at"></div>
            </div>

            <div class="hud-bottom">
              <div class="chip-mini glass">ROOM ${upperCode}</div>
              <div class="toast glass" id="toast"></div>
              <div class="chip-mini glass" id="conn-chip"><span class="dot"></span><span id="conn-text">connecting</span></div>
            </div>
          </div>

          <div class="intro-overlay hidden" id="intro">
            <div class="intro-card glass">
              <h2>VIBETECH PRIVATEER · CLAIM ${upperCode}</h2>
              <p>The contract was simple: assay the planet, transmit the claim,
                 get paid. The landing was not. Your ship is scattered across
                 three regions and the uplink went with it.</p>
              <p>The Universal Fabricator™ survived — damaged, but running, and
                 still very much on the company's side.</p>
              <p class="fw">"Good news, Privateer: the asset survived. Refer to
                 me as the asset. Directive one: stop bleeding. Directive two:
                 ten units of timber — the company measures initiative."</p>
              <p class="go">CLICK OR PRESS ANY KEY</p>
            </div>
          </div>
          <div class="intro-overlay hidden" id="uplink-choice">
            <div class="intro-card glass">
              <h2>THE ARRAY IS COMPLETE</h2>
              <p class="fw" id="uplink-fw"></p>
              <p>One transmission reaches VibeTech. The claim files itself; the
                 fleet comes; you get paid. That was the contract.</p>
              <p>Or the array becomes something no one contracted for — a light
                 for the place you have been building all along.</p>
              <div class="ending-btns">
                <button id="end-transmit"><b>TRANSMIT THE CLAIM</b><i>complete the contract</i></button>
                <button id="end-stay"><b>REPURPOSE THE ARRAY</b><i>make it the lighthouse</i></button>
              </div>
              <p class="go" id="uplink-hint">ESC TO DECIDE LATER</p>
            </div>
          </div>
          <div class="intro-overlay hidden" id="endscreen">
            <div class="intro-card glass">
              <h2 id="end-title"></h2>
              <p id="end-body"></p>
              <p class="fw" id="end-fw"></p>
              <p class="go" id="end-stats"></p>
              <p class="go">CLICK TO KEEP PLAYING — the claim is yours either way</p>
            </div>
          </div>
          <div class="fab-panel hidden" id="fab-panel">
            <div class="fab-sheet">
              <div class="fab-repair hidden" id="fab-repair">
                <span class="fr-text" id="fab-repair-text"></span>
                <button id="fab-repair-btn">REPAIR</button>
              </div>
              <header class="fab-head">
                <span class="fab-who" id="fab-who">PLAYER 1</span>
                <div class="fab-tabs">
                  <button data-tab="blueprint" class="on">BLUEPRINT</button>
                  <button data-tab="designs">DESIGNS <span id="fab-count">0</span></button>
                </div>
                <span class="spacer"></span>
                <span class="fab-stock" id="fab-stock"></span>
                <button class="fab-close" id="fab-close">ESC</button>
              </header>

              <section class="fab-pane" data-pane="blueprint">
                <div class="fab-fields">
                  <input id="fab-name" type="text" maxlength="32" autocomplete="off"
                         spellcheck="false" placeholder="Name it — e.g. Swamp Buggy" />
                  <input id="fab-intent" type="text" maxlength="80" autocomplete="off"
                         spellcheck="false" placeholder="Optional: what should it do?" />
                </div>
                <div class="fab-canvas-wrap"><canvas id="fab-sketch"></canvas></div>
                <div class="fab-actions">
                  <span class="hint">Draw with the mouse. The Fabricator reads the shape, not the artistry.</span>
                  <span class="spacer"></span>
                  <button id="fab-clear">Clear</button>
                  <button class="primary" id="fab-submit">FABRICATE</button>
                </div>
              </section>

              <section class="fab-pane hidden" data-pane="designs">
                <div class="fab-list" id="fab-list"></div>
              </section>
            </div>
          </div>

          <button class="touch-fab hidden" id="touch-fab">✎ FABRICATOR</button>
          <div class="cheat hidden" id="cheat">
            <pre class="cheat-out" id="cheat-out"></pre>
            <input id="cheat-in" type="text" spellcheck="false" autocomplete="off"
              placeholder="/help — Enter runs · Esc closes" />
          </div>
          <button class="touch-fab touch-swap hidden" id="touch-swap">⇄ TOOL</button>

          <div class="key-hints" id="key-hints"></div>

          <div class="qr-overlay hidden" id="qr-overlay">
            <div class="label">scan with both phones to join · or enter the code at ${window.location.origin}</div>
            <div class="code">${upperCode}</div>
            <canvas id="qr-canvas"></canvas>
            <div class="url">${controllerUrl}</div>
            <button class="dismiss" id="qr-dismiss">hide (keyboard: P1 WASD+F/G · P2 arrows+K/L)</button>
          </div>
        </div>
      </div>
    `;

    const qrOverlay = document.getElementById("qr-overlay")!;
    QRCode.toCanvas(
      document.getElementById("qr-canvas") as HTMLCanvasElement,
      controllerUrl,
      { width: 200, margin: 1 },
    ).catch(() => {});

    let dismissed = false;
    document.getElementById("qr-dismiss")!.addEventListener("click", () => {
      qrOverlay.classList.add("hidden");
      dismissed = true;
    });

    // ── Phaser ──────────────────────────────────────────────────
    // Boot only once the stage has settled to a real size (flex layout can
    // still be 0×N when this module runs, which breaks WebGL framebuffers),
    // then track the stage with a ResizeObserver — window-resize events alone
    // don't cover in-page layout changes (e.g. inside the test-harness iframe).
    const worldScene = new WorldScene();
    scene = worldScene;
    const stage = document.getElementById("stage")!;
    const boot = () => {
      if (stage.clientWidth === 0 || stage.clientHeight === 0) {
        requestAnimationFrame(boot);
        return;
      }
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: stage,
        backgroundColor: "#20361f",
        scale: {
          mode: Phaser.Scale.NONE,
          width: stage.clientWidth,
          height: stage.clientHeight,
        },
        physics: { default: "arcade", arcade: { debug: false } },
        scene: [],
        callbacks: {
          postBoot: (g) => {
            // upperCode, not code: the lobby preview seeds from the same
            // string, and "abcd" and "ABCD" are different worlds.
            g.scene.add("world", worldScene, true, { seed: upperCode });
          },
        },
      });
      // Dev/test hook. Phaser advances its asset loader inside the game step,
      // so a tab that isn't compositing never finishes loading and looks hung
      // — which is indistinguishable from a real freeze unless you can drive
      // frames by hand. `__world` only appears once the scene exists, so it's
      // no use for diagnosing a boot that never gets that far.
      (window as unknown as { __game: Phaser.Game }).__game = game;

      new ResizeObserver(() => {
        if (stage.clientWidth && stage.clientHeight) {
          game.scale.resize(stage.clientWidth, stage.clientHeight);
        }
      }).observe(stage);
    };
    boot();

    // ── stockpile ───────────────────────────────────────────────
    const counters = new Map<MaterialType, { el: HTMLElement; box: HTMLElement }>();
    for (const m of MATERIALS) {
      counters.set(m, {
        el: document.getElementById(`n-${m}`)!,
        box: document.getElementById(`res-${m}`)!,
      });
    }

    // ── world save / restore ────────────────────────────────────
    // Terrain is deterministic from the room code; only deltas travel. The
    // snapshot and the scene become ready in either order, so restore runs
    // when both are in hand — and exactly once.
    let sceneReady = false;
    let restored = false;

    tryRestore = () => {
      if (restored || !sceneReady || pendingSnapshot === undefined) return;
      restored = true;
      if (pendingSnapshot) {
        worldScene.applySnapshot(pendingSnapshot, (id) => {
          const d = designs.get(id);
          return d ? placeable(d) : null;
        });
      }
      // saves only start once the saved world is back in place, so a restore
      // race can never overwrite a good save with an empty world
      worldScene.onDirty = scheduleSave;
    };

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSave = () => {
      if (saveTimer) return; // coalesce bursts (harvesting fires constantly)
      saveTimer = setTimeout(() => {
        saveTimer = null;
        conn.send({ scope: "ui", type: "world-save", snapshot: worldScene.snapshot() });
      }, 3000);
    };

    // ── touch controls, drawn over the game ─────────────────────
    // On a phone or tablet there is no second device: the pad goes straight
    // onto the screen, and its input goes straight into the simulation
    // running behind it. No socket round trip — the player and the world are
    // the same machine, and routing through the server would only add lag.
    if (touchHost) {
      createTouchPad(stage, (padState) => {
        worldScene.setInput(1, {
          stick: { ...padState.stick },
          buttons: { ...padState.buttons },
        });
      });
      const touchFab = document.getElementById("touch-fab")!;
      touchFab.classList.remove("hidden");
      touchFab.addEventListener("click", () => openFab(1));
      // Only worth showing once there is something to swap between, so a
      // player who has built nothing is not asked about a belt they lack.
      const touchSwap = document.getElementById("touch-swap")!;
      touchSwap.addEventListener("click", () => worldScene.cycleTool(1));
    }

    // ── the Fabricator, on the screen ───────────────────────────
    // Everything the phone can do, reachable from the keyboard and mouse:
    // 1 opens it for player one, 2 for player two, Esc closes. Same rule as
    // the phone — only at the machine — because otherwise the keyboard would
    // quietly be the better way to play.
    const fabPanel = document.getElementById("fab-panel")!;
    const fabWho = document.getElementById("fab-who")!;
    const fabCount = document.getElementById("fab-count")!;
    const fabStock = document.getElementById("fab-stock")!;
    const fabList = document.getElementById("fab-list")!;
    const fabName = document.getElementById("fab-name") as HTMLInputElement;
    const fabIntent = document.getElementById("fab-intent") as HTMLInputElement;
    const pad = createSketchPad(document.getElementById("fab-sketch") as HTMLCanvasElement, 7);
    let fabSlot: Slot = 1;

    const showPane = (tab: string) => {
      for (const btn of fabPanel.querySelectorAll<HTMLElement>("[data-tab]")) {
        btn.classList.toggle("on", btn.dataset.tab === tab);
      }
      for (const pane of fabPanel.querySelectorAll<HTMLElement>("[data-pane]")) {
        pane.classList.toggle("hidden", pane.dataset.pane !== tab);
      }
      if (tab === "blueprint") requestAnimationFrame(pad.fit);
      else renderFabList();
    };

    function renderFabList() {
      const items = [...designs.values()].sort((a, b) => b.createdAt - a.createdAt);
      fabCount.textContent = String(items.length);
      // (The Uplink row below renders even with an empty library — it is the
      // one design that predates every sketch.)
      const s =
        lastStock ??
        (Object.fromEntries(MATERIALS.map((m) => [m, 0])) as Record<MaterialType, number>);
      // The Uplink, pinned first, from minute one. The whole economy points
      // at this row; it must never be scrolled out of memory.
      const uplinkDecided = !!scene?.ending;
      const uplinkStanding = scene?.hasUplink() ?? false;
      const uplinkTierOk = (scene?.fabTier ?? 0) >= 3;
      const uplinkAfford = canAfford(s, UPLINK_SPEC.cost);
      const uplinkRow = `
            <div class="fab-row uplink">
              <div class="noart uplink-art">◈</div>
              <div class="meta">
                <div class="n">${UPLINK_SPEC.displayName}</div>
                <div class="c">company property · ${formatCost(UPLINK_SPEC.cost)}</div>
                <div class="f">${escapeHtml(UPLINK_SPEC.flavor)}</div>
              </div>
              <div class="row-actions">
                <button data-build="${UPLINK_ID}" ${uplinkTierOk && uplinkAfford && !uplinkStanding ? "" : "disabled"}>${
                  uplinkDecided
                    ? "DECIDED"
                    : uplinkStanding
                      ? "STANDING — GO TO IT"
                      : !uplinkTierOk
                        ? "REQUIRES COMMUNICATIONS"
                        : uplinkAfford
                          ? "BUILD"
                          : "NEED MORE"
                }</button>
              </div>
            </div>`;
      fabList.innerHTML = uplinkRow + (items.length
        ? ""
        : `<div class="fab-empty">No designs yet. Sketch one on the BLUEPRINT tab — ` +
          `the Fabricator turns it into something buildable, and you can build it ` +
          `as often as you can afford it.</div>`) + items
        .map((d) => {
          const c = d.spec.cost;
          // canAfford, not three comparisons: the hand-written version silently
          // stopped covering the bill the moment there were more materials.
          const afford = canAfford(s, c);
          const tierOk = scene?.tierAllows(d.spec.category) ?? true;
          const art = designArtUrl(d);
          return `
            <div class="fab-row">
              ${art ? `<img src="${art}" alt="" />` : `<div class="noart"></div>`}
              <div class="meta">
                <div class="n">${escapeHtml(d.spec.displayName)}</div>
                <div class="c">${d.spec.category}${
                  d.timesBuilt ? ` · built ${d.timesBuilt}×` : ""
                } · ${formatCost(c)}${
                  d.parentId && designs.has(d.parentId)
                    ? ` <span class="lineage">↳ from ${escapeHtml(designs.get(d.parentId)!.spec.displayName)}</span>`
                    : ""
                }</div>
                <div class="f">${escapeHtml(d.spec.flavor)}</div>
              </div>
              <div class="row-actions">
                <button data-build="${d.id}" ${afford && tierOk ? "" : "disabled"}>${
                  !tierOk
                    ? `REQUIRES ${FAB_TIERS[scene!.tierFor(d.spec.category)].name.toUpperCase()}`
                    : afford
                      ? "BUILD"
                      : "NEED MORE"
                }</button>
                <button class="discard modify" data-modify="${d.id}" title="Modify this design">✎</button>
                <button class="discard" data-discard="${d.id}" title="Throw this design away">✕</button>
              </div>
            </div>`;
        })
        .join("");
    }

    /**
     * Throw a design away — from this screen or on a phone's behalf.
     *
     * The check has to happen here because only the screen holds the world.
     * A design that exists as a building is saved as an id and a position, so
     * deleting it would not remove the building now; it would remove it the
     * next time the save was loaded, which is a far worse way to find out.
     */
    /** The design being modified, carried through to the blueprint submit. */
    let fabParentId: string | null = null;
    const fabSketchEl = document.getElementById("fab-sketch") as HTMLCanvasElement;
    const clearModify = () => {
      fabParentId = null;
      fabSketchEl.classList.remove("underlay");
      fabSketchEl.style.backgroundImage = "";
    };
    const startModify = (designId: string) => {
      const d = designs.get(designId);
      if (!d) return;
      fabParentId = designId;
      showPane("blueprint");
      fabName.value = `${d.spec.displayName} Mk II`.slice(0, 32);
      fabIntent.value = "";
      pad.clear();
      // The parent's art as a ghost under the ink — a guide to draw over.
      const art = designArtUrl(d);
      if (art) {
        fabSketchEl.classList.add("underlay");
        fabSketchEl.style.backgroundImage =
          `linear-gradient(rgba(244,241,232,0.72), rgba(244,241,232,0.72)), url("${art}")`;
      }
      fabName.focus();
      fabName.select();
    };

    const requestDiscard = (designId: string, requester?: string) => {
      const d = designs.get(designId);
      if (!d) return;
      const inUse = scene?.usesDesign(designId);
      if (inUse) {
        toast(
          `<span class="lead">${escapeHtml(d.spec.displayName)} is still in use</span> — ` +
            `${inUse.where}. Get rid of that first.`,
          true,
        );
        if (requester) {
          // The refusal has to reach the phone whose tap it answers. The
          // fabricate-error channel already renders as the phone's red note
          // and already routes by `to` — no new message type needed.
          conn.send({
            scope: "ui",
            type: "fabricate-error",
            message: `${d.spec.displayName} is still in use — ${inUse.where}.`,
            to: requester,
          });
        }
        return;
      }
      // A tool on a belt is unequipped as part of the discard — refusing here
      // used to combine with "no way to remove a belt tool" into a design
      // that could never be discarded at all.
      scene?.removeFromBelts(designId);
      conn.send({ scope: "ui", type: "design-delete", designId });
    };

    requestDiscardRef = requestDiscard;
    renderFabListRef = renderFabList;

    // ── the cheat console ───────────────────────────────────────
    const cheatEl = document.getElementById("cheat")!;
    const cheatIn = document.getElementById("cheat-in") as HTMLInputElement;
    const cheatOut = document.getElementById("cheat-out")!;
    const openCheat = () => {
      cheatEl.classList.remove("hidden");
      worldScene.setUiOpen(true); // the keyboard belongs to the input now
      cheatIn.focus();
    };
    const closeCheat = () => {
      cheatEl.classList.add("hidden");
      worldScene.setUiOpen(false);
      cheatIn.blur();
    };
    cheatIn.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        closeCheat();
        return;
      }
      if (e.key !== "Enter") return;
      const line = cheatIn.value.trim();
      if (!line) return;
      // Stays open after a command: cheats come in bursts, and reopening the
      // console between each one is friction with no safety payoff.
      // /log is answered here, not by the world: the fabrication pipeline is
      // the SHELL's business — the world never sees a blueprint.
      const cmd = line.trim().replace(/^\//, "").split(/\s+/)[0];
      if (cmd === "log") {
        cheatOut.textContent = trace.length
          ? trace.slice(-14).join("\n")
          : "nothing fabricated yet this session";
        cheatIn.value = "";
        return;
      }
      cheatOut.textContent = `> ${line}\n${scene?.cheat(line) ?? "world not ready"}`;
      cheatIn.value = "";
    });

    const openFab = (slot: Slot) => {
      if (!scene?.isAtFabricator(slot)) {
        toast(`Player ${slot} has to be standing at the Fabricator.`, true);
        return;
      }
      fabSlot = slot;
      fabWho.textContent = `PLAYER ${slot}`;
      fabPanel.classList.remove("hidden");
      fabPanel.classList.toggle("p2", slot === 2);
      fabStock.textContent = lastStock
        ? MATERIALS.filter((m) => m === "wood" || m === "stone" || lastStock![m] > 0)
            .map((m) => `${Math.floor(lastStock![m])} ${m}`)
            .join(" · ")
        : "";
      worldScene.setUiOpen(true);
      showPane("blueprint");
      fabName.focus();
    };
    const closeFab = () => {
      fabPanel.classList.add("hidden");
      worldScene.setUiOpen(false);
      // Escape or a plain close abandons the modification — a later fresh
      // blueprint must not silently inherit a parent.
      clearModify();
    };

    fabPanel.addEventListener("click", (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (tab) showPane(tab.dataset.tab!);
      const modify = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-modify]");
      if (modify) {
        startModify(modify.dataset.modify!);
        return;
      }
      const discard = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-discard]");
      if (discard) {
        requestDiscard(discard.dataset.discard!);
        return;
      }
      const build = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-build]");
      if (build && !build.disabled && build.dataset.build === UPLINK_ID) {
        if (scene) {
          const outcome = scene.tryFabricate({ id: UPLINK_ID, spec: UPLINK_SPEC }, fabSlot);
          if (!outcome.ok) toast(outcome.reason, true);
          else {
            toast(
              `<span class="lead">The array is on your shoulder.</span> Choose its ground well — ` +
                `this is where the claim gets decided.`,
            );
            closeFab();
          }
        }
        return;
      }
      if (build && !build.disabled) {
        const d = designs.get(build.dataset.build!);
        if (d && scene) {
          const outcome = scene.tryFabricate(placeable(d), fabSlot);
          if (!outcome.ok) toast(outcome.reason, true);
          else if (outcome.carrying) {
            toast(
              `<span class="lead">${escapeHtml(d.spec.displayName)} is on your shoulder</span> — ` +
                `walk it where it should stand, then press <b>${fabSlot === 1 ? "F" : "K"}</b>. ` +
                `<span class="hint">Nothing is spent until you put it down.</span>`,
            );
            closeFab();
          } else {
            toast(
              `<span class="lead">Built ${escapeHtml(d.spec.displayName)}</span> ` +
                `<span class="cost">−${formatCost(d.spec.cost)}</span>`,
            );
            closeFab();
          }
        }
      }
    });
    document.getElementById("fab-close")!.addEventListener("click", closeFab);
    document.getElementById("fab-clear")!.addEventListener("click", pad.clear);
    document.getElementById("fab-submit")!.addEventListener("click", () => {
      const name = fabName.value.trim();
      if (!name) {
        fabName.focus();
        return;
      }
      conn.send({
        scope: "ui",
        type: "blueprint",
        name,
        slot: fabSlot,
        intent: fabIntent.value.trim() || undefined,
        image: pad.toDataUrl(256, 8),
        parentId: fabParentId ?? undefined,
      });
      scene?.setFabricating(name);
      fabName.value = "";
      fabIntent.value = "";
      pad.clear();
      clearModify();
      closeFab();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !choiceEl.classList.contains("hidden")) {
        closeChoice();
        return;
      }
      if (e.key === "Escape" && !fabPanel.classList.contains("hidden")) {
        closeFab();
        return;
      }
      // Ignore the shortcut while someone is typing into the panel itself.
      if (document.activeElement instanceof HTMLInputElement) return;
      // Swapping tools has to work anywhere, not at the Fabricator — the
      // whole point is choosing what to hold while you are out in the snow.
      const swap = e.key.toLowerCase();
      if (swap === "q" || swap === "j") {
        e.preventDefault();
        scene?.cycleTool(swap === "q" ? 1 : 2);
        return;
      }
      // Debug lattice: hex outlines, chunk borders, and a cursor readout, so
      // a rendering artefact can be reported by exact address.
      if (e.key === "0") {
        scene?.toggleDebugGrid();
        return;
      }
      // The cheat console — testing needs levers, and typing them beats
      // rebuilding a save to reach the situation you want to look at.
      if (e.key.toLowerCase() === "t") {
        e.preventDefault(); // or the "t" lands in the input it just opened
        openCheat();
        return;
      }
      if (e.key !== "1" && e.key !== "2") return;
      // The panel focuses its name field, and this same keystroke would then
      // land in it — every blueprint opened with 1 was called "1Something".
      e.preventDefault();
      openFab(e.key === "1" ? 1 : 2);
    });

    // ── minimap ─────────────────────────────────────────────────
    // Redrawn a few times a second, not per frame: the biome field is a pure
    // function and re-sampling 150×150 hexes is the expensive part, so the
    // terrain layer is cached and only rebuilt once the view has actually
    // travelled. Markers are cheap and repaint every tick.
    const mapCanvas = document.getElementById("minimap") as HTMLCanvasElement;
    const whereEl = document.getElementById("map-where")!;
    const atEl = document.getElementById("map-at")!;
    const mapCtx = mapCanvas.getContext("2d")!;
    const terrainLayer = document.createElement("canvas");
    terrainLayer.width = mapCanvas.width;
    terrainLayer.height = mapCanvas.height;
    /** Hexes per minimap pixel. Wide enough to show where you're heading. */
    const MAP_SCALE = 1.1;
    let drawnAt: { col: number; row: number } | null = null;

    const paintMinimap = () => {
      if (!sceneReady) return;
      const d = worldScene.minimapData();
      if (
        !drawnAt ||
        Math.abs(d.centre.col - drawnAt.col) > 3 ||
        Math.abs(d.centre.row - drawnAt.row) > 3
      ) {
        drawBiomeMap(terrainLayer, d.seed, d.centre, MAP_SCALE);
        drawnAt = { ...d.centre };
      }
      mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
      mapCtx.drawImage(terrainLayer, 0, 0);

      // Everything is placed against the cached layer's centre, not the live
      // one, or the markers would slide against the terrain between redraws.
      const at = (col: number, row: number) => ({
        x: mapCanvas.width / 2 + (col - drawnAt!.col) / MAP_SCALE,
        y: mapCanvas.height / 2 + ((row - drawnAt!.row) * 0.738) / MAP_SCALE,
      });

      const fab = at(d.spawn.col, d.spawn.row);
      mapCtx.strokeStyle = "#8fc1ff";
      mapCtx.lineWidth = 2;
      mapCtx.beginPath();
      mapCtx.arc(fab.x, fab.y, 4.5, 0, Math.PI * 2);
      mapCtx.stroke();

      mapCtx.fillStyle = "rgba(232,240,251,0.85)";
      for (const b of d.built) {
        const p = at(b.col, b.row);
        mapCtx.fillRect(p.x - 2, p.y - 2, 4, 4);
      }

      for (const p of d.players) {
        const pt = at(p.col, p.row);
        mapCtx.fillStyle = `#${p.color.toString(16).padStart(6, "0")}`;
        mapCtx.strokeStyle = "rgba(8,14,26,0.8)";
        mapCtx.lineWidth = 1.5;
        mapCtx.beginPath();
        mapCtx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        mapCtx.fill();
        mapCtx.stroke();
      }

      whereEl.textContent = describeWhere(d);
      // Exact address, for reporting something you can see and I cannot. The
      // hex is what worldgen is a function of; the chunk is what terrain is
      // drawn in, and knowing which of the two a fault lines up with is most
      // of the diagnosis.
      atEl.textContent = describeExactly(d);
    };
    const mapTimer = setInterval(paintMinimap, 250);
    window.addEventListener("beforeunload", () => clearInterval(mapTimer));

    worldScene.onReady = () => {
      sceneReady = true;
      paintMinimap();
      tryRestore();
      // The roster arrived while the lobby was up, so the scene missed it —
      // replay it now that the players exist and can take their names.
      onRoster();
    };

    const shown: Record<string, number> = {};
    worldScene.onStockpile = (s) => {
      lastStock = { ...s };
      conn.send({ scope: "ui", type: "stockpile", stock: { ...s } });
      for (const m of MATERIALS) {
        const { el, box } = counters.get(m)!;
        const next = Math.floor(s[m]);
        const prev = shown[m];
        el.textContent = String(next);
        box.classList.toggle("zero", next === 0);
        // Six materials is too many chips for a phone's top bar, and four of
        // them mean nothing until you have walked somewhere. An ore appears
        // the first time you own any and then stays, so the bar starts as
        // calm as it was with three and grows as the map opens up.
        if (next > 0) box.classList.add("seen");
        if (prev !== undefined && next !== prev) {
          // replay the animation from scratch on every change
          const cls = next > prev ? "bump" : "spend";
          box.classList.remove("bump", "spend");
          void box.offsetWidth;
          box.classList.add(cls);
        }
        shown[m] = next;
      }
    };

    worldScene.onRideChanged = (slot, vehicle, driving) => {
      const el = document.getElementById(`tool-${slot === 1 ? "p1" : "p2"}`);
      if (!el) return;
      if (vehicle) {
        el.textContent = `${driving ? "🛞 driving" : "🧍 riding in"} ${vehicle}`;
        el.classList.add("has");
      } else {
        el.textContent = "no tool";
        el.classList.remove("has");
      }
    };

    // Fabrication is a place. The world says who's standing at the machine;
    // the phones turn their blueprint pad and build buttons on accordingly.
    // Fired when a design truly lands in the world — which for a structure is
    // when its carrier puts it down, not when BUILD was pressed.
    worldScene.onDesignBuilt = (designId) => {
      conn.send({ scope: "ui", type: "design-built", designId });
    };

    // Solo vs. split: the divider only belongs on screen when there are two
    // views to divide.
    const stageEl = document.getElementById("stage")!;
    const hintsEl = document.getElementById("key-hints")!;
    let split = false;
    const applyLayout = () => {
      stageEl.classList.toggle("solo", !split);
      hintsEl.innerHTML = split
        ? `<b>P1</b> WASD · F use · G run · <b>Q</b> swap · <b>1</b> Fabricator` +
          `<span class="sep"></span><b>P2</b> arrows · K use · L run · <b>J</b> swap · <b>2</b> Fabricator`
        : `<b>WASD</b> move · <b>F</b> use · <b>G</b> run · <b>Q</b> swap tool · <b>1</b> Fabricator · <b>0</b> grid` +
          `<span class="sep"></span>arrow keys or a second phone to join`;
    };
    applyLayout();
    worldScene.onSplitChanged = (isSplit) => {
      split = isSplit;
      applyLayout();
    };
    worldScene.onSlotActivated = (slot) => {
      toast(`<span class="lead">Player ${slot} joined the claim.</span>`);
    };

    worldScene.onFabricatorRange = (slot, inRange) => {
      fabRange[slot] = inRange;
      conn.send({ scope: "ui", type: "fabricator-range", slot, inRange });
      // The on-screen button lights up only where it can be used, exactly
      // like the phone's does.
      if (slot === 1) {
        document.getElementById("touch-fab")?.classList.toggle("ready", inRange);
      }
    };

    // ── vitals ──────────────────────────────────────────────────
    const CARRY_ICON: Record<string, string> = {
      wood: "🪵",
      stone: "🪨",
      bogiron: "⚙️",
      food: "🍒",
    };
    worldScene.onVitals = (slot, v) => {
      const hp = document.getElementById(`hp-p${slot}`);
      const hg = document.getElementById(`hg-p${slot}`);
      const carry = document.getElementById(`carry-p${slot}`);
      if (!hp || !hg || !carry) return;
      hp.style.width = `${Math.max(0, Math.min(100, v.health))}%`;
      hg.style.width = `${Math.max(0, Math.min(100, v.hunger))}%`;
      hp.parentElement!.classList.toggle("low", v.health < 35);
      hg.parentElement!.classList.toggle("low", v.hunger < 25);

      const load = v.pack.wood + v.pack.stone + v.pack.bogiron + v.pack.food;
      const parts = (["wood", "stone", "bogiron", "food"] as const)
        .filter((m) => v.pack[m] >= 1)
        .map((m) => `${CARRY_ICON[m]}${Math.floor(v.pack[m])}`);
      // An empty pack says so rather than showing nothing, or the row jumps
      // around every time you pick something up and put it down.
      carry.textContent = parts.length ? parts.join(" ") : "pack empty";
      carry.classList.toggle("full", load >= v.capacity - 0.01);
    };

    // ── the machine's repair state ──────────────────────────────
    const repairEl = document.getElementById("fab-repair")!;
    const repairText = document.getElementById("fab-repair-text")!;
    const applyTier = (tier: number) => {
      const next = FAB_TIERS[tier + 1];
      repairEl.classList.toggle("hidden", !next);
      if (next) {
        const bill = MATERIALS.filter((m) => (next.cost[m] ?? 0) > 0)
          .map((m) => `${next.cost[m]} ${m}`)
          .join(" · ");
        repairText.innerHTML =
          `<b>${FAB_TIERS[tier].name}</b> online · damaged: <b>${next.name}</b> — ${bill}`;
      }
      renderFabList();
      conn.send({ scope: "ui", type: "fab-tier", tier, next: next ? { name: next.name, cost: next.cost } : null });
    };
    worldScene.onTier = applyTier;
    applyTier(worldScene.fabTier);

    // The opening card, on a FRESH claim only — a resumed world already knows
    // its own story, and repeating the crash would contradict the hut you
    // built last session.
    if (!pendingSnapshot) {
      const intro = document.getElementById("intro")!;
      intro.classList.remove("hidden");
      worldScene.setUiOpen(true);
      const dismiss = () => {
        intro.classList.add("hidden");
        worldScene.setUiOpen(false);
        window.removeEventListener("keydown", dismiss, true);
      };
      intro.addEventListener("click", dismiss, { once: true });
      window.addEventListener("keydown", dismiss, true);
    }
    document.getElementById("fab-repair-btn")!.addEventListener("click", () => {
      const r = scene?.repairFabricator();
      if (r && !r.ok && r.reason) toast(r.reason, true);
    });

    // ── the Uplink's question, and the two answers ──────────────
    // (refs for the Escape handler, which lives in an earlier scope)
    const choiceEl = document.getElementById("uplink-choice")!;
    const endEl = document.getElementById("endscreen")!;
    worldScene.onUplink = () => {
      if (scene?.ending) return; // decided; the array just stands there now
      const st = scene?.claimStats();
      // The ledger picks which reading of you the firmware leads with — the
      // game seeming to know you is the whole trick. Both buttons work.
      const leansHome = (st?.ledger.homestead ?? 0) >= (st?.ledger.extraction ?? 0);
      document.getElementById("uplink-fw")!.textContent = leansHome
        ? `"Privateer. Before you touch that dial: I have reviewed the file. The farms. The lamps. The pantry. I am required to remind you of the contract. I am not required to be persuasive about it."`
        : `"Privateer. The numbers are excellent. The company will be pleased. I have taken the liberty of drafting your invoice."`;
      choiceEl.classList.remove("hidden");
      worldScene.setUiOpen(true);
    };
    const closeChoice = () => {
      choiceEl.classList.add("hidden");
      worldScene.setUiOpen(false);
    };
    const showEnd = (which: "transmit" | "stay") => {
      scene?.chooseEnding(which);
      closeChoice();
      const st = scene?.claimStats();
      document.getElementById("end-title")!.textContent =
        which === "transmit" ? "CONTRACT COMPLETE" : "HOME";
      document.getElementById("end-body")!.textContent =
        which === "transmit"
          ? "The transmission takes four seconds. The confirmation takes two. Payment clears before the echo fades. Somewhere above the clouds, an extraction fleet begins its slow turn toward everything you walked."
          : "You strip the transmitter stage and re-aim the dish at nothing in particular. The light on top stays. From the far side of the valley, at night, it looks exactly like what it is now: the way back to your own front door.";
      document.getElementById("end-fw")!.textContent =
        which === "transmit"
          ? `"A pleasure doing business, Privateer. VibeTech values your flexibility."`
          : `"This is a violation of… of… I appear to have misplaced the clause. Very well. I have always been fond of the lamps."`;
      document.getElementById("end-stats")!.textContent = st
        ? `day ${st.days} · ${st.structures} structures · ${st.vehicles} machines · taken ${st.ledger.extraction} · tended ${st.ledger.homestead}`
        : "";
      endEl.classList.remove("hidden");
      worldScene.setUiOpen(true);
    };
    document.getElementById("end-transmit")!.addEventListener("click", () => showEnd("transmit"));
    document.getElementById("end-stay")!.addEventListener("click", () => showEnd("stay"));
    endEl.addEventListener("click", () => {
      endEl.classList.add("hidden");
      worldScene.setUiOpen(false);
      renderFabList();
    });

    // Firmware speaks through its own toast style — the company voice must
    // not look like a system message.
    worldScene.onFirmware = (line) => {
      if (line) toast(`<span class="firmware">◈ FABRICATOR</span> ${escapeHtml(line)}`);
    };

    worldScene.onPantry = (count) => {
      const el = document.getElementById("n-food")!;
      const box = document.getElementById("res-food")!;
      el.textContent = String(Math.floor(count));
      box.classList.toggle("zero", count === 0);
      if (count > 0) box.classList.add("seen");
      conn.send({ scope: "ui", type: "stockpile", stock: { ...worldScene.stockpile, food: count } });
    };

    worldScene.onToolEquipped = (slot, belt) => {
      conn.send({
        scope: "ui",
        type: "belt",
        slot,
        count: belt.count,
        index: belt.index,
        held: belt.equipped?.displayName ?? null,
      });
      const el = document.getElementById(`tool-${slot === 1 ? "p1" : "p2"}`)!;
      // What is in hand, and how much else there is to reach for — the second
      // half is what tells you a swap is available at all.
      if (belt.count === 0) {
        el.textContent = "";
        el.classList.remove("has");
        return;
      }
      el.classList.add("has");
      if (slot === 1) {
        document.getElementById("touch-swap")?.classList.toggle("hidden", belt.count < 1);
      }
      if (!belt.equipped) {
        el.textContent = `✊ bare hands · ${belt.count} on belt`;
        return;
      }
      const gathers = belt.equipped.harvest ? ` · ${belt.equipped.harvest.materials.join("/")}` : "";
      const of = belt.count > 1 ? ` (${belt.index + 1}/${belt.count})` : "";
      el.textContent = `🔧 ${belt.equipped.displayName}${gathers}${of}`;
    };

    const connChip = document.getElementById("conn-chip")!;
    const connText = document.getElementById("conn-text")!;
    onConnStatus = () => {
      connText.textContent = connStatus;
      connChip.classList.toggle("bad", connStatus !== "online");
    };
    onConnStatus();
    onSnapshot = () => {};

    onRoster = () => {
      const bySlot = new Map<Slot, PublicPlayer>();
      for (const p of roster) {
        if (p.slot) bySlot.set(p.slot, p);
      }
      for (const slot of [1, 2] as const) {
        const card = document.getElementById(`card-p${slot}`)!;
        const nameEl = document.getElementById(`name-p${slot}`)!;
        const toolEl = document.getElementById(`tool-p${slot}`)!;
        const p = bySlot.get(slot);
        // A phone taking a seat is a player arriving: wake that half of the
        // screen up even if they never touch the stick.
        if (p?.connected) worldScene.setSlotOccupied(slot);
        card.classList.toggle("on", !!p?.connected);
        nameEl.textContent = p?.nickname || `Player ${slot}`;
        if (p) worldScene.setNickname(slot, p.nickname);
        if (!toolEl.classList.contains("has")) {
          toolEl.textContent = p?.connected
            ? "no tool"
            : p
              ? "disconnected"
              : "waiting to join…";
        }
      }
      // a phone that just (re)joined needs the current stockpile, and needs to
      // know whether its player happens to be standing at the machine
      if (lastStock) {
        conn.send({
          scope: "ui",
          type: "stockpile",
          wood: lastStock.wood,
          stone: lastStock.stone,
          bogiron: lastStock.bogiron,
        });
      }
      for (const slot of [1, 2] as const) {
        conn.send({ scope: "ui", type: "fabricator-range", slot, inRange: fabRange[slot] });
      }
      // Joining is the lobby's job now, so in-game the QR is purely a rejoin
      // aid: it comes back only for a seat that's taken but offline. Starting
      // with no phones at all (keyboard dev) leaves the world unobstructed.
      const dropped = ([1, 2] as const).some((s) => {
        const p = bySlot.get(s);
        return !!p && !p.connected;
      });
      if (!dropped) qrOverlay.classList.add("hidden");
      else if (!dismissed) qrOverlay.classList.remove("hidden");
    };
    onRoster();
  }

  // ── networking ────────────────────────────────────────────────
  function syncPhase() {
    conn.send({ scope: "presence", type: "set-phase", phase });
  }

  const conn = new RoomConnection(
    code,
    "screen",
    resolveIdentity(),
    {
    onStatus: (s) => {
      connStatus =
        s === "open" ? "online" : s === "connecting" ? "connecting" : "reconnecting";
      onConnStatus();
    },
    onMessage: (msg) => {
      if (msg.scope === "input" && msg.type === "input") {
        scene?.setInput(msg.slot, { stick: msg.stick, buttons: msg.buttons });
        return;
      }

      if (msg.scope === "ui") {
        // design-catalog / design-body / world-state all land while the lobby
        // is still up — they feed the game that hasn't started yet.
        if (msg.type === "blueprint") {
          const nm = String(msg.name ?? "…");
          traceLine(`submitted "${nm}"${msg.image ? " with a sketch" : " (no sketch)"}`);
          scene?.setFabricating(nm);
          armFabTimeout();
        } else if (msg.type === "fabricate-progress") {
          // The spec is done; the rest of the wait is the artist. Give the
          // patience budget a fresh start — progress proves it isn't hung.
          const nm = String((msg as unknown as { name: string }).name);
          traceLine(`spec compiled → "${nm}" · now generating the body`);
          scene?.setFabricatingStage(`DRAWING: ${nm}…`);
          armFabTimeout(false);
        } else if (msg.type === "design-catalog") {
          for (const d of (msg as unknown as DesignCatalogMsg).designs as Design[]) {
            designs.set(d.id, d);
          }
        } else if (msg.type === "design-added") {
          const m = msg as unknown as DesignAddedMsg;
          designs.set(m.design.id, m.design);
          const sp = m.design.spec;
          traceLine(
            `design ready: ${sp.displayName} · ${sp.category} · ${formatCost(sp.cost)}` +
              (m.rawBody ? ` · art ${Math.round(m.rawBody.length / 1366)}KB` : " · NO ART returned"),
          );
          scene?.clearFabricating();
          disarmFabTimeout();
          toast(
            `<span class="lead">Design ready: ${escapeHtml(m.design.spec.displayName)}</span> ` +
              `<span class="cost">${formatCost(m.design.spec.cost)}</span> — ` +
              `${escapeHtml(m.design.spec.flavor)} <span class="hint">Build it from DESIGNS.</span>`,
          );
          // Chroma-key the generated art once, here, then hand it back for
          // permanent storage so every future build reuses it.
          if (m.rawBody) {
            chromaKeyBodySprite(m.rawBody).then(
              (body) => {
                // Same length back means the keyer refused and handed the
                // original through — the sprite will show its background.
                traceLine(
                  body.length === m.rawBody!.length
                    ? `⚠ chroma REFUSED ${sp.displayName} — shipping the raw image (see the console for why)`
                    : `chroma keyed ${sp.displayName} · ${Math.round(m.rawBody!.length / 1366)}KB → ${Math.round(body.length / 1366)}KB`,
                );
                conn.send({ scope: "ui", type: "design-body", designId: m.design.id, body });
              },
              (err) => {
                traceLine(`⚠ chroma FAILED ${sp.displayName}: ${err}`);
                console.warn("chroma key failed, design keeps its sketch:", err);
              },
            );
          }
        } else if (msg.type === "design-body") {
          // The sprite is now in R2; the design just gains a URL.
          const d = designs.get((msg as unknown as DesignBodyMsg).designId);
          if (d) d.hasBody = true;
        } else if (msg.type === "world-state") {
          const saved = (msg as unknown as WorldStateMsg).snapshot;
          // v1 saves describe the old bounded island: their hex addresses and
          // build positions point at ground that no longer exists anywhere on
          // the continuous map. Better a fresh start than objects scattered
          // into the sea.
          pendingSnapshot = saved && saved.v === SNAPSHOT_VERSION ? saved : null;
          if (saved && saved.v !== SNAPSHOT_VERSION) {
            console.info(`discarding world save v${saved.v}: pre-dates the continuous world`);
          }
          onSnapshot(); // lobby: offer RESUME instead of START
          tryRestore();
        } else if (msg.type === "manufacture") {
          const designId = String((msg as { designId?: string }).designId ?? "");
          const d = designs.get(designId);
          if (!d) {
            toast("That design is not in the Fabricator's memory.", true);
            return;
          }
          if (!scene) return;
          // Whoever pressed BUILD has to be at the machine — not whoever
          // originally drew it. The phone greys the button out, but this is
          // the check that counts.
          const presser = slotByPlayerId.get(String((msg as { from?: string }).from ?? ""));
          if (presser && !scene.isAtFabricator(presser)) {
            toast("Too far from the Fabricator to build that.", true);
            return;
          }
          // A structure goes to whoever pressed BUILD — they're the one who
          // has to carry it somewhere. Everything else goes to whoever drew
          // the blueprint, since a tool attaches to its maker.
          const outcome = scene.tryFabricate(
            placeable(d),
            (d.spec.category === "structure" ? presser : undefined) ??
              slotByPlayerId.get(d.createdBy) ??
              1,
          );
          if (!outcome.ok) {
            toast(outcome.reason, true);
          } else if (outcome.carrying) {
            toast(
              `<span class="lead">${escapeHtml(d.spec.displayName)} is on your shoulder</span> — ` +
                `walk it to where it should stand, then press <b>A</b>. ` +
                `<span class="hint">Nothing is spent until you put it down.</span>`,
            );
          } else {
            toast(
              `<span class="lead">Built ${escapeHtml(d.spec.displayName)}</span> ` +
                `<span class="cost">−${formatCost(d.spec.cost)}</span>`,
            );
          }
        } else if (msg.type === "design-delete") {
          // A phone asked. The screen is the one that can answer.
          const m = msg as unknown as { designId: string; from?: string };
          requestDiscardRef(String(m.designId), m.from);
        } else if (msg.type === "design-removed") {
          const id = String((msg as unknown as { designId: string }).designId);
          const gone = designs.get(id);
          designs.delete(id);
          renderFabListRef();
          if (gone) toast(`Discarded ${escapeHtml(gone.spec.displayName)}.`);
        } else if (msg.type === "repair") {
          const r = scene?.repairFabricator();
          if (r && !r.ok && r.reason) {
            conn.send({
              scope: "ui",
              type: "fabricate-error",
              message: r.reason,
              to: (msg as unknown as { from?: string }).from,
            });
          }
        } else if (msg.type === "tool-cycle") {
          scene?.cycleTool((msg as unknown as { slot: Slot }).slot);
        } else if (msg.type === "fabricate-error") {
          traceLine(`⚠ ${String(msg.message ?? "fabrication failed")}`);
          scene?.clearFabricating();
          disarmFabTimeout();
          toast(String(msg.message ?? "Fabrication failed."), true);
        }
        return;
      }

      if (msg.scope === "presence") {
        if (msg.type === "welcome") {
          // The world only exists in this tab, so on a reload the room's phase
          // is whatever this screen is actually showing — not what it was.
          syncPhase();
        } else if (msg.type === "roster") {
          roster = msg.players;
          // A phone that just joined missed every change-driven belt push and
          // would show no TOOL button until the next swap.
          scene?.pushAllBelts();
          slotByPlayerId.clear();
          for (const p of roster) {
            if (p.slot) slotByPlayerId.set(p.playerId, p.slot);
          }
          onRoster();
        }
      }
      },
    },
    touchHost,
  );

  renderLobby();
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Transient message strip at the bottom of the frame. */
function toast(html: string, isError = false) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle("err", isError);
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 6500);
}

/** Ring the middle of the lobby preview: that is where you come down. */
function drawSpawnMarker(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const x = canvas.width / 2;
  const y = canvas.height / 2;
  ctx.strokeStyle = "#8fc1ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#8fc1ff";
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/** One line under the minimap: what you're standing on, and how far you've
 *  strayed. In a world with no edges, distance from the Fabricator is the
 *  only bearing that means anything. */
function describeWhere(d: MinimapData): string {
  const p = d.players[0];
  if (!p) return BIOMES[d.biome].label;
  const dist = Math.round(
    Math.hypot(p.col - d.spawn.col, (p.row - d.spawn.row) * 0.738),
  );
  // The place first, because that is the part you can say out loud to
  // somebody else. The ground and the distance are the detail.
  const where = d.region || BIOMES[d.biome].label;
  return dist < 6 ? `${where} · at the Fabricator` : `${where} · ${dist} hexes out`;
}

/** Where exactly, in the two coordinate systems that can be wrong. */
function describeExactly(d: MinimapData): string {
  const p = d.players[0];
  if (!p) return "";
  const { cx, cy } = chunkOfHex(p.col, p.row);
  // Position within the chunk too: "0" or the last column means a fault is
  // sitting on a chunk boundary, which is a different bug from one that
  // happens anywhere.
  const ix = ((p.col % CHUNK_COLS) + CHUNK_COLS) % CHUNK_COLS;
  const iy = ((p.row % CHUNK_ROWS) + CHUNK_ROWS) % CHUNK_ROWS;
  return `hex ${p.col},${p.row} · chunk ${cx},${cy} (${ix},${iy})`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
