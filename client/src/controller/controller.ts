// Phone controller: floating joystick on the right, A/B buttons on the left
// (per design brief). Simple enough to use without looking at the phone.
// Sends input at ~30 Hz when it changes; button edges send immediately.

import { resolveIdentity } from "../identity";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import type { ButtonState, StickState } from "../../../party/protocol";

const SEND_INTERVAL_MS = 33;
const STICK_RADIUS = 52;

export function startController(code: string) {
  const upperCode = code.toUpperCase();
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="controller" id="controller">
      <div class="status">
        <span class="slot-name" id="slot-name">…</span>
        · ROOM ${upperCode} ·
        <span id="conn-status">connecting…</span>
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

  keepScreenAwake();
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // ── input state ─────────────────────────────────────────────
  const stick: StickState = { x: 0, y: 0 };
  const buttons: ButtonState = { a: false, b: false };
  let dirty = false;

  const conn = new RoomConnection(code, "controller", resolveIdentity(), {
    onStatus: (s) => {
      statusEl.textContent =
        s === "open" ? "connected" : s === "connecting" ? "connecting…" : "reconnecting…";
    },
    onMessage: (msg) => {
      if (msg.scope === "presence" && msg.type === "welcome" && msg.role === "controller") {
        if (msg.slot === null) {
          slotName.textContent = "ROOM FULL";
        } else {
          slotName.textContent = `P${msg.slot}`;
          root.classList.remove("slot-1", "slot-2");
          root.classList.add(`slot-${msg.slot}`);
        }
        return;
      }
      if (msg.scope === "ui") {
        if (msg.type === "fabricated" || msg.type === "fabricate-error") {
          fabricatingNote.classList.add("hidden");
          if ("vibrate" in navigator) navigator.vibrate(msg.type === "fabricated" ? [30, 60, 30] : 200);
        }
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
    if (dirty) sendNow();
  }, SEND_INTERVAL_MS);

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
    // Downscale to ≤256px, keep alpha (the sketch becomes the body sprite).
    let image: string | undefined;
    if (hasInk) {
      const scale = Math.min(1, 256 / Math.max(sketchCanvas.width, sketchCanvas.height));
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(sketchCanvas.width * scale));
      out.height = Math.max(1, Math.round(sketchCanvas.height * scale));
      out.getContext("2d")!.drawImage(sketchCanvas, 0, 0, out.width, out.height);
      image = out.toDataURL("image/png");
    }
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
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
