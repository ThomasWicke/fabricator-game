// The touch pad's state machine, tested without a browser.
//
// This module is the one piece of code both hosts run — a phone paired to a
// TV and a tablet playing on its own — and it has now shipped two bugs that
// only appear under a real thumb: a stick placed off the edge of the screen,
// and a dropped pointerup that jammed it forever. Neither was visible by
// reading it. So the state machine gets a harness.
//
// The shim below is deliberately tiny: touchpad.ts touches very little DOM,
// and a fake that implements exactly that little is easier to trust than a
// full DOM would be.
//
// Run: npx tsx scripts/test-touchpad.ts

import { createTouchPad, type PadState } from "../client/src/touchpad";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── the smallest DOM that touchpad.ts can run against ──────────────

type Listener = (e: any) => void;

class El {
  className = "";
  children: El[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  private listeners = new Map<string, Listener[]>();
  private captured = new Set<number>();

  classList = {
    add: (...c: string[]) => {
      for (const x of c) if (!this.has(x)) this.className += ` ${x}`;
    },
    remove: (...c: string[]) => {
      for (const x of c) {
        this.className = this.className.replace(new RegExp(`\\b${x}\\b`, "g"), "").trim();
      }
    },
    toggle: (c: string, on: boolean) => (on ? this.classList.add(c) : this.classList.remove(c)),
  };

  private has(c: string) {
    return this.className.split(/\s+/).includes(c);
  }

  /** Parses only what the pad's own template contains: opening tags with a
   *  class and/or a data-btn. Enough for the three selectors it queries. */
  set innerHTML(html: string) {
    this.children = [];
    for (const m of html.matchAll(/<(\w+)([^>]*)>/g)) {
      const attrs = m[2];
      const el = new El();
      el.className = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const btn = /data-btn="([^"]*)"/.exec(attrs)?.[1];
      if (btn) el.dataset.btn = btn;
      this.children.push(el);
    }
  }

  append(...els: El[]) {
    this.children.push(...els);
  }
  remove() {}

  private all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  private matches(sel: string) {
    if (sel.startsWith(".")) return this.has(sel.slice(1));
    const attr = /^\[([\w-]+)\]$/.exec(sel);
    if (attr) return attr[1] === "data-btn" && this.dataset.btn !== undefined;
    return false;
  }
  querySelector(sel: string): El | null {
    return this.all().find((e) => e.matches(sel)) ?? null;
  }
  querySelectorAll(sel: string): El[] {
    return this.all().filter((e) => e.matches(sel));
  }

  addEventListener(type: string, fn: Listener) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  fire(type: string, e: Record<string, unknown> = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ preventDefault() {}, pointerId: 1, clientX: 0, clientY: 0, ...e });
    }
  }

  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
  /** The pad reads this to convert viewport coords into zone-local ones. */
  getBoundingClientRect() {
    return { left: 100, top: 200, width: 300, height: 400 };
  }
}

(globalThis as any).document = { createElement: () => new El() };
/** Frames the pad has asked for. The harness runs them by hand, because the
 *  recovery path deliberately puts a frame between a release and the press
 *  that follows it. */
const frame: (() => void)[] = [];
(globalThis as any).requestAnimationFrame = (fn: () => void) => frame.push(fn) - 1;
const runFrame = () => {
  const due = frame.splice(0);
  for (const fn of due) fn();
};
// navigator is left alone: node has a real one, it has no vibrate, and the
// pad's haptic is guarded by an `in` check.

// ── harness ────────────────────────────────────────────────────────

type Change = { a: boolean; b: boolean; sx: number; sy: number };

function makePad() {
  const host = new El();
  const changes: Change[] = [];
  createTouchPad(host as unknown as HTMLElement, (s: PadState) => {
    changes.push({
      a: s.buttons.a,
      b: s.buttons.b,
      sx: +s.stick.x.toFixed(3),
      sy: +s.stick.y.toFixed(3),
    });
  });
  const zone = host.querySelector(".stick-zone")!;
  const btnA = host.querySelectorAll("[data-btn]").find((e) => e.dataset.btn === "a")!;
  return { host, changes, zone, btnA };
}

/** Every moment the simulation could have sampled the pad, in order. This is
 *  what the game actually sees: it reads the latest state once a frame, so a
 *  press only registers if some sample between press and release has a=true. */
const sawPress = (changes: Change[]) => changes.some((c) => c.a);

console.log("\n── the A button ────────────────────────────────────────────");

{
  // Standing still: the reported symptom. The only events are the press and
  // the release — no stick traffic to carry the state along with it.
  const { changes, btnA } = makePad();
  btnA.fire("pointerdown", { pointerId: 7 });
  btnA.fire("pointerup", { pointerId: 7 });
  check("a tap while standing still reports the press", sawPress(changes), JSON.stringify(changes));
  check("…and then reports the release", changes.length > 0 && !changes[changes.length - 1].a);
}

{
  // Moving: the stick is streaming pointermoves, so the state is re-delivered
  // continuously and a press is carried along with it whether or not its own
  // event lands.
  const { changes, zone, btnA } = makePad();
  zone.fire("pointerdown", { pointerId: 1, clientX: 200, clientY: 400 });
  zone.fire("pointermove", { pointerId: 1, clientX: 260, clientY: 400 });
  btnA.fire("pointerdown", { pointerId: 7 });
  zone.fire("pointermove", { pointerId: 1, clientX: 262, clientY: 400 });
  btnA.fire("pointerup", { pointerId: 7 });
  check("a tap while moving reports the press", sawPress(changes));
}

{
  // The failure the stick already guards against, applied to a button: iOS
  // hands the touch to a system gesture and the release never arrives — not
  // even lostpointercapture. Without recovery the button is held forever, and
  // since the game acts on the false-to-true moment, it never fires again.
  const { changes, btnA } = makePad();
  btnA.fire("pointerdown", { pointerId: 7 });
  btnA.releasePointerCapture(7); // the touch is gone; nothing tells us so
  changes.length = 0;

  btnA.fire("pointerdown", { pointerId: 8 }); // a fresh press on a stale hold
  check(
    "a stale hold is released before the new press",
    changes.length === 1 && !changes[0].a,
    JSON.stringify(changes),
  );
  // The release and the press must not land in the same frame: the reader
  // samples once per frame and would see only the press, with nothing before
  // it to make the press an edge.
  runFrame();
  check(
    "a press still registers after a release went missing",
    sawPress(changes),
    changes.length ? JSON.stringify(changes) : "no state change at all",
  );
  btnA.fire("pointerup", { pointerId: 8 });
  check("…and the button lets go again", !changes[changes.length - 1].a);
}

{
  // Two fingers on one button: whoever pressed it owns it. A stray release
  // from the other must not drop a button that is still being held down.
  const { changes, btnA } = makePad();
  btnA.fire("pointerdown", { pointerId: 7 });
  btnA.fire("pointerup", { pointerId: 9 }); // never pressed it
  check("a foreign release does not let go", changes[changes.length - 1].a === true);
  btnA.fire("pointerup", { pointerId: 7 });
  check("the owner's release does", !changes[changes.length - 1].a);
}

{
  // Releasing the stick must not disturb a button that is being held.
  const { changes, zone, btnA } = makePad();
  btnA.fire("pointerdown", { pointerId: 7 });
  zone.fire("pointerdown", { pointerId: 1, clientX: 200, clientY: 400 });
  zone.fire("pointerup", { pointerId: 1 });
  check(
    "letting go of the stick does not clear a held button",
    changes[changes.length - 1].a === true,
    JSON.stringify(changes[changes.length - 1]),
  );
}

console.log("\n── the stick ───────────────────────────────────────────────");

{
  const { changes, zone } = makePad();
  zone.fire("pointerdown", { pointerId: 1, clientX: 200, clientY: 400 });
  zone.fire("pointermove", { pointerId: 1, clientX: 203, clientY: 400 }); // 3px
  check("a resting thumb reports a hard zero", changes[changes.length - 1].sx === 0);
  zone.fire("pointermove", { pointerId: 1, clientX: 400, clientY: 400 }); // way out
  const far = changes[changes.length - 1];
  check("a full push clamps to 1", Math.abs(far.sx - 1) < 1e-6, `${far.sx}`);
  zone.fire("pointerup", { pointerId: 1 });
  check("letting go reports a stop", changes[changes.length - 1].sx === 0);
}

{
  // The jam that stranded a player: the tracked pointer is gone but never
  // released, so every later touch is ignored as "a second finger".
  const { changes, zone } = makePad();
  zone.fire("pointerdown", { pointerId: 1, clientX: 200, clientY: 400 });
  // no pointerup — the touch simply vanishes, and capture with it
  zone.releasePointerCapture(1);
  zone.fire("pointerdown", { pointerId: 2, clientX: 200, clientY: 400 });
  zone.fire("pointermove", { pointerId: 2, clientX: 300, clientY: 400 });
  check("a fresh touch takes over a stranded stick", changes[changes.length - 1].sx > 0.5);
}

console.log(
  failures === 0
    ? "\n✓ all touchpad checks passed\n"
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
