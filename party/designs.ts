// The Design store: the Fabricator produces *Designs*, not objects.
//
// A Design is the permanent record of one compiled blueprint — spec, cost,
// and pointers to its art. Manufacturing spends materials to turn a Design
// into a thing in the world, and a Design can be built any number of times.
// The expensive AI work (spec compile + image gen) therefore happens once
// per idea rather than once per object, and players see the cost BEFORE
// they commit resources.
//
// Only METADATA lives here, in Durable Object storage. The images live in
// R2 and are fetched over HTTP by the browser (see worker.ts) — blobs don't
// belong in DO storage, and this way they're cacheable and never travel
// down the WebSocket.
//
// No Workers types in this file: the client imports these types too.

import type { MaterialCost, FabricatedSpec } from "../shared/fabricator/schema";

export type Design = {
  id: string;
  spec: FabricatedSpec;
  createdBy: string;
  createdAt: number;
  timesBuilt: number;
  /** AI body sprite exists at /sprites/body/<id>.png */
  hasBody: boolean;
  /** Player's original sketch at /sprites/sketch/<id>.png — fallback art,
   *  and the seed for a future "modify this design" flow. */
  hasSketch: boolean;
};

/** What phones need: enough to list and price a design. */
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
    hasArt: d.hasBody || d.hasSketch,
  };
}

/** URL for a design's best available art, or undefined if it has none. */
export function designArtUrl(d: Design | DesignSummary): string | undefined {
  if ("hasBody" in d) {
    if (d.hasBody) return `/sprites/body/${d.id}.png`;
    if (d.hasSketch) return `/sprites/sketch/${d.id}.png`;
    return undefined;
  }
  return d.hasArt ? `/sprites/body/${d.id}.png` : undefined;
}

const MAX_DESIGNS = 500;

/** The slice of Durable Object storage this needs — declared locally so the
 *  file stays free of Workers types. */
type StorageLike = {
  put(entries: Record<string, unknown>): Promise<void>;
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
};

export class DesignStore {
  private designs = new Map<string, Design>();
  private loading: Promise<void> | null = null;

  constructor(private storage: StorageLike) {}

  private async ready(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const all = await this.storage.list({ prefix: "d:" });
        for (const value of all.values()) {
          if (value && typeof value === "object") {
            const d = value as Design;
            this.designs.set(d.id, d);
          }
        }
      })();
    }
    return this.loading;
  }

  private persist(d: Design): Promise<void> {
    return this.storage.put({ [`d:${d.id}`]: d });
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

  /** Record that the screen-processed body sprite is now in R2. */
  async markBody(id: string): Promise<Design | null> {
    await this.ready();
    const d = this.designs.get(id);
    if (!d || d.hasBody) return d ?? null;
    d.hasBody = true;
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
