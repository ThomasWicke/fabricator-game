// The Design store: the Fabricator produces *Designs*, not objects.
//
// A Design is the permanent record of one compiled blueprint — spec, cost,
// generated body sprite. Manufacturing spends materials to turn a Design
// into a thing in the world, and a Design can be built any number of times.
// That means the expensive AI work (spec compile + image gen) happens once
// per idea rather than once per object, and players see the cost BEFORE
// they commit resources.
//
// Persisted in room storage, so the room code is effectively the save game
// (the world seed already derives from it too).

import type { MaterialCost, FabricatedSpec } from "../shared/fabricator/schema";

export type Design = {
  id: string;
  spec: FabricatedSpec;
  createdBy: string;
  createdAt: number;
  timesBuilt: number;
  /** Chroma-keyed body sprite PNG, processed by a screen client. */
  body?: string;
  /** The player's original sketch — fallback art, and the seed for a
   *  future "modify this design" flow. */
  sketch?: string;
};

/** What phones need: enough to list and price a design, no image payload. */
export type DesignSummary = {
  id: string;
  displayName: string;
  category: FabricatedSpec["category"];
  cost: MaterialCost;
  flavor: string;
  createdBy: string;
  createdAt: number;
  timesBuilt: number;
  hasArt: boolean;
};

export function summarize(d: Design): DesignSummary {
  return {
    id: d.id,
    displayName: d.spec.displayName,
    category: d.spec.category,
    cost: d.spec.cost,
    flavor: d.spec.flavor,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    timesBuilt: d.timesBuilt,
    hasArt: !!d.body,
  };
}

/** Durable Object values cap at 128KiB, so images are split across keys. */
const CHUNK = 90_000;
const MAX_DESIGNS = 120;

type StoredMeta = {
  id: string;
  spec: FabricatedSpec;
  createdBy: string;
  createdAt: number;
  timesBuilt: number;
  bodyParts: number;
  sketchParts: number;
};

type StorageLike = {
  get(keys: string[]): Promise<Map<string, unknown>>;
  put(entries: Record<string, unknown>): Promise<void>;
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
};

function chunkEntries(prefix: string, value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (let i = 0; i * CHUNK < value.length; i++) {
    out[`${prefix}:${i}`] = value.slice(i * CHUNK, (i + 1) * CHUNK);
  }
  return out;
}

function partCount(value: string | undefined): number {
  return value ? Math.ceil(value.length / CHUNK) : 0;
}

export class DesignStore {
  private designs = new Map<string, Design>();
  private loading: Promise<void> | null = null;

  constructor(private storage: StorageLike) {}

  private async ready(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const all = await this.storage.list({ prefix: "d:" });
        const metas: StoredMeta[] = [];
        const chunks = new Map<string, string>();
        for (const [key, value] of all) {
          if (key.includes(":b:") || key.includes(":s:")) {
            if (typeof value === "string") chunks.set(key, value);
          } else if (value && typeof value === "object") {
            metas.push(value as StoredMeta);
          }
        }
        const join = (prefix: string, n: number): string | undefined => {
          if (!n) return undefined;
          let out = "";
          for (let i = 0; i < n; i++) {
            const part = chunks.get(`${prefix}:${i}`);
            if (part === undefined) return undefined; // torn write — drop the art
            out += part;
          }
          return out;
        };
        for (const m of metas) {
          this.designs.set(m.id, {
            id: m.id,
            spec: m.spec,
            createdBy: m.createdBy,
            createdAt: m.createdAt,
            timesBuilt: m.timesBuilt,
            body: join(`d:${m.id}:b`, m.bodyParts),
            sketch: join(`d:${m.id}:s`, m.sketchParts),
          });
        }
      })();
    }
    return this.loading;
  }

  private async persist(d: Design): Promise<void> {
    const meta: StoredMeta = {
      id: d.id,
      spec: d.spec,
      createdBy: d.createdBy,
      createdAt: d.createdAt,
      timesBuilt: d.timesBuilt,
      bodyParts: partCount(d.body),
      sketchParts: partCount(d.sketch),
    };
    await this.storage.put({
      [`d:${d.id}`]: meta,
      ...chunkEntries(`d:${d.id}:b`, d.body),
      ...chunkEntries(`d:${d.id}:s`, d.sketch),
    });
  }

  async all(): Promise<Design[]> {
    await this.ready();
    return [...this.designs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<Design | null> {
    await this.ready();
    return this.designs.get(id) ?? null;
  }

  async isFull(): Promise<boolean> {
    await this.ready();
    return this.designs.size >= MAX_DESIGNS;
  }

  async add(d: Design): Promise<void> {
    await this.ready();
    this.designs.set(d.id, d);
    await this.persist(d);
  }

  /** Attach the screen-processed body sprite. Returns the updated design. */
  async setBody(id: string, body: string): Promise<Design | null> {
    await this.ready();
    const d = this.designs.get(id);
    if (!d) return null;
    d.body = body;
    await this.persist(d);
    return d;
  }

  async noteBuilt(id: string): Promise<Design | null> {
    await this.ready();
    const d = this.designs.get(id);
    if (!d) return null;
    d.timesBuilt += 1;
    await this.persist(d);
    return d;
  }
}
