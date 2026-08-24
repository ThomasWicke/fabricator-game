// Phone controller: floating joystick on the right, A/B buttons on the left
// (per design brief). Simple enough to use without looking at the phone.
// Sends input at ~30 Hz when it changes; button edges send immediately.

import { resolveIdentity } from "../identity";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import type { ButtonState, StickState } from "../../../party/protocol";
import type { DesignSummary } from "../../../party/designs";
import type { MaterialType } from "../../../shared/fabricator/schema";

const SEND_INTERVAL_MS = 33;
const STICK_RADIUS = 52;
const SKETCH_MAX_SIDE = 256;
const SKETCH_CROP_PADDING = 8;

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
      <div class="top-btns">
        <button class="blueprint-btn" id="blueprint-btn">✏️ BLUEPRINT</button>
        <button class="blueprint-btn" id="designs-btn">📐 DESIGNS<span class="badge" id="designs-count">0</span></button>
      </div>
      <div class="fabricating-note hidden" id="fabricating-note">FABRICATING…</div>
      <div class="designs-overlay hidden" id="designs-overlay">
        <div class="designs-head">
          <h2>Design store</h2>
          <div class="stock" id="designs-stock">🪵 0 · 🪨 0 · ⚙️ 0</div>
        </div>
        <div class="designs-list" id="designs-list"></div>
        <button class="designs-close" id="designs-close">Close</button>
      </div>
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
        if (msg.type === "design-catalog") {
          designs.clear();
          for (const d of (msg as unknown as { designs: DesignSummary[] }).designs) {
            designs.set(d.id, d);
          }
          renderDesigns();
        } else if (msg.type === "design-added") {
          const d = (msg as unknown as { design: DesignSummary }).design;
          const isNew = !designs.has(d.id);
          designs.set(d.id, d);
          renderDesigns();
          if (isNew) {
            fabricatingNote.classList.add("hidden");
            if ("vibrate" in navigator) navigator.vibrate([30, 60, 30]);
          }
        } else if (msg.type === "stockpile") {
          const s = msg as unknown as Record<MaterialType, number>;
          stock.wood = s.wood;
          stock.stone = s.stone;
          stock.bogiron = s.bogiron;
          renderDesigns();
        } else if (msg.type === "fabricate-error") {
          fabricatingNote.classList.add("hidden");
          if ("vibrate" in navigator) navigator.vibrate(200);
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

  // ── design library ──────────────────────────────────────────
  // Designs are permanent; building one spends materials. Showing cost and
  // affordability here is the whole point — players decide before paying.
  const designs = new Map<string, DesignSummary>();
  const stock: Record<MaterialType, number> = { wood: 0, stone: 0, bogiron: 0 };
  const designsOverlay = document.getElementById("designs-overlay")!;
  const designsList = document.getElementById("designs-list")!;
  const designsCount = document.getElementById("designs-count")!;
  const designsStock = document.getElementById("designs-stock")!;

  const costMarkup = (cost: Record<MaterialType, number>) =>
    (["wood", "stone", "bogiron"] as MaterialType[])
      .filter((m) => cost[m] > 0)
      .map((m) => {
        const short = { wood: "🪵", stone: "🪨", bogiron: "⚙️" }[m];
        const lack = stock[m] < cost[m];
        return `<span class="${lack ? "lack" : ""}">${short} ${cost[m]}</span>`;
      })
      .join(" · ") || "free";

  function renderDesigns() {
    designsCount.textContent = String(designs.size);
    designsStock.textContent =
      `🪵 ${Math.floor(stock.wood)} · 🪨 ${Math.floor(stock.stone)} · ⚙️ ${Math.floor(stock.bogiron)}`;
    if (designs.size === 0) {
      designsList.innerHTML =
        `<div class="designs-empty">No designs yet.<br>Tap ✏️ BLUEPRINT to sketch one —<br>the Fabricator will design it, then you can build it as often as you like.</div>`;
      return;
    }
    const rows = [...designs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => {
        const affordable =
          stock.wood >= d.cost.wood &&
          stock.stone >= d.cost.stone &&
          stock.bogiron >= d.cost.bogiron;
        const built = d.timesBuilt > 0 ? ` · built ${d.timesBuilt}×` : "";
        return `
          <div class="design-row">
            <div class="info">
              <div class="dname">${esc(d.displayName)}</div>
              <div class="dmeta">${d.category}${built}${d.hasArt ? " · art ✓" : ""}</div>
              <div class="dcost">${costMarkup(d.cost)}</div>
            </div>
            <button data-build="${d.id}" ${affordable ? "" : "disabled"}>BUILD</button>
          </div>`;
      })
      .join("");
    designsList.innerHTML = rows;
  }

  designsList.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-build]") as HTMLElement | null;
    if (!btn) return;
    conn.send({ scope: "ui", type: "manufacture", designId: btn.dataset.build! });
    if ("vibrate" in navigator) navigator.vibrate(20);
    designsOverlay.classList.add("hidden");
  });
  document.getElementById("designs-btn")!.addEventListener("click", () => {
    renderDesigns();
    designsOverlay.classList.remove("hidden");
  });
  document.getElementById("designs-close")!.addEventListener("click", () => {
    designsOverlay.classList.add("hidden");
  });
  renderDesigns();

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
