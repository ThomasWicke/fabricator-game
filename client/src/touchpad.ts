// The touch controls, shared by the phone controller and the shared screen.
//
// Two very different hosts, one pad: a phone paired to a TV sends this over
// the socket, and a tablet playing on its own feeds it straight into the
// simulation running behind it. Building the markup here rather than in each
// caller is what keeps them identical — including the awkward parts, like a
// pointer that never sends its release.

export type PadState = {
  stick: { x: number; y: number };
  buttons: { a: boolean; b: boolean };
};

const STICK_RADIUS = 56;
/** Travel, in px, that reads as "not moving". Below this the stick sends a
 *  hard zero — a thumb resting on glass is never perfectly still. */
const STICK_DEAD_ZONE = 9;

export type TouchPad = {
  state: PadState;
  destroy: () => void;
};

/**
 * Build the stick and action buttons inside `host`, which must be a
 * positioned element carrying the `pad-surface` class.
 *
 * `onChange` fires whenever the state changes. `immediate` marks the changes
 * that must not wait for a send tick — button edges and letting go of the
 * stick, where a frame of lag is the difference between stopping at the
 * water's edge and walking into it.
 */
export function createTouchPad(
  host: HTMLElement,
  onChange: (state: PadState, immediate: boolean) => void,
  labels: { a: string; b: string } = { a: "use", b: "run" },
): TouchPad {
  const state: PadState = { stick: { x: 0, y: 0 }, buttons: { a: false, b: false } };

  const zone = document.createElement("div");
  zone.className = "stick-zone";
  zone.innerHTML = `
    <div class="stick-base"><span class="ring"></span></div>
    <div class="stick-nub"></div>
    <div class="zone-hint">touch to move</div>`;

  const btns = document.createElement("div");
  btns.className = "btn-zone";
  btns.innerHTML = `
    <button class="action-btn secondary" data-btn="b"><b>B</b><i>${labels.b}</i></button>
    <button class="action-btn" data-btn="a"><b>A</b><i>${labels.a}</i></button>`;

  host.append(btns, zone);

  const base = zone.querySelector<HTMLElement>(".stick-base")!;
  const nub = zone.querySelector<HTMLElement>(".stick-nub")!;

  let stickPointer: number | null = null;
  let origin = { x: 0, y: 0 };
  /** The zone's viewport offset, captured when a touch starts. The stick's
   *  parts are positioned inside the zone, but pointer events report viewport
   *  coordinates — placing them at the raw clientX pushes the control clean
   *  off the edge of the screen. */
  let zoneOrigin = { x: 0, y: 0 };

  const place = (el: HTMLElement, x: number, y: number) => {
    el.style.left = `${x - zoneOrigin.x}px`;
    el.style.top = `${y - zoneOrigin.y}px`;
  };

  const release = () => {
    stickPointer = null;
    zone.classList.remove("engaged", "live");
    state.stick.x = 0;
    state.stick.y = 0;
    onChange(state, true);
  };

  zone.addEventListener("pointerdown", (e) => {
    // Normally a second finger is ignored. But if the tracked pointer is no
    // longer actually held — a system gesture stole the touch, the browser
    // dropped the pointerup — holding onto it jams the stick and the player
    // cannot move again. A fresh touch takes over instead.
    if (stickPointer !== null) {
      if (zone.hasPointerCapture(stickPointer)) return;
      release();
    }
    stickPointer = e.pointerId;
    try {
      zone.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events (test harness) have no active pointer to capture
    }
    const r = zone.getBoundingClientRect();
    zoneOrigin = { x: r.left, y: r.top };
    origin = { x: e.clientX, y: e.clientY };
    place(base, e.clientX, e.clientY);
    place(nub, e.clientX, e.clientY);
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
    place(nub, origin.x + ux * visual, origin.y + uy * visual);

    // What we REPORT is remapped past a dead zone and ramps to full over the
    // remaining travel.
    const mag =
      len <= STICK_DEAD_ZONE
        ? 0
        : Math.min(1, (len - STICK_DEAD_ZONE) / (STICK_RADIUS - STICK_DEAD_ZONE));
    state.stick.x = ux * mag;
    state.stick.y = uy * mag;
    zone.classList.toggle("live", mag > 0);
    onChange(state, false);
  });

  const end = (e: PointerEvent) => {
    if (e.pointerId !== stickPointer) return;
    release();
  };
  zone.addEventListener("pointerup", end);
  zone.addEventListener("pointercancel", end);
  // Losing capture without a pointerup is the case that strands you: iOS
  // hands the touch to a system gesture and no further events arrive.
  zone.addEventListener("lostpointercapture", end);

  for (const el of btns.querySelectorAll<HTMLElement>("[data-btn]")) {
    const key = el.dataset.btn as "a" | "b";
    const set = (down: boolean) => {
      if (state.buttons[key] === down) return;
      state.buttons[key] = down;
      el.classList.toggle("pressed", down);
      if (down && "vibrate" in navigator) navigator.vibrate(12);
      onChange(state, true); // button edges are latency-critical
    };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // synthetic events (test harness)
      }
      set(true);
    });
    el.addEventListener("pointerup", () => set(false));
    el.addEventListener("pointercancel", () => set(false));
    el.addEventListener("lostpointercapture", () => set(false));
  }

  return {
    state,
    destroy: () => {
      zone.remove();
      btns.remove();
    },
  };
}
