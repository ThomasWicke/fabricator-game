// Shared-screen shell: boots Phaser, shows the join QR until both
// controllers are in, and feeds relayed controller inputs into the world.

import Phaser from "phaser";
import QRCode from "qrcode";
import { resolveIdentity } from "../identity";
import { RoomConnection } from "../socket";
import { keepScreenAwake } from "../wake-lock";
import { WorldScene } from "./world";
import type { Slot } from "../../../party/protocol";

export function startScreen(code: string) {
  const upperCode = code.toUpperCase();
  const controllerUrl = `${window.location.origin}/c/${code}`;

  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="screen">
      <div class="screen-stage" id="stage">
        <div class="split-divider"></div>
        <div class="qr-overlay" id="qr-overlay">
          <div class="label">scan with both phones to join · or enter code at ${window.location.origin}</div>
          <div class="code">${upperCode}</div>
          <canvas id="qr-canvas"></canvas>
          <div class="url">${controllerUrl}</div>
          <button class="dismiss" id="qr-dismiss">hide (keyboard: P1 WASD+F/G · P2 arrows+K/L)</button>
        </div>
      </div>
      <div class="screen-hud">
        <span class="code">ROOM ${upperCode}</span>
        <span class="chip p1" id="chip-p1"><span class="dot"></span><span id="chip-p1-text">P1 — waiting</span></span>
        <span class="chip p2" id="chip-p2"><span class="dot"></span><span id="chip-p2-text">P2 — waiting</span></span>
        <span class="spacer"></span>
        <span class="hint" id="conn-status">connecting…</span>
      </div>
    </div>
  `;

  const qrOverlay = document.getElementById("qr-overlay")!;
  const statusEl = document.getElementById("conn-status")!;
  QRCode.toCanvas(
    document.getElementById("qr-canvas") as HTMLCanvasElement,
    controllerUrl,
    { width: 200, margin: 1 },
  ).catch(() => {});

  document.getElementById("qr-dismiss")!.addEventListener("click", () => {
    qrOverlay.classList.add("hidden");
    dismissed = true;
  });
  let dismissed = false;

  keepScreenAwake();

  // ── Phaser ──────────────────────────────────────────────────
  // Boot only once the stage has settled to a real size (flex layout can
  // still be 0×N when this module runs, which breaks WebGL framebuffers),
  // then track the stage with a ResizeObserver — window-resize events alone
  // don't cover in-page layout changes (e.g. inside the test-harness iframe).
  const scene = new WorldScene();
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
      physics: {
        default: "arcade",
        arcade: { debug: false },
      },
      scene: [],
      callbacks: {
        postBoot: (g) => {
          g.scene.add("world", scene, true, { seed: code });
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

  // ── networking ──────────────────────────────────────────────
  const conn = new RoomConnection(code, "screen", resolveIdentity(), {
    onStatus: (s) => {
      statusEl.textContent =
        s === "open" ? "online" : s === "connecting" ? "connecting…" : "reconnecting…";
    },
    onMessage: (msg) => {
      if (msg.scope === "input" && msg.type === "input") {
        scene.setInput(msg.slot, { stick: msg.stick, buttons: msg.buttons });
        return;
      }
      if (msg.scope === "ui") {
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
      if (msg.scope === "presence" && msg.type === "roster") {
        const bySlot = new Map<Slot, { nickname: string; connected: boolean }>();
        for (const p of msg.players) {
          if (p.slot) bySlot.set(p.slot, p);
        }
        for (const slot of [1, 2] as const) {
          const chip = document.getElementById(`chip-p${slot}`)!;
          const text = document.getElementById(`chip-p${slot}-text`)!;
          const p = bySlot.get(slot);
          if (p?.connected) {
            chip.classList.add("on");
            text.textContent = p.nickname || `P${slot}`;
            scene.setNickname(slot, p.nickname);
          } else if (p) {
            chip.classList.remove("on");
            text.textContent = `${p.nickname || `P${slot}`} — offline`;
          } else {
            chip.classList.remove("on");
            text.textContent = `P${slot} — waiting`;
          }
        }
        const bothIn = bySlot.get(1)?.connected && bySlot.get(2)?.connected;
        if (bothIn) qrOverlay.classList.add("hidden");
        else if (!dismissed) qrOverlay.classList.remove("hidden");
      }
    },
  });
  void conn;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Transient message strip over the game (fabrication results/errors). */
function toast(text: string) {
  let el = document.getElementById("screen-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "screen-toast";
    el.style.cssText =
      "position:absolute;left:50%;bottom:14px;transform:translateX(-50%);" +
      "background:rgba(10,14,20,0.9);color:#dfe8f4;padding:8px 16px;" +
      "border-radius:10px;font-size:13px;z-index:20;max-width:80%;text-align:center;";
    document.getElementById("stage")!.appendChild(el);
  }
  el.textContent = text;
  el.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el!.style.display = "none";
  }, 6000);
}
