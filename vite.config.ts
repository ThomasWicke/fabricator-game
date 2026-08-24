import { defineConfig } from "vite";

// Ports are env-overridable so a second instance (e.g. a git worktree) can run
// alongside the default one: PORT=5273 PARTYKIT_PORT=2099 npm run dev
const PORT = Number(process.env.PORT) || 5173;
const PARTYKIT_PORT = Number(process.env.PARTYKIT_PORT) || 1999;

export default defineConfig({
  root: "client",
  envDir: "..",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: PORT,
    fs: {
      // Allow importing shared protocol types from ../party.
      allow: [".."],
    },
    // Proxy PartyKit through Vite in dev so the client uses a single origin
    // (port 5173) — avoids iOS Safari's multi-port LAN restrictions and
    // matches the prod path (single host name) more closely.
    proxy: {
      "/parties": {
        target: `http://localhost:${PARTYKIT_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
