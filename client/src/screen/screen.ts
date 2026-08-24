// Shared-screen shell. Two views on one connection:
//
//   lobby   — join QR + code, who's in, and the world-generation settings
//             with a live minimap preview of the world about to be created.
//   playing — the Phaser world, fed by relayed controller inputs.
//
// The screen owns the phase: phones follow whatever it announces, so a phone
// that joins late or reconnects lands on the right UI.

import Phaser from "phaser";
import QRCode from "qrcode";
import { resolveIdentity } from "../identity";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import { WorldScene } from "./world";
import {
  drawWorldPreview,
  generateWorld,
  loadSettings,
  randomSeed,
  saveSettings,
  SIZE_TILES,
  terrainMix,
  type WorldSettings,
} from "./worldgen";
import type { Phase, PublicPlayer, Slot } from "../../../party/protocol";

type Option<T extends string> = { value: T; label: string };

const SIZE_OPTS: Option<WorldSettings["size"]>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];
const AMOUNT_OPTS: Option<WorldSettings["swamp"]>[] = [
  { value: "none", label: "None" },
  { value: "some", label: "Some" },
  { value: "lots", label: "Lots" },
];
const SCATTER_OPTS: Option<WorldSettings["scatter"]>[] = [
  { value: "sparse", label: "Sparse" },
  { value: "normal", label: "Normal" },
  { value: "dense", label: "Dense" },
];

export function startScreen(code: string) {
  const upperCode = code.toUpperCase();
  const controllerUrl = `${window.location.origin}/c/${code}`;
  const app = document.getElementById("app")!;

  let phase: Phase = "lobby";
  let roster: PublicPlayer[] = [];
  let settings: WorldSettings = loadSettings(upperCode);
  let onRoster: (players: PublicPlayer[]) => void = () => {};
  let connStatus = "connecting…";
  let setConnStatus: (text: string) => void = () => {};

  keepScreenAwake();

  // ── lobby ─────────────────────────────────────────────────────
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
            <div class="panel-title"><span class="step">2</span> Shape the world</div>
            <div class="preview-row">
              <div class="preview-frame">
                <canvas id="world-preview" width="320" height="320"></canvas>
              </div>
              <div class="preview-meta" id="world-meta"></div>
            </div>
            <div class="settings" id="settings"></div>
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
    setConnStatus = (text) => {
      statusEl.textContent = text;
    };

    QRCode.toCanvas(
      document.getElementById("qr-canvas") as HTMLCanvasElement,
      controllerUrl,
      { width: 190, margin: 1 },
    ).catch(() => {});

    // ── world settings ──────────────────────────────────────────
    const settingsEl = document.getElementById("settings")!;
    settingsEl.innerHTML = `
      <div class="setting seed">
        <label for="seed-input">Seed</label>
        <div class="seed-row">
          <input id="seed-input" type="text" maxlength="24" autocomplete="off"
                 spellcheck="false" value="${escapeAttr(settings.seed)}" />
          <button id="seed-reroll" title="Random seed">⟳ Reroll</button>
        </div>
      </div>
      ${segmented("size", "World size", SIZE_OPTS, settings.size)}
      ${segmented("swamp", "Swamp", AMOUNT_OPTS, settings.swamp)}
      ${segmented("shore", "Sand shore", AMOUNT_OPTS, settings.shore)}
      ${segmented("scatter", "Trees & rocks", SCATTER_OPTS, settings.scatter)}
    `;

    const previewCanvas = document.getElementById("world-preview") as HTMLCanvasElement;
    const metaEl = document.getElementById("world-meta")!;
    const refreshPreview = () => {
      const world = generateWorld(settings);
      drawWorldPreview(previewCanvas, world);
      const mix = terrainMix(world);
      const tiles = SIZE_TILES[settings.size];
      metaEl.innerHTML = `
        <div class="meta-line"><b>${tiles}×${tiles}</b> tiles</div>
        ${mixRow("grass", "Grass", mix.grass)}
        ${mixRow("sand", "Sand", mix.sand)}
        ${mixRow("swamp", "Swamp", mix.swamp)}
        <div class="meta-note">${world.scatter.length} trees &amp; rocks</div>
      `;
    };

    const seedInput = document.getElementById("seed-input") as HTMLInputElement;
    seedInput.addEventListener("input", () => {
      settings = { ...settings, seed: seedInput.value };
      saveSettings(settings);
      refreshPreview();
    });
    document.getElementById("seed-reroll")!.addEventListener("click", () => {
      seedInput.value = randomSeed();
      settings = { ...settings, seed: seedInput.value };
      saveSettings(settings);
      refreshPreview();
    });

    settingsEl.querySelectorAll<HTMLButtonElement>("button[data-key]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key as keyof WorldSettings;
        settings = { ...settings, [key]: btn.dataset.value } as WorldSettings;
        saveSettings(settings);
        for (const sib of settingsEl.querySelectorAll(`button[data-key="${key}"]`)) {
          sib.classList.toggle("on", sib === btn);
        }
        refreshPreview();
      });
    });

    refreshPreview();

    // ── roster ──────────────────────────────────────────────────
    const slotsEl = document.getElementById("slots")!;
    const spectatorsEl = document.getElementById("spectators")!;
    const startHint = document.getElementById("start-hint")!;
    const startBtn = document.getElementById("start-btn") as HTMLButtonElement;

    onRoster = (players) => {
      const bySlot = new Map<Slot, PublicPlayer>();
      for (const p of players) {
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

      const spectators = players.filter((p) => p.slot === null && p.connected).length;
      spectatorsEl.textContent = spectators
        ? `${spectators} more phone${spectators > 1 ? "s" : ""} connected — this build seats two.`
        : "";

      const active = players.filter((p) => p.slot !== null && p.connected);
      const readyCount = active.filter((p) => p.ready).length;
      const allReady = active.length > 0 && readyCount === active.length;
      startHint.textContent = !active.length
        ? "No phones yet — you can still start and play with the keyboard (P1 WASD+F/G · P2 arrows+K/L)."
        : allReady
          ? `${active.length === 2 ? "Both players" : "Player"} ready — press START (or hit Enter).`
          : `${readyCount}/${active.length} ready.`;
      startBtn.classList.toggle("pulse", allReady);
    };
    onRoster(roster);

    startBtn.addEventListener("click", () => startGame());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement) return; // let the seed field keep Enter
      startGame();
    };
    window.addEventListener("keydown", onKey);
    lobbyKeyHandler = onKey;

    syncPhase();
  }

  let lobbyKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  // ── playing ───────────────────────────────────────────────────
  let game: Phaser.Game | null = null;
  let stageObserver: ResizeObserver | null = null;
  let scene: WorldScene | null = null;

  function startGame() {
    if (lobbyKeyHandler) {
      window.removeEventListener("keydown", lobbyKeyHandler);
      lobbyKeyHandler = null;
    }
    phase = "playing";
    const worldSettings = settings;

    app.innerHTML = `
      <div class="screen">
        <div class="screen-stage" id="stage">
          <div class="split-divider"></div>
        </div>
        <div class="screen-hud">
          <span class="code">ROOM ${upperCode}</span>
          <span class="chip p1" id="chip-p1"><span class="dot"></span><span id="chip-p1-text">P1</span></span>
          <span class="chip p2" id="chip-p2"><span class="dot"></span><span id="chip-p2-text">P2</span></span>
          <span class="hint" id="rejoin-note"></span>
          <span class="spacer"></span>
          <span class="hint">seed <b>${escapeHtml(worldSettings.seed || "—")}</b></span>
          <button class="hud-btn" id="back-to-lobby">⟵ Lobby</button>
          <span class="hint" id="conn-status">${connStatus}</span>
        </div>
      </div>
    `;

    const statusEl = document.getElementById("conn-status")!;
    setConnStatus = (text) => {
      statusEl.textContent = text;
    };
    const rejoinNote = document.getElementById("rejoin-note")!;

    document.getElementById("back-to-lobby")!.addEventListener("click", () => {
      teardownGame();
      renderLobby();
    });

    // Boot only once the stage has settled to a real size (flex layout can
    // still be 0×N when this module runs, which breaks WebGL framebuffers),
    // then track the stage with a ResizeObserver — window-resize events alone
    // don't cover in-page layout changes (e.g. inside the test-harness iframe).
    const worldScene = new WorldScene();
    scene = worldScene;
    const stage = document.getElementById("stage")!;
    const boot = () => {
      if (phase !== "playing") return;
      if (stage.clientWidth === 0 || stage.clientHeight === 0) {
        requestAnimationFrame(boot);
        return;
      }
      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: stage,
        backgroundColor: "#20361f",
        scale: {
          mode: Phaser.Scale.NONE,
          width: stage.clientWidth,
          height: stage.clientHeight,
        },
        physics: {
          default: "arcade",
          arcade: { debug: false },
        },
        scene: [],
        callbacks: {
          postBoot: (g) => {
            g.scene.add("world", worldScene, true, { settings: worldSettings });
          },
        },
      });
      stageObserver = new ResizeObserver(() => {
        if (stage.clientWidth && stage.clientHeight) {
          game?.scale.resize(stage.clientWidth, stage.clientHeight);
        }
      });
      stageObserver.observe(stage);
    };
    boot();

    onRoster = (players) => {
      const bySlot = new Map<Slot, PublicPlayer>();
      for (const p of players) {
        if (p.slot) bySlot.set(p.slot, p);
      }
      const missing: string[] = [];
      for (const slot of [1, 2] as const) {
        const chip = document.getElementById(`chip-p${slot}`)!;
        const text = document.getElementById(`chip-p${slot}-text`)!;
        const p = bySlot.get(slot);
        const name = p?.nickname || `P${slot}`;
        if (p?.connected) {
          chip.classList.add("on");
          text.textContent = name;
          worldScene.setNickname(slot, p.nickname);
        } else {
          chip.classList.remove("on");
          text.textContent = p ? `${name} — offline` : `P${slot} — open`;
          missing.push(p ? name : `P${slot}`);
        }
      }
      rejoinNote.textContent = missing.length
        ? `${missing.join(" & ")} can (re)join at ${controllerUrl}`
        : "";
    };
    onRoster(roster);

    syncPhase();
  }

  function teardownGame() {
    stageObserver?.disconnect();
    stageObserver = null;
    game?.destroy(true);
    game = null;
    scene = null;
    onRoster = () => {};
  }

  // ── networking ────────────────────────────────────────────────
  function syncPhase() {
    conn.send({ scope: "presence", type: "set-phase", phase });
  }

  const conn = new RoomConnection(code, "screen", resolveIdentity(), {
    onStatus: (s) => {
      connStatus =
        s === "open" ? "online" : s === "connecting" ? "connecting…" : "reconnecting…";
      setConnStatus(connStatus);
    },
    onMessage: (msg) => {
      if (msg.scope === "input" && msg.type === "input") {
        scene?.setInput(msg.slot, { stick: msg.stick, buttons: msg.buttons });
        return;
      }
      if (msg.scope === "ui") {
        if (!scene) return;
        if (msg.type === "blueprint") {
          scene.setFabricating(String(msg.name ?? "…"));
        } else if (msg.type === "fabricated") {
          const m = msg as unknown as import("../../../party/protocol").FabricatedMsg;
          scene.spawnFabricated(m.spec, m.image);
          toast(`Fabricated: ${m.spec.displayName} (cost ${m.spec.cost}) — ${m.spec.flavor}`);
        } else if (msg.type === "fabricate-error") {
          scene.clearFabricating();
          toast(String(msg.message ?? "Fabrication failed."));
        }
        return;
      }
      if (msg.scope === "presence") {
        if (msg.type === "welcome") {
          // The world only exists in this tab; on reconnect (or a reload
          // mid-game) tell the server what's actually on screen.
          syncPhase();
        } else if (msg.type === "roster") {
          roster = msg.players;
          onRoster(roster);
        }
      }
    },
  });

  renderLobby();
}

// ── small view helpers ────────────────────────────────────────────

function segmented<T extends string>(
  key: string,
  label: string,
  opts: Option<T>[],
  current: T,
): string {
  return `
    <div class="setting">
      <label>${label}</label>
      <div class="segmented">
        ${opts
          .map(
            (o) =>
              `<button data-key="${key}" data-value="${o.value}"${
                o.value === current ? ' class="on"' : ""
              }>${o.label}</button>`,
          )
          .join("")}
      </div>
    </div>
  `;
}

function mixRow(terrain: string, label: string, fraction: number): string {
  const pct = Math.round(fraction * 100);
  return `
    <div class="mix-row">
      <span class="swatch ${terrain}"></span>
      <span class="mix-label">${label}</span>
      <span class="mix-bar"><span style="width:${pct}%"></span></span>
      <span class="mix-pct">${pct}%</span>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const escapeAttr = escapeHtml;

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Transient message strip over the game (fabrication results/errors). */
function toast(text: string) {
  const stage = document.getElementById("stage");
  if (!stage) return;
  let el = document.getElementById("screen-toast");
  if (!el || !stage.contains(el)) {
    el = document.createElement("div");
    el.id = "screen-toast";
    el.style.cssText =
      "position:absolute;left:50%;bottom:14px;transform:translateX(-50%);" +
      "background:rgba(10,14,20,0.9);color:#dfe8f4;padding:8px 16px;" +
      "border-radius:10px;font-size:13px;z-index:20;max-width:80%;text-align:center;";
    stage.appendChild(el);
  }
  el.textContent = text;
  el.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el!.style.display = "none";
  }, 6000);
}
