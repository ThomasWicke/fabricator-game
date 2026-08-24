// SPA routing (pong-pilot pattern):
//   /              landing — start a screen or join as controller
//   /screen/CODE   shared screen (Phaser world, host-authoritative sim)
//   /c/CODE        phone controller

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const CODE_LENGTH = 4;

function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function renderLanding() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="landing">
      <h1>UNIVERSAL FABRICATOR</h1>
      <p class="sub">dev shell — shared screen + phone controllers</p>
      <button id="new-screen">Start shared screen</button>
      <div class="divider">or join as a controller</div>
      <form id="join-form" class="join-form">
        <input id="join-code" type="text" inputmode="text" autocapitalize="characters"
               autocomplete="off" spellcheck="false" maxlength="4" placeholder="CODE" />
        <button type="submit">Join</button>
      </form>
    </div>
  `;
  document.getElementById("new-screen")!.addEventListener("click", () => {
    window.location.href = `/screen/${generateCode()}`;
  });
  const codeInput = document.getElementById("join-code") as HTMLInputElement;
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  (document.getElementById("join-form") as HTMLFormElement).addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const code = codeInput.value.trim();
      if (code.length === CODE_LENGTH) {
        window.location.href = `/c/${code.toLowerCase()}`;
      }
    },
  );
}

const screenMatch = window.location.pathname.match(/^\/screen\/([A-Za-z0-9]+)\/?$/);
const controllerMatch = window.location.pathname.match(/^\/c\/([A-Za-z0-9]+)\/?$/);

if (screenMatch) {
  import("./screen/screen").then((m) => m.startScreen(screenMatch[1].toLowerCase()));
} else if (controllerMatch) {
  import("./controller/controller").then((m) =>
    m.startController(controllerMatch[1].toLowerCase()),
  );
} else {
  renderLanding();
}
