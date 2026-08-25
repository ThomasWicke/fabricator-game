// Phone client. Two views, driven by the phase the screen announces:
//
//   lobby — edit your name, see who else is in, mark yourself ready.
//   game  — floating joystick on the right, A/B buttons on the left (per
//           design brief), plus the blueprint pad and the design store.
//
// The game view is simple enough to use without looking at the phone. Input
// is sent at ~30 Hz when it changes; button edges send immediately.

import {
  NICKNAME_MAX,
  rememberNickname,
  resolveIdentity,
  sanitizeNickname,
} from "../identity";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import type {
  ButtonState,
  Phase,
  PublicPlayer,
  Slot,
  StickState,
} from "../../../party/protocol";
import type { DesignSummary } from "../../../party/designs";
import type { MaterialType } from "../../../shared/fabricator/schema";

const SEND_INTERVAL_MS = 33;
const STICK_RADIUS = 56;
/** Travel, in px, that reads as "not moving". Below this the stick sends a
 *  hard zero — a thumb resting on glass is never perfectly still. */
const STICK_DEAD_ZONE = 9;
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

  // The catalog and the stockpile arrive while the lobby is still up, so they
  // live out here and the game view renders whatever has accumulated.
  const designs = new Map<string, DesignSummary>();
  const stock: Record<MaterialType, number> = { wood: 0, stone: 0, bogiron: 0 };

  /** Standing at the Fabricator? Lives at controller scope because the world
   *  reports it while the lobby may still be up, before the pad view exists. */
  let atFabricator = false;

  // Per-view hooks, replaced on every render.
  let applyRoster: () => void = () => {};
  let applyStatus: () => void = () => {};
  let onUiMsg: (msg: Record<string, unknown>) => void = () => {};
  let renderDesigns: () => void = () => {};
  let applyFabState: () => void = () => {};

  keepScreenAwake();
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // ── input state (shared, so the send loop is set up once) ───
  const stick: StickState = { x: 0, y: 0 };
  const buttons: ButtonState = { a: false, b: false };
  let dirty = false;

  function setPhase(next: Phase) {
    const changed = next !== phase || view === null;
    phase = next;
    if (!changed) return;
    if (phase === "playing" && view !== "game") {
      // the world just came alive — look up at the screen
      if ("vibrate" in navigator) navigator.vibrate([20, 40, 20]);
      renderGame();
    } else if (phase === "lobby" && view !== "lobby") {
      renderLobby();
    }
  }

  // ── lobby view ──────────────────────────────────────────────
  function renderLobby() {
    view = "lobby";
    app.innerHTML = `
      <div class="pad-lobby" id="pad-lobby">
        <div class="pad-lobby-head">
          <span class="room">ROOM ${upperCode}</span>
          <span id="conn-status">${connStatus}</span>
        </div>

        <div class="you-card">
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
    renderDesigns = () => {};
    onUiMsg = () => {};
    applyFabState = () => {};

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
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nameInput.blur();
    });

    const readyBtn = document.getElementById("ready-btn") as HTMLButtonElement;
    readyBtn.addEventListener("click", () => {
      const me = roster.find((p) => p.playerId === identity.playerId);
      conn.send({ scope: "presence", type: "set-ready", ready: !me?.ready });
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

      // Keep the field in sync when the server trims or echoes a name, but
      // never fight the player while they're typing in it.
      if (me && document.activeElement !== nameInput && me.nickname !== nameInput.value) {
        nameInput.value = me.nickname;
        nickname = me.nickname;
      }

      const others = roster.filter(
        (p) => p.playerId !== identity.playerId && p.slot !== null,
      );
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
  }

  // ── game view ───────────────────────────────────────────────
  function renderGame() {
    view = "game";
    app.innerHTML = `
      <div class="controller" id="controller">
        <div class="pad-rail">
          <span class="rail-slot" id="slot-name">…</span>
          <span class="rail-room">${upperCode}</span>
          <span class="rail-conn" id="conn-status">connecting…</span>
        </div>
        <div class="btn-zone">
          <button class="action-btn secondary" id="btn-b"><b>B</b><i>run</i></button>
          <button class="action-btn" id="btn-a"><b>A</b><i>use</i></button>
        </div>
        <div class="stick-zone" id="stick-zone">
          <div class="stick-base" id="stick-base"><span class="ring"></span></div>
          <div class="stick-nub" id="stick-nub"></div>
          <div class="zone-hint">touch to move</div>
        </div>
        <div class="top-btns">
          <button class="fab-btn" id="blueprint-btn">
            <span class="ico">✎</span><span class="txt">BLUEPRINT</span>
          </button>
          <button class="fab-btn" id="designs-btn">
            <span class="ico">▦</span><span class="txt">DESIGNS</span><span class="badge" id="designs-count">0</span>
          </button>
        </div>
        <div class="fab-hint" id="fab-hint"></div>
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

    // ── the Fabricator gate ─────────────────────────────────────
    // Blueprinting and building happen AT the machine. Browsing the library
    // does not — knowing what you could build, and what it would cost, is
    // exactly the thing you want to think about while you're out gathering.
    const blueprintBtn = document.getElementById("blueprint-btn") as HTMLButtonElement;
    const fabHint = document.getElementById("fab-hint")!;

    applyFabState = () => {
      const usable = atFabricator && slot !== null;
      blueprintBtn.disabled = !usable;
      root.classList.toggle("at-fab", usable);
      fabHint.textContent = usable ? "At the Fabricator" : "Walk to the Fabricator to build";
      fabHint.classList.toggle("on", usable);
      renderDesigns();
    };

    // ── floating joystick ───────────────────────────────────────
    const zone = document.getElementById("stick-zone")!;
    const base = document.getElementById("stick-base")!;
    const nub = document.getElementById("stick-nub")!;
    let stickPointer: number | null = null;
    let origin = { x: 0, y: 0 };
    /** The zone's viewport offset, captured when a touch starts.
     *
     *  The base and nub are absolutely positioned *inside* .stick-zone, but
     *  pointer events report viewport coordinates — and the zone starts 45% of
     *  the way across the screen. Placing them at the raw clientX pushed the
     *  whole control off the right edge, so the stick you were meant to see
     *  under your thumb was never actually on screen. */
    let zoneOrigin = { x: 0, y: 0 };

    const placeStick = (el: HTMLElement, x: number, y: number) => {
      el.style.left = `${x - zoneOrigin.x}px`;
      el.style.top = `${y - zoneOrigin.y}px`;
    };

    zone.addEventListener("pointerdown", (e) => {
      // Normally we ignore a second finger. But if the tracked pointer is no
      // longer actually held — a system gesture stole the touch, the browser
      // dropped the pointerup — then holding onto it jams the stick and the
      // player simply cannot move again. A fresh touch takes over instead.
      if (stickPointer !== null) {
        const stale = !zone.hasPointerCapture(stickPointer);
        if (!stale) return;
        releaseStick();
      }
      stickPointer = e.pointerId;
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {
        // synthetic events (test harness) have no active pointer to capture
      }
      // The stick is wherever your thumb lands. Nothing to aim for, nothing to
      // find by feel — which is the whole point of a screen you don't look at.
      // Read the zone's offset now: one layout read per touch, not per move.
      const r = zone.getBoundingClientRect();
      zoneOrigin = { x: r.left, y: r.top };
      origin = { x: e.clientX, y: e.clientY };
      placeStick(base, e.clientX, e.clientY);
      placeStick(nub, e.clientX, e.clientY);
      zone.classList.add("engaged");
    });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== stickPointer) return;
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;
      const len = Math.hypot(dx, dy);
      const ux = len ? dx / len : 0;
      const uy = len ? dy / len : 0;

      // The nub tracks the thumb (clamped to the ring) so the control always
      // looks like it is following you.
      const visual = Math.min(len, STICK_RADIUS);
      placeStick(nub, origin.x + ux * visual, origin.y + uy * visual);

      // What we SEND is remapped past a dead zone and ramps to full over the
      // remaining travel. A thumb resting on glass never sits perfectly still,
      // and without this the character drifts while you are reading the screen.
      const mag =
        len <= STICK_DEAD_ZONE
          ? 0
          : Math.min(1, (len - STICK_DEAD_ZONE) / (STICK_RADIUS - STICK_DEAD_ZONE));
      stick.x = ux * mag;
      stick.y = uy * mag;
      zone.classList.toggle("live", mag > 0);
      dirty = true;
    });
    const releaseStick = () => {
      stickPointer = null;
      zone.classList.remove("engaged", "live");
      stick.x = 0;
      stick.y = 0;
      sendNow(); // stop immediately, don't wait for the tick
    };
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== stickPointer) return;
      releaseStick();
    };
    zone.addEventListener("pointerup", endStick);
    zone.addEventListener("pointercancel", endStick);
    // Losing capture without a pointerup is the case that strands you: iOS
    // hands the touch to a system gesture and no further events arrive.
    zone.addEventListener("lostpointercapture", endStick);

    // ── design library ──────────────────────────────────────────
    // Designs are permanent; building one spends materials. Showing cost and
    // affordability here is the whole point — players decide before paying.
    // The catalog and stockpile themselves live at controller scope: both keep
    // arriving while the lobby is up, before this view exists.
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

    renderDesigns = () => {
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
          // Two different reasons a design can't be built right now, and they
          // call for two different responses from the player — so say which.
          const label = !affordable ? "NEED MORE" : !atFabricator ? "TOO FAR" : "BUILD";
          // The thumbnail is the point of the library: you are about to spend
          // real materials, and the name alone doesn't tell you what the
          // Fabricator actually made of your sketch.
          const thumb = d.artUrl
            ? `<img class="dthumb" src="${esc(d.artUrl)}" alt="" loading="lazy" />`
            : `<div class="dthumb missing"></div>`;
          return `
            <div class="design-row">
              ${thumb}
              <div class="info">
                <div class="dname">${esc(d.displayName)}</div>
                <div class="dmeta">${d.category}${built}</div>
                <div class="dcost">${costMarkup(d.cost)}</div>
              </div>
              <button data-build="${d.id}" ${
                affordable && atFabricator ? "" : "disabled"
              }>${label}</button>
            </div>`;
        })
        .join("");
      designsList.innerHTML = rows;
      // A design can have art recorded but the blob still be missing (an
      // upload that failed, an old room). Drop the src so the browser shows
      // the empty plate instead of a broken-image glyph.
      for (const img of designsList.querySelectorAll<HTMLImageElement>("img.dthumb")) {
        // Swap the whole element for a blank plate. Clearing src is not
        // enough: an <img> that has already failed keeps painting its
        // broken-image glyph regardless of what the attribute says.
        const fail = () => {
          const plate = document.createElement("div");
          plate.className = "dthumb missing";
          img.replaceWith(plate);
        };
        img.addEventListener("error", fail);
        // A cached failure fires its error event before this listener exists
        // and never fires again, so check for one that already happened.
        if (img.complete && img.naturalWidth === 0) fail();
      }
    };

    designsList.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-build]") as HTMLElement | null;
      if (!btn || (btn as HTMLButtonElement).disabled) return;
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
    applyFabState(); // also renders the design list, with the right button states

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

    blueprintBtn.addEventListener("click", () => {
      if (blueprintBtn.disabled) return;
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

    onUiMsg = (msg) => {
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
        renderDesigns();
      } else if (msg.type === "fabricate-error") {
        fabricatingNote.classList.add("hidden");
        if ("vibrate" in navigator) navigator.vibrate(200);
      }
    };

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

  // ── networking ────────────────────────────────────────────────
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
        // Stockpile and Fabricator proximity are tracked at controller scope,
        // not per view: both keep arriving while the lobby is still up, and
        // the game view has to open already knowing them rather than showing
        // a wrong state until the next update happens to land.
        if (msg.type === "stockpile") {
          const s = msg as unknown as Record<MaterialType, number>;
          stock.wood = s.wood;
          stock.stone = s.stone;
          stock.bogiron = s.bogiron;
        } else if (msg.type === "fabricator-range") {
          const m = msg as unknown as { slot: Slot; inRange: boolean };
          if (m.slot === slot && m.inRange !== atFabricator) {
            atFabricator = m.inRange;
            applyFabState();
            // A nudge on arrival: the phone can suddenly do something it
            // couldn't a moment ago, and you're looking at the TV, not at it.
            if (m.inRange && "vibrate" in navigator) navigator.vibrate([15, 35, 15]);
          }
        }
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

  renderLobby();
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
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
