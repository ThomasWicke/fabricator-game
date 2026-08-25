// The animated backdrop behind the title screen and the lobby.
//
// It is a hex lattice, drifting slowly, with hexes igniting one at a time in
// the Fabricator's blue and fading out. That is not decoration picked at
// random: the world you are about to land on is a hex grid, and fabrication is
// the act of a hex lighting up with something that wasn't there. The menu is
// the machine idling.
//
// Cheap by construction: the lattice is one small tile painted through a
// canvas pattern, so the whole field costs a single fill per frame. Only the
// handful of live ignitions and motes are drawn individually.

/** Lattice geometry. Pointy-top, like the terrain tiles. */
const HEX_W = 48;
const HEX_H = 48;
const ROW_H = HEX_H * 0.75;

/** Drift, in pixels per second. Slow enough to notice only if you look. */
const DRIFT_X = -5;
const DRIFT_Y = -9;

/** Mean seconds between ignitions, and how long one lasts. */
const IGNITE_EVERY = 0.42;
const IGNITE_LIFE = 2.1;
const MAX_IGNITIONS = 22;

const MOTE_COUNT = 26;

type Ignition = { col: number; row: number; age: number; life: number };
type Mote = { x: number; y: number; vy: number; r: number; a: number };

/** Trace a pointy-top hex centred at the origin. */
function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy - h / 4);
  ctx.lineTo(cx + w / 2, cy + h / 4);
  ctx.lineTo(cx, cy + h / 2);
  ctx.lineTo(cx - w / 2, cy + h / 4);
  ctx.lineTo(cx - w / 2, cy - h / 4);
  ctx.closePath();
}

/**
 * A repeating tile of the lattice. Two hexes — one on an even row, one on the
 * staggered odd row below it — tile the plane at HEX_W × 2·ROW_H.
 */
function makeLatticeTile(dpr: number): HTMLCanvasElement {
  const w = HEX_W;
  const h = ROW_H * 2;
  const tile = document.createElement("canvas");
  tile.width = Math.round(w * dpr);
  tile.height = Math.round(h * dpr);
  const ctx = tile.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = "rgba(108, 158, 248, 0.11)";
  ctx.lineWidth = 1;
  // Nine placements: the two lattice hexes plus their wraps across each edge,
  // so the strokes join seamlessly where the tile repeats.
  for (const [ox, oy] of [
    [0, 0],
    [0, ROW_H],
  ]) {
    const sx = oy === 0 ? 0 : HEX_W / 2;
    for (const dx of [-w, 0, w]) {
      for (const dy of [-h, 0, h]) {
        hexPath(ctx, sx + ox + dx, oy + dy, HEX_W, HEX_H);
        ctx.stroke();
      }
    }
  }
  return tile;
}

/**
 * Mount an animated backdrop canvas as the first child of `host`.
 * Returns a stop function; call it when the view is torn down.
 */
export function startBackdrop(host: HTMLElement): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = "backdrop";
  host.prepend(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => canvas.remove();

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const tile = makeLatticeTile(dpr);
  let pattern = ctx.createPattern(tile, "repeat");

  let w = 0;
  let h = 0;
  const resize = () => {
    const rect = host.getBoundingClientRect();
    w = Math.max(1, Math.round(rect.width));
    h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    pattern = ctx.createPattern(tile, "repeat");
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  const ignitions: Ignition[] = [];
  const motes: Mote[] = [];
  for (let i = 0; i < MOTE_COUNT; i++) {
    motes.push({
      x: Math.random(),
      y: Math.random(),
      vy: 6 + Math.random() * 16,
      r: 0.6 + Math.random() * 1.6,
      a: 0.12 + Math.random() * 0.35,
    });
  }

  let offX = 0;
  let offY = 0;
  let nextIgnite = 0;
  let raf = 0;
  let last = performance.now();
  let stopped = false;

  const draw = (dt: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Lattice. Translating the pattern rather than the canvas keeps the
    // ignitions (drawn in the same space) locked to their hexes.
    if (pattern) {
      ctx.save();
      ctx.translate(offX % HEX_W, offY % (ROW_H * 2));
      ctx.fillStyle = pattern;
      ctx.fillRect(-HEX_W, -ROW_H * 2, w + HEX_W * 2, h + ROW_H * 4);
      ctx.restore();
    }

    // Ignitions: a hex fills, brightens, and fades. Positions are in lattice
    // space and inherit the same drift, so one stays on its own hex.
    ctx.save();
    ctx.translate(offX % HEX_W, offY % (ROW_H * 2));
    for (const ig of ignitions) {
      const t = ig.age / ig.life;
      // fast rise, slow fall — the shape of something switching on
      const k = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
      const cx = ig.col * HEX_W + (ig.row % 2 !== 0 ? HEX_W / 2 : 0);
      const cy = ig.row * ROW_H;
      hexPath(ctx, cx, cy, HEX_W - 2, HEX_H - 2);
      ctx.fillStyle = `rgba(108, 158, 248, ${(k * 0.16).toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(150, 194, 255, ${(k * 0.5).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();

    // Motes rising, as if the machine were shedding sparks.
    for (const m of motes) {
      ctx.beginPath();
      ctx.arc(m.x * w, m.y * h, m.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180, 210, 255, ${m.a})`;
      ctx.fill();
    }

    // A soft floor glow: the Fabricator itself, just off the bottom edge.
    const glow = ctx.createRadialGradient(w / 2, h * 1.02, 0, w / 2, h * 1.02, h * 0.7);
    glow.addColorStop(0, "rgba(108, 158, 248, 0.13)");
    glow.addColorStop(1, "rgba(108, 158, 248, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    void dt;
  };

  const frame = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    offX += DRIFT_X * dt;
    offY += DRIFT_Y * dt;

    nextIgnite -= dt;
    if (nextIgnite <= 0 && ignitions.length < MAX_IGNITIONS) {
      nextIgnite = IGNITE_EVERY * (0.4 + Math.random() * 1.5);
      ignitions.push({
        col: Math.floor(Math.random() * (w / HEX_W + 2)) - 1,
        row: Math.floor(Math.random() * (h / ROW_H + 2)) - 1,
        age: 0,
        life: IGNITE_LIFE * (0.7 + Math.random() * 0.7),
      });
    }
    for (let i = ignitions.length - 1; i >= 0; i--) {
      ignitions[i].age += dt;
      if (ignitions[i].age >= ignitions[i].life) ignitions.splice(i, 1);
    }

    for (const m of motes) {
      m.y -= (m.vy / Math.max(1, h)) * dt;
      if (m.y < -0.02) {
        m.y = 1.02;
        m.x = Math.random();
      }
    }

    draw(dt);
    raf = requestAnimationFrame(frame);
  };

  if (reduced) {
    // Still give the page its texture, just none of the movement.
    draw(0);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    observer.disconnect();
    canvas.remove();
  };
}
