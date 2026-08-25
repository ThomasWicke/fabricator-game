// Every asset the game can ever ask for, checked against a real store.
//
// The grove bug's lesson, made a standing audit: enumerate the keys from the
// same tables the game loads from — never a hand-kept list — and verify each
// one resolves. Two modes:
//
//   npx tsx scripts/audit-assets.ts
//     against the local filesystem (client/public). Also run by npm test.
//
//   npx tsx scripts/audit-assets.ts --url https://fabricator.example.dev
//     against a deployed origin, HEAD per asset — catches files that exist
//     locally but never shipped, which the filesystem check cannot see.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  BIOME_TILE_KEYS,
  DECOR_KEYS,
  LANDMARK_KEYS,
  SCATTER_KEYS,
} from "../client/src/screen/worldgen";
import { ALIEN_FRAMES, ALIEN_SKINS, ENEMY_KEYS } from "../client/src/screen/enemies";

const PUBLIC = fileURLToPath(new URL("../client/public/", import.meta.url));

/** Path under /assets → why the game needs it. Built from the load tables. */
const wanted = new Map<string, string>();
for (const key of new Set([...BIOME_TILE_KEYS, ...DECOR_KEYS, ...SCATTER_KEYS, ...LANDMARK_KEYS])) {
  wanted.set(`assets/hex/${key}.png`, "terrain");
}
for (const key of ENEMY_KEYS) wanted.set(`assets/enemies/${key}.png`, "enemy");
for (const skin of Object.values(ALIEN_SKINS)) {
  for (const f of ALIEN_FRAMES) wanted.set(`assets/aliens/${skin}_${f}.png`, "player");
}

async function main() {
  const urlFlag = process.argv.indexOf("--url");
  const base = urlFlag >= 0 ? process.argv[urlFlag + 1]?.replace(/\/$/, "") : null;

  const missing: string[] = [];
  if (base) {
    // Small parallel batches — enough to finish fast, polite to the worker.
    const paths = [...wanted.keys()];
    for (let i = 0; i < paths.length; i += 10) {
      await Promise.all(
        paths.slice(i, i + 10).map(async (path) => {
          const res = await fetch(`${base}/${path}`, { method: "HEAD" });
          if (!res.ok) missing.push(`${path} → ${res.status}`);
        }),
      );
    }
    console.log(`${wanted.size - missing.length}/${wanted.size} assets reachable at ${base}`);
  } else {
    for (const path of wanted.keys()) {
      if (!existsSync(join(PUBLIC, path))) missing.push(path);
    }
    console.log(`${wanted.size - missing.length}/${wanted.size} assets present in client/public`);
  }

  if (missing.length) {
    console.log("\nMISSING:");
    for (const m of missing) console.log(`  ${m} (${wanted.get(m.split(" ")[0]) ?? "?"})`);
  }
  process.exit(missing.length ? 1 : 0);
}

main();
