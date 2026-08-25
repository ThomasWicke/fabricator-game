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
import { createSketchPad } from "../sketch";
import { createTouchPad, type TouchPad } from "../touchpad";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import type {
  BeltMsg,
  ButtonState,
  StockpileMsg,
  Phase,
  PublicPlayer,
  Slot,
  StickState,
} from "../../../party/protocol";
import type { DesignSummary } from "../../../party/designs";
import { MATERIALS, type MaterialType } from "../../../shared/fabricator/schema";

const SEND_INTERVAL_MS = 33;
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
  const stock: Record<MaterialType, number> = Object.fromEntries(
    MATERIALS.map((m) => [m, 0]),
  ) as Record<MaterialType, number>;

  /** The belt arrives whether or not the game view exists yet, so the last
   *  one is kept and replayed when the view is built. */
  let lastBelt: BeltMsg = { scope: "ui", type: "belt", slot: 1, count: 0, index: -1, held: null };
  let applyBelt: (b: BeltMsg) => void = (b) => {
    lastBelt = b;
  };

  /** Standing at the Fabricator? Lives at controller scope because the world
   *  reports it while the lobby may still be up, before the pad view exists. */
  let atFabricator = false;

  // Per-view hooks, replaced on every render.
  let applyRoster: () => void = () => {};
  let applyStatus: () => void = () => {};
  let onUiMsg: (msg: Record<string, unknown>) => void = () => {};
  let renderDesigns: () => void = () => {};
  let applyFabState: () => void = () => {};
  /** The live touch pad, so switching views doesn't leave a second one wired
   *  up to the same host element. */
  let touchPad: TouchPad | null = null;

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
    touchPad?.destroy();
    touchPad = null;
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
    touchPad?.destroy();
    app.innerHTML = `
      <div class="controller pad-surface" id="controller">
        <div class="pad-rail">
          <span class="rail-slot" id="slot-name">…</span>
          <span class="rail-room">${upperCode}</span>
          <span class="rail-conn" id="conn-status">connecting…</span>
        </div>
        <div class="top-btns">
          <button class="fab-btn" id="blueprint-btn">
            <span class="ico">✎</span><span class="txt">BLUEPRINT</span>
          </button>
          <button class="fab-btn" id="designs-btn">
            <span class="ico">▦</span><span class="txt">DESIGNS</span><span class="badge" id="designs-count">0</span>
          </button>
          <button class="fab-btn hidden" id="swap-btn">
            <span class="ico">⇄</span><span class="txt">TOOL</span>
          </button>
        </div>
        <div class="fab-hint" id="fab-hint"></div>
        <div class="fabricating-note hidden" id="fabricating-note">FABRICATING…</div>
        <div class="designs-overlay hidden" id="designs-overlay">
          <div class="designs-head">
            <h2>Design store</h2>
            <div class="stock" id="designs-stock">🪵 0 · 🪨 0</div>
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

    // ── the pad ─────────────────────────────────────────────────
    // Stick and buttons come from the shared module, so this phone and a
    // tablet playing on its own behave identically down to the edge cases.
    // Swapping is a whole-belt verb, not a pad button: it has to work while
    // the stick and both actions are already spoken for.
    const swapBtn = document.getElementById("swap-btn")!;
    swapBtn.addEventListener("click", () => {
      if (slot) conn.send({ scope: "ui", type: "tool-cycle", slot });
    });
    applyBelt = (b: BeltMsg) => {
      // Still recorded: the game view can be torn down and rebuilt (a phone
      // rejoining, the lobby coming back), and it has to be redrawn from the
      // last thing the screen said rather than from an empty belt.
      lastBelt = b;
      // Nothing on the belt means nothing to swap between, so the control is
      // absent rather than present and inert.
      swapBtn.classList.toggle("hidden", b.count < 1);
      const label = swapBtn.querySelector(".txt")!;
      label.textContent = b.held ?? "HANDS";
    };
    applyBelt(lastBelt);

    touchPad = createTouchPad(root, (s, immediate) => {
      stick.x = s.stick.x;
      stick.y = s.stick.y;
      buttons.a = s.buttons.a;
      buttons.b = s.buttons.b;
      if (immediate) sendNow();
      else dirty = true;
    });

    // ── design library ──────────────────────────────────────────
    // Designs are permanent; building one spends materials. Showing cost and
    // affordability here is the whole point — players decide before paying.
    // The catalog and stockpile themselves live at controller scope: both keep
    // arriving while the lobby is up, before this view exists.
    const designsOverlay = document.getElementById("designs-overlay")!;
    const designsList = document.getElementById("designs-list")!;
    const designsCount = document.getElementById("designs-count")!;
    const designsStock = document.getElementById("designs-stock")!;

    const SHORT: Record<MaterialType, string> = {
      wood: "🪵",
      stone: "🪨",
      bogiron: "⚙️",
      basalt: "🌑",
      glass: "💠",
      rime: "❄️",
    };

    const costMarkup = (cost: Record<MaterialType, number>) =>
      MATERIALS.filter((m) => cost[m] > 0)
        .map((m) => {
          const short = SHORT;
          const lack = stock[m] < cost[m];
          return `<span class="${lack ? "lack" : ""}">${short[m]} ${cost[m]}</span>`;
        })
        .join(" · ") || "free";

    renderDesigns = () => {
      designsCount.textContent = String(designs.size);
      // Wood and stone always; an ore once there is any, so the line grows as
      // the map opens up instead of showing four permanent zeroes.
      designsStock.textContent = MATERIALS.filter(
        (m) => m === "wood" || m === "stone" || stock[m] > 0,
      )
        .map((m) => `${SHORT[m]} ${Math.floor(stock[m])}`)
        .join(" · ");
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
              <div class="drow-actions">
                <button data-build="${d.id}" ${
                  affordable && atFabricator ? "" : "disabled"
                }>${label}</button>
                <button class="ddiscard" data-discard="${d.id}" aria-label="Discard">✕</button>
              </div>
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
      const drop = (e.target as HTMLElement).closest("[data-discard]") as HTMLElement | null;
      if (drop) {
        // A request, not an order: the screen holds the world and is the only
        // one that can see whether this design is standing in it.
        conn.send({ scope: "ui", type: "design-delete", designId: drop.dataset.discard! });
        return;
      }
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
    // Mirror of the screen's patience budget: a dead fabrication must not
    // leave the note up forever, and an error should be read, not glimpsed.
    let noteTimeout: ReturnType<typeof setTimeout> | null = null;
    const disarmNoteTimeout = () => {
      if (noteTimeout) clearTimeout(noteTimeout);
      noteTimeout = null;
    };
    const armNoteTimeout = () => {
      disarmNoteTimeout();
      noteTimeout = setTimeout(
        () => showNoteError("The Fabricator has gone quiet — that design isn't coming. Try again."),
        90_000,
      );
    };
    const showNoteError = (message: string) => {
      disarmNoteTimeout();
      fabricatingNote.textContent = message;
      fabricatingNote.classList.remove("hidden");
      fabricatingNote.classList.add("err");
      noteTimeout = setTimeout(() => {
        fabricatingNote.classList.add("hidden");
        fabricatingNote.classList.remove("err");
        noteTimeout = null;
      }, 7_000);
    };
    const overlay = document.getElementById("sketch-overlay")!;
    const nameInput = document.getElementById("sketch-name") as HTMLInputElement;
    const intentInput = document.getElementById("sketch-intent") as HTMLInputElement;
    const sketchCanvas = document.getElementById("sketch-canvas") as HTMLCanvasElement;
    const pad = createSketchPad(sketchCanvas);

    blueprintBtn.addEventListener("click", () => {
      if (blueprintBtn.disabled) return;
      overlay.classList.remove("hidden");
      requestAnimationFrame(pad.fit);
    });
    document.getElementById("sketch-cancel")!.addEventListener("click", () => {
      overlay.classList.add("hidden");
    });
    document.getElementById("sketch-clear")!.addEventListener("click", pad.clear);
    document.getElementById("sketch-submit")!.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      conn.send({
        scope: "ui",
        type: "blueprint",
        name,
        slot: slot ?? undefined,
        // Cropped to the ink and downscaled; alpha is kept, because the
        // sketch is the fallback body sprite.
        intent: intentInput.value.trim() || undefined,
        image: pad.toDataUrl(SKETCH_MAX_SIDE, SKETCH_CROP_PADDING),
      });
      overlay.classList.add("hidden");
      fabricatingNote.textContent = `FABRICATING: ${name}…`;
      fabricatingNote.classList.remove("hidden");
      fabricatingNote.classList.remove("err");
      armNoteTimeout();
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
          disarmNoteTimeout();
          if ("vibrate" in navigator) navigator.vibrate([30, 60, 30]);
        }
      } else if (msg.type === "stockpile") {
        renderDesigns();
      } else if (msg.type === "fabricate-progress") {
        const m = msg as unknown as { name: string };
        fabricatingNote.textContent = `DRAWING: ${m.name}…`;
        armNoteTimeout();
      } else if (msg.type === "fabricate-error") {
        // The phone used to buzz and say nothing — the one person who chose
        // whether to try again was the one person with no error text.
        showNoteError(String(msg.message ?? "Fabrication failed."));
        if ("vibrate" in navigator) navigator.vibrate(200);
      }
    };

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
          const s = (msg as unknown as StockpileMsg).stock;
          for (const m of MATERIALS) stock[m] = s[m] ?? 0;
        } else if (msg.type === "design-removed") {
          designs.delete(String((msg as unknown as { designId: string }).designId));
          renderDesigns();
        } else if (msg.type === "belt") {
          const b = msg as unknown as BeltMsg;
          if (b.slot === slot) applyBelt(b);
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
