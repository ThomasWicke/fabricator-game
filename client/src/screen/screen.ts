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
import { formatCost } from "../../../shared/fabricator/cost";
import { resolveIdentity } from "../identity";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import { WorldScene, type PlaceableDesign } from "./world";
import { chromaKeyBodySprite } from "./chroma";
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
import type { MaterialType } from "../../../shared/fabricator/schema";

const ICONS: Record<MaterialType, string> = {
  wood: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1" y="5" width="11.5" height="7" rx="3.2" fill="#8a6a48"/><ellipse cx="12.4" cy="8.5" rx="2.5" ry="3.5" fill="#a8845e"/><ellipse cx="12.4" cy="8.5" rx="1.1" ry="1.7" fill="#6d5236"/></svg>`,
  stone: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 12.5 L4 5.2 L8 3 L13.2 6.2 L14 12.5 Z" fill="#98a0ab"/><path d="M4 5.2 L8 3 L11.2 5.1 L6.2 7 Z" fill="#c2c9d3"/></svg>`,
  bogiron: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 12.5 L4 5.2 L8 3 L13.2 6.2 L14 12.5 Z" fill="#463b32"/><circle cx="6" cy="8.2" r="1.4" fill="#d9813f"/><circle cx="10.2" cy="7" r="1.1" fill="#e8a468"/><circle cx="9" cy="10.6" r="1" fill="#c97b3d"/></svg>`,
};

const MATERIALS: MaterialType[] = ["wood", "stone", "bogiron"];

export function startScreen(code: string) {
  const upperCode = code.toUpperCase();
  const controllerUrl = `${window.location.origin}/c/${code}`;

  const resourceMarkup = MATERIALS.map(
    (m) =>
      `<div class="res" id="res-${m}" title="${m}">${ICONS[m]}<span class="n" id="n-${m}">0</span></div>`,
  ).join("");

  const app = document.getElementById("app")!;

  // ── state that outlives the view switch ─────────────────────
  // The design catalog and the saved world both arrive right after connecting,
  // while the lobby is still up, and have to survive into the game.
  const designs = new Map<string, Design>();
  // playerId → slot, from roster broadcasts (routes fabricated tools to
  // whoever drew the blueprint).
  const slotByPlayerId = new Map<string, Slot>();
  let lastStock: Record<MaterialType, number> | null = null;
  let pendingSnapshot: WorldSnapshot | null | undefined;
  let roster: PublicPlayer[] = [];
  let phase: Phase = "lobby";
  let scene: WorldScene | null = null;
  let connStatus = "connecting";

  // Per-view hooks, replaced on every render.
  let onRoster: () => void = () => {};
  let onConnStatus: () => void = () => {};
  let onSnapshot: () => void = () => {};
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
      <div class="lobby">
        <header class="lobby-head">
          <span class="brand">UNIVERSAL FABRICATOR</span>
          <span class="spacer"></span>
          <span class="hint" id="conn-status">${connStatus}</span>
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
            <div class="panel-title"><span class="step">2</span> The world</div>
            <div class="lobby-note" id="world-note">Checking for a saved world…</div>
          </section>
        </div>

        <footer class="lobby-foot">
          <span class="hint" id="start-hint"></span>
          <span class="spacer"></span>
          <button class="primary" id="start-btn">START EXPEDITION</button>
        </footer>
      </div>
    `;

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
    const startHint = document.getElementById("start-hint")!;
    const startBtn = document.getElementById("start-btn") as HTMLButtonElement;

    onSnapshot = () => {
      if (pendingSnapshot === undefined) return; // still waiting on the server
      if (!pendingSnapshot) {
        noteEl.innerHTML =
          "<b>A fresh world.</b> Terrain is generated from the room code, so " +
          "this room always lands on the same map — start a room with a " +
          "different code for different ground.";
        startBtn.textContent = "START EXPEDITION";
        return;
      }
      const snap = pendingSnapshot;
      const stock = snap.stockpile;
      noteEl.innerHTML =
        `<b>Saved world found.</b> ${snap.built.length} object` +
        `${snap.built.length === 1 ? "" : "s"} built, ` +
        `${snap.harvested.length} resource node` +
        `${snap.harvested.length === 1 ? "" : "s"} worked, ` +
        `stockpile ${Math.floor(stock.wood)} wood · ${Math.floor(stock.stone)} stone · ` +
        `${Math.floor(stock.bogiron)} bogiron. Resuming picks up where you left off.`;
      startBtn.textContent = "RESUME EXPEDITION";
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
      app.innerHTML = `
      <div class="screen">
        <div class="screen-stage" id="stage">
          <div class="split-divider"></div>

          <div class="hud">
            <div class="hud-top">
              <div class="player-card p1 glass" id="card-p1">
                <span class="dot"></span>
                <span class="who">
                  <span class="name" id="name-p1">Player 1</span>
                  <span class="tool" id="tool-p1">waiting to join…</span>
                </span>
              </div>

              <div class="resources glass">${resourceMarkup}</div>

              <div class="player-card p2 glass" id="card-p2">
                <span class="dot"></span>
                <span class="who">
                  <span class="name" id="name-p2">Player 2</span>
                  <span class="tool" id="tool-p2">waiting to join…</span>
                </span>
              </div>
            </div>

            <div class="hud-bottom">
              <div class="chip-mini glass">ROOM ${upperCode}</div>
              <div class="toast glass" id="toast"></div>
              <div class="chip-mini glass" id="conn-chip"><span class="dot"></span><span id="conn-text">connecting</span></div>
            </div>
          </div>

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
            g.scene.add("world", worldScene, true, { seed: code });
          },
        },
      });
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

    worldScene.onReady = () => {
      sceneReady = true;
      tryRestore();
      // The roster arrived while the lobby was up, so the scene missed it —
      // replay it now that the players exist and can take their names.
      onRoster();
    };

    const shown: Record<string, number> = {};
    worldScene.onStockpile = (s) => {
      lastStock = { ...s };
      conn.send({ scope: "ui", type: "stockpile", wood: s.wood, stone: s.stone, bogiron: s.bogiron });
      for (const m of MATERIALS) {
        const { el, box } = counters.get(m)!;
        const next = Math.floor(s[m]);
        const prev = shown[m];
        el.textContent = String(next);
        box.classList.toggle("zero", next === 0);
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

    worldScene.onToolEquipped = (slot, spec) => {
      const el = document.getElementById(`tool-${slot === 1 ? "p1" : "p2"}`)!;
      const gathers = spec.harvest ? ` · ${spec.harvest.materials.join("/")}` : "";
      el.textContent = `🔧 ${spec.displayName}${gathers}`;
      el.classList.add("has");
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
      // a phone that just (re)joined needs the current stockpile
      if (lastStock) {
        conn.send({
          scope: "ui",
          type: "stockpile",
          wood: lastStock.wood,
          stone: lastStock.stone,
          bogiron: lastStock.bogiron,
        });
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

  const conn = new RoomConnection(code, "screen", resolveIdentity(), {
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
          scene?.setFabricating(String(msg.name ?? "…"));
        } else if (msg.type === "design-catalog") {
          for (const d of (msg as unknown as DesignCatalogMsg).designs as Design[]) {
            designs.set(d.id, d);
          }
        } else if (msg.type === "design-added") {
          const m = msg as unknown as DesignAddedMsg;
          designs.set(m.design.id, m.design);
          scene?.clearFabricating();
          toast(
            `<span class="lead">Design ready: ${escapeHtml(m.design.spec.displayName)}</span> ` +
              `<span class="cost">${formatCost(m.design.spec.cost)}</span> — ` +
              `${escapeHtml(m.design.spec.flavor)} <span class="hint">Build it from DESIGNS.</span>`,
          );
          // Chroma-key the generated art once, here, then hand it back for
          // permanent storage so every future build reuses it.
          if (m.rawBody) {
            chromaKeyBodySprite(m.rawBody).then(
              (body) =>
                conn.send({ scope: "ui", type: "design-body", designId: m.design.id, body }),
              (err) => console.warn("chroma key failed, design keeps its sketch:", err),
            );
          }
        } else if (msg.type === "design-body") {
          // The sprite is now in R2; the design just gains a URL.
          const d = designs.get((msg as unknown as DesignBodyMsg).designId);
          if (d) d.hasBody = true;
        } else if (msg.type === "world-state") {
          pendingSnapshot = (msg as unknown as WorldStateMsg).snapshot;
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
          const slot = slotByPlayerId.get(d.createdBy) ?? 1;
          const rejection = scene.tryFabricate(placeable(d), slot);
          if (rejection) {
            toast(rejection, true);
          } else {
            conn.send({ scope: "ui", type: "design-built", designId });
            toast(
              `<span class="lead">Built ${escapeHtml(d.spec.displayName)}</span> ` +
                `<span class="cost">−${formatCost(d.spec.cost)}</span>`,
            );
          }
        } else if (msg.type === "fabricate-error") {
          scene?.clearFabricating();
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
          slotByPlayerId.clear();
          for (const p of roster) {
            if (p.slot) slotByPlayerId.set(p.playerId, p.slot);
          }
          onRoster();
        }
      }
    },
  });

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

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
