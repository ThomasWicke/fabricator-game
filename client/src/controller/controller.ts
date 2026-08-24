// Phone client. Two views, driven by the phase the screen announces:
//
//   lobby — edit your name, see who else is in, mark yourself ready.
//   game  — floating joystick on the right, A/B buttons on the left (per
//           design brief), plus the Fabricator sketch pad.
//
// Input is sent at ~30 Hz when it changes; button edges send immediately.

import { NICKNAME_MAX, rememberNickname, resolveIdentity, sanitizeNickname } from "../identity";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import type {
  ButtonState,
  Phase,
  PublicPlayer,
  Slot,
  StickState,
} from "../../../party/protocol";

const SEND_INTERVAL_MS = 33;
const STICK_RADIUS = 52;
const SKETCH_MAX_SIDE = 256;
const SKETCH_CROP_PADDING = 8;
const RENAME_DEBOUNCE_MS = 300;

export function startController(code: string) {
  const upperCode = code.toUpperCase();
  const app = document.getElementById("app")!;
  const identity = resolveIdentity();

  let view: "lobby" | "game" | null = null;
  let phase: Phase = "lobby";
  let slot: Slot | null = null;
  let roster: PublicPlayer[] = [];
  let screenConnected = false;
  let nickname = identity.nickname;
  let connStatus = "connecting…";

  // Per-view hooks, replaced on every render.
  let applyRoster: () => void = () => {};
  let applyStatus: () => void = () => {};
  let onUiMsg: (msg: Record<string, unknown>) => void = () => {};

  keepScreenAwake();
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // ── input state (shared across views so the send loop is set up once) ──
  const stick: StickState = { x: 0, y: 0 };
  const buttons: ButtonState = { a: false, b: false };
  let dirty = false;

  const conn = new RoomConnection(code, "controller", identity, {
    onStatus: (s) => {
      connStatus =
        s === "open" ? "connected" : s === "connecting" ? "connecting…" : "reconnecting…";
      applyStatus();
    },
    onMessage: (msg) => {
      if (msg.scope === "presence" && msg.type === "welcome" && msg.role === "controller") {
        slot = msg.slot;
        setPhase(msg.phase);
        applyRoster();
        return;
      }
      if (msg.scope === "presence" && msg.type === "roster") {
        roster = msg.players;
        screenConnected = msg.screenConnected;
        const me = roster.find((p) => p.playerId === identity.playerId);
        if (me) slot = me.slot;
        setPhase(msg.phase);
        applyRoster();
        return;
      }
      if (msg.scope === "ui") {
        onUiMsg(msg as unknown as Record<string, unknown>);
      }
    },
  });

  const sendNow = () => {
    conn.send({
      scope: "input",
      type: "input",
      stick: { x: round2(stick.x), y: round2(stick.y) },
      buttons: { ...buttons },
    });
    dirty = false;
  };
  setInterval(() => {
    if (dirty && view === "game") sendNow();
  }, SEND_INTERVAL_MS);

  function setPhase(next: Phase) {
    const changed = next !== phase || view === null;
    phase = next;
    if (!changed) return;
    if (phase === "playing" && view !== "game") {
      // "Look at your phone" cue in reverse: the world just came alive.
      if ("vibrate" in navigator) navigator.vibrate([20, 40, 20]);
      renderGame();
    } else if (phase === "lobby" && view !== "lobby") {
      renderLobby();
    }
  }

  // ── lobby view ────────────────────────────────────────────────
  function renderLobby() {
    view = "lobby";
    app.innerHTML = `
      <div class="pad-lobby" id="pad-lobby">
        <div class="pad-lobby-head">
          <span class="room">ROOM ${upperCode}</span>
          <span id="conn-status">${connStatus}</span>
        </div>

        <div class="you-card" id="you-card">
          <div class="you-slot" id="you-slot">…</div>
          <label class="field">
            <span>Your name</span>
            <input id="name-input" type="text" maxlength="${NICKNAME_MAX}"
                   autocomplete="nickname" autocapitalize="words" spellcheck="false"
                   enterkeyhint="done" placeholder="Tap to name yourself" />
          </label>
        </div>

        <div class="lobby-roster" id="lobby-roster"></div>

        <div class="lobby-actions">
          <button id="swap-btn" class="ghost">Swap seats</button>
          <button id="ready-btn" class="ready-btn">I'M READY</button>
        </div>

        <div class="lobby-foot" id="lobby-foot"></div>
      </div>
    `;

    const statusEl = document.getElementById("conn-status")!;
    applyStatus = () => {
      statusEl.textContent = connStatus;
    };
    applyStatus();

    const nameInput = document.getElementById("name-input") as HTMLInputElement;
    nameInput.value = nickname;
    let renameTimer: ReturnType<typeof setTimeout> | null = null;
    nameInput.addEventListener("input", () => {
      const clean = sanitizeNickname(nameInput.value);
      if (clean !== nameInput.value) nameInput.value = clean;
      nickname = clean;
      rememberNickname(clean);
      if (renameTimer) clearTimeout(renameTimer);
      renameTimer = setTimeout(() => {
        conn.send({ scope: "presence", type: "set-nickname", nickname });
      }, RENAME_DEBOUNCE_MS);
    });
    nameInput.addEventListener("blur", () => nameInput.scrollIntoView({ block: "center" }));
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nameInput.blur();
    });

    const readyBtn = document.getElementById("ready-btn") as HTMLButtonElement;
    readyBtn.addEventListener("click", () => {
      const me = roster.find((p) => p.playerId === identity.playerId);
      const next = !me?.ready;
      conn.send({ scope: "presence", type: "set-ready", ready: next });
      if ("vibrate" in navigator) navigator.vibrate(12);
    });

    const swapBtn = document.getElementById("swap-btn") as HTMLButtonElement;
    swapBtn.addEventListener("click", () => {
      conn.send({ scope: "presence", type: "swap-slots" });
      if ("vibrate" in navigator) navigator.vibrate(12);
    });

    const root = document.getElementById("pad-lobby")!;
    const slotEl = document.getElementById("you-slot")!;
    const rosterEl = document.getElementById("lobby-roster")!;
    const footEl = document.getElementById("lobby-foot")!;

    applyRoster = () => {
      const me = roster.find((p) => p.playerId === identity.playerId);
      root.classList.remove("slot-1", "slot-2");
      if (slot) root.classList.add(`slot-${slot}`);
      slotEl.textContent = slot ? `PLAYER ${slot}` : "SPECTATOR";
      slotEl.className = `you-slot${slot ? ` p${slot}` : " spectator"}`;

      // Keep the field in sync when the server trims/echoes a name, but never
      // fight the player while they're typing in it.
      if (me && document.activeElement !== nameInput && me.nickname !== nameInput.value) {
        nameInput.value = me.nickname;
        nickname = me.nickname;
      }

      const others = roster.filter((p) => p.playerId !== identity.playerId && p.slot !== null);
      rosterEl.innerHTML = others.length
        ? others
            .map(
              (p) => `
                <div class="roster-row p${p.slot} ${p.connected ? "" : "offline"}">
                  <span class="dot"></span>
                  <span class="rname">${escapeHtml(p.nickname || `Player ${p.slot}`)}</span>
                  <span class="rstate">${
                    !p.connected ? "offline" : p.ready ? "ready" : "not ready"
                  }</span>
                </div>`,
            )
            .join("")
        : `<div class="roster-empty">Waiting for a second phone…</div>`;

      readyBtn.classList.toggle("on", !!me?.ready);
      readyBtn.textContent = me?.ready ? "READY ✓" : "I'M READY";
      readyBtn.disabled = slot === null;
      swapBtn.hidden = slot === null || others.length === 0;

      footEl.textContent = !screenConnected
        ? "Waiting for the shared screen to come online…"
        : slot === null
          ? "Both seats are taken — you'll be watching this round."
          : me?.ready
            ? "Ready. The host starts the expedition from the big screen."
            : "Name yourself, then hit ready.";
    };
    applyRoster();

    onUiMsg = () => {};
  }

  // ── game view ─────────────────────────────────────────────────
  function renderGame() {
    view = "game";
    app.innerHTML = `
      <div class="controller" id="controller">
        <div class="status">
          <span class="slot-name" id="slot-name">…</span>
          · ROOM ${upperCode} ·
          <span id="conn-status">${connStatus}</span>
        </div>
        <div class="btn-zone">
          <button class="action-btn" id="btn-b">B</button>
          <button class="action-btn" id="btn-a">A</button>
        </div>
        <div class="stick-zone" id="stick-zone">
          <div class="stick-base" id="stick-base"></div>
          <div class="stick-nub" id="stick-nub"></div>
          <div class="zone-hint">touch anywhere here to move</div>
        </div>
        <button class="blueprint-btn" id="blueprint-btn">✏️ BLUEPRINT</button>
        <div class="fabricating-note hidden" id="fabricating-note">FABRICATING…</div>
        <div class="sketch-overlay hidden" id="sketch-overlay">
          <input id="sketch-name" type="text" maxlength="32" placeholder="Name it (e.g. Swamp Buggy)" autocomplete="off" />
          <input id="sketch-intent" type="text" maxlength="80" placeholder="Optional: what should it do?" autocomplete="off" />
          <div class="sketch-card"><canvas id="sketch-canvas"></canvas></div>
          <div class="sketch-actions">
            <button id="sketch-cancel">Cancel</button>
            <button id="sketch-clear">Clear</button>
            <button class="primary" id="sketch-submit">FABRICATE</button>
          </div>
        </div>
      </div>
    `;

    const root = document.getElementById("controller")!;
    const slotName = document.getElementById("slot-name")!;
    const statusEl = document.getElementById("conn-status")!;

    applyStatus = () => {
      statusEl.textContent = connStatus;
    };
    applyStatus();

    applyRoster = () => {
      const me = roster.find((p) => p.playerId === identity.playerId);
      root.classList.remove("slot-1", "slot-2");
      if (slot === null) {
        slotName.textContent = "SPECTATING";
      } else {
        slotName.textContent = me?.nickname || `P${slot}`;
        root.classList.add(`slot-${slot}`);
      }
    };
    applyRoster();

    // ── floating joystick ───────────────────────────────────────
    const zone = document.getElementById("stick-zone")!;
    const base = document.getElementById("stick-base")!;
    const nub = document.getElementById("stick-nub")!;
    let stickPointer: number | null = null;
    let origin = { x: 0, y: 0 };

    const placeStick = (el: HTMLElement, x: number, y: number) => {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };

    zone.addEventListener("pointerdown", (e) => {
      if (stickPointer !== null) return;
      stickPointer = e.pointerId;
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {
        // synthetic events (test harness) have no active pointer to capture
      }
      origin = { x: e.clientX, y: e.clientY };
      placeStick(base, e.clientX, e.clientY);
      placeStick(nub, e.clientX, e.clientY);
      base.style.opacity = "1";
      nub.style.opacity = "1";
    });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== stickPointer) return;
      let dx = e.clientX - origin.x;
      let dy = e.clientY - origin.y;
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        dx = (dx / len) * STICK_RADIUS;
        dy = (dy / len) * STICK_RADIUS;
      }
      placeStick(nub, origin.x + dx, origin.y + dy);
      stick.x = dx / STICK_RADIUS;
      stick.y = dy / STICK_RADIUS;
      dirty = true;
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== stickPointer) return;
      stickPointer = null;
      base.style.opacity = "0";
      nub.style.opacity = "0";
      stick.x = 0;
      stick.y = 0;
      sendNow(); // stop immediately, don't wait for the tick
    };
    zone.addEventListener("pointerup", endStick);
    zone.addEventListener("pointercancel", endStick);

    // ── blueprint sketch pad ────────────────────────────────────
    // The phone briefly becomes the Fabricator's design surface; the game
    // keeps running on the shared screen meanwhile.
    const fabricatingNote = document.getElementById("fabricating-note")!;
    const overlay = document.getElementById("sketch-overlay")!;
    const nameInput = document.getElementById("sketch-name") as HTMLInputElement;
    const intentInput = document.getElementById("sketch-intent") as HTMLInputElement;
    const sketchCanvas = document.getElementById("sketch-canvas") as HTMLCanvasElement;
    const sketchCtx = sketchCanvas.getContext("2d")!;

    const sizeSketchCanvas = () => {
      const rect = sketchCanvas.getBoundingClientRect();
      if (rect.width && rect.height) {
        // preserve drawing on resize is overkill for the PoC; just resize
        sketchCanvas.width = Math.round(rect.width);
        sketchCanvas.height = Math.round(rect.height);
        sketchCtx.lineWidth = 6;
        sketchCtx.lineCap = "round";
        sketchCtx.lineJoin = "round";
        sketchCtx.strokeStyle = "#1c232e";
      }
    };

    let drawing = false;
    let hasInk = false;
    sketchCanvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      hasInk = true;
      try {
        sketchCanvas.setPointerCapture(e.pointerId);
      } catch {
        // synthetic events (test harness)
      }
      const r = sketchCanvas.getBoundingClientRect();
      sketchCtx.beginPath();
      sketchCtx.moveTo(e.clientX - r.left, e.clientY - r.top);
      sketchCtx.lineTo(e.clientX - r.left + 0.1, e.clientY - r.top + 0.1);
      sketchCtx.stroke();
    });
    sketchCanvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const r = sketchCanvas.getBoundingClientRect();
      sketchCtx.lineTo(e.clientX - r.left, e.clientY - r.top);
      sketchCtx.stroke();
    });
    const endStroke = () => {
      drawing = false;
    };
    sketchCanvas.addEventListener("pointerup", endStroke);
    sketchCanvas.addEventListener("pointercancel", endStroke);

    document.getElementById("blueprint-btn")!.addEventListener("click", () => {
      overlay.classList.remove("hidden");
      requestAnimationFrame(sizeSketchCanvas);
    });
    document.getElementById("sketch-cancel")!.addEventListener("click", () => {
      overlay.classList.add("hidden");
    });
    document.getElementById("sketch-clear")!.addEventListener("click", () => {
      sketchCtx.clearRect(0, 0, sketchCanvas.width, sketchCanvas.height);
      hasInk = false;
    });
    document.getElementById("sketch-submit")!.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      // Crop to the ink, then downscale to ≤256px; keep alpha (the sketch
      // becomes the body sprite).
      const image = hasInk
        ? cropInkToDataUrl(sketchCanvas, SKETCH_MAX_SIDE, SKETCH_CROP_PADDING)
        : undefined;
      conn.send({
        scope: "ui",
        type: "blueprint",
        name,
        intent: intentInput.value.trim() || undefined,
        image,
      });
      overlay.classList.add("hidden");
      fabricatingNote.textContent = `FABRICATING: ${name}…`;
      fabricatingNote.classList.remove("hidden");
    });

    // ── buttons ─────────────────────────────────────────────────
    for (const id of ["a", "b"] as const) {
      const el = document.getElementById(`btn-${id}`)!;
      const set = (down: boolean) => {
        if (buttons[id] === down) return;
        buttons[id] = down;
        el.classList.toggle("pressed", down);
        if (down && "vibrate" in navigator) navigator.vibrate(12);
        sendNow(); // button edges are latency-critical
      };
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // synthetic events (test harness) have no active pointer to capture
        }
        set(true);
      });
      el.addEventListener("pointerup", () => set(false));
      el.addEventListener("pointercancel", () => set(false));
    }

    onUiMsg = (msg) => {
      if (msg.type === "fabricated" || msg.type === "fabricate-error") {
        fabricatingNote.classList.add("hidden");
        if ("vibrate" in navigator) {
          navigator.vibrate(msg.type === "fabricated" ? [30, 60, 30] : 200);
        }
      }
    };
  }

  renderLobby();
}

/** Crop a sketch canvas to the bounding box of its non-transparent pixels
 *  (plus a little padding) and downscale so the longest side is ≤ maxSide,
 *  preserving aspect ratio. Players draw in a small patch of the pad, so
 *  sending the raw canvas wastes most of the frame on transparent margin —
 *  which makes the body sprite render as a faint speck once stretched to the
 *  spec size, and gives the compiler an image where the subject is tiny.
 *  Returns undefined when the canvas holds no ink. */
function cropInkToDataUrl(
  source: HTMLCanvasElement,
  maxSide: number,
  padding: number,
): string | undefined {
  const w = source.width;
  const h = source.height;
  if (!w || !h) return undefined;

  let pixels: Uint8ClampedArray;
  try {
    pixels = source.getContext("2d")!.getImageData(0, 0, w, h).data;
  } catch {
    return undefined; // tainted canvas — shouldn't happen, we only draw strokes
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (pixels[row + x * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y; // rows are scanned top-down, so this is always the lowest so far
    }
  }
  if (maxX < 0) return undefined; // fully transparent

  const sx = Math.max(0, minX - padding);
  const sy = Math.max(0, minY - padding);
  const sw = Math.min(w, maxX + 1 + padding) - sx;
  const sh = Math.min(h, maxY + 1 + padding) - sy;

  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  const outCtx = out.getContext("2d")!;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
