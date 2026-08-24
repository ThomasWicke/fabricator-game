// SPA routing (pong-pilot pattern):
//   /              landing — host a screen or join as a controller
//   /screen/CODE   shared screen (lobby, then the host-authoritative sim)
//   /c/CODE        phone controller (lobby, then the game pad)

import { rememberNickname, resolveIdentity, sanitizeNickname, NICKNAME_MAX } from "./identity";

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
  const identity = resolveIdentity();
  // On a phone, joining is almost always what you want — lead with it.
  const phoneFirst =
    window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 820;

  const hostCard = `
    <section class="card" id="host-card">
      <h2>Host</h2>
      <p>Run the world on <b>this</b> device — a TV or laptop everyone can see.
         Phones join as controllers.</p>
      <button id="new-screen">Open a lobby</button>
    </section>
  `;
  const joinCard = `
    <section class="card" id="join-card">
      <h2>Join</h2>
      <p>Turn this phone into a controller. Get the 4-letter code from the big
         screen.</p>
      <form id="join-form" class="join-form">
        <input id="join-name" type="text" maxlength="${NICKNAME_MAX}" placeholder="Your name"
               autocomplete="nickname" autocapitalize="words" spellcheck="false" />
        <div class="join-row">
          <input id="join-code" type="text" inputmode="text" autocapitalize="characters"
                 autocomplete="off" spellcheck="false" maxlength="4" placeholder="CODE" />
          <button type="submit" id="join-btn" disabled>Join</button>
        </div>
      </form>
    </section>
  `;

  app.innerHTML = `
    <div class="landing">
      <h1>UNIVERSAL FABRICATOR</h1>
      <p class="sub">co-op prototype · one shared screen, one phone per player</p>
      <div class="cards">
        ${phoneFirst ? joinCard + hostCard : hostCard + joinCard}
      </div>
      <p class="foot-note">Two players. Sketch an invention on your phone and the
        Fabricator builds it into the world.</p>
    </div>
  `;

  const nameInput = document.getElementById("join-name") as HTMLInputElement;
  nameInput.value = identity.nickname;
  nameInput.addEventListener("input", () => {
    const clean = sanitizeNickname(nameInput.value);
    if (clean !== nameInput.value) nameInput.value = clean;
    rememberNickname(clean);
  });

  document.getElementById("new-screen")!.addEventListener("click", () => {
    window.location.href = `/screen/${generateCode()}`;
  });

  const codeInput = document.getElementById("join-code") as HTMLInputElement;
  const joinBtn = document.getElementById("join-btn") as HTMLButtonElement;
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    joinBtn.disabled = codeInput.value.length !== CODE_LENGTH;
  });
  (document.getElementById("join-form") as HTMLFormElement).addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const code = codeInput.value.trim();
      if (code.length !== CODE_LENGTH) {
        codeInput.focus();
        return;
      }
      rememberNickname(nameInput.value);
      window.location.href = `/c/${code.toLowerCase()}`;
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
