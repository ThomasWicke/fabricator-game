// Hex grid math for the Kenney iso-hex tiles. Odd-r offset coordinates.
//
// Measured from the art (alpha-scan of tileGrass.png, 65×89): the top face
// is a 65×64 iso-squashed pointy-top hex (top vertex y=0, left edge
// y=16..48), and below it hangs a 25px 3D slab side. With ROW_H = 0.75×64
// = 48, each row's top faces exactly cover the slab sides of the row above,
// so the ground reads flat and the slab only shows at the map's southern
// edge. (Getting ROW_H wrong exposes a strip of side on every row and the
// whole world reads as an incline.)
//
// The world plays in continuous pixels — players and vehicles move freely —
// but terrain lookup, structure placement, and (future) edge connections
// are hexagonal. NEIGHBORS gives the 6 adjacent hexes, which is the
// foundation for connecting fabricated objects into production lines.

export const HEX_W = 65; // point-to-point width of the top face
export const HEX_TOP_H = 64; // height of the top face (iso-squashed)
export const HEX_IMG_H = 89; // full tile image incl. the 25px slab side
export const ROW_H = 48; // vertical distance between row centers (0.75 × top)

/** Chunk dimensions live HERE, in the Phaser-free module, so the coverage
 *  arithmetic — which pixels of which tiles land in which chunk — can be
 *  proven by a test that runs in node. It was reasoned about in a comment
 *  instead, and the comment was wrong: it predated raised ground and nobody
 *  re-derived it when drop went negative. */
export const CHUNK_COLS = 10;
export const CHUNK_ROWS = 12;
export const CHUNK_W = CHUNK_COLS * HEX_W; // 650
export const CHUNK_H = CHUNK_ROWS * ROW_H; // 576

export type HexCoord = { col: number; row: number };

/**
 * The top face's six corners, relative to the hex centre. An iso-squashed
 * pointy-top hex: tips at top and bottom, vertical sides spanning the middle
 * half of its height. Used to outline the hex under a structure you're about
 * to place.
 */
export const HEX_POINTS: [number, number][] = [
  [0, -HEX_TOP_H / 2],
  [HEX_W / 2, -HEX_TOP_H / 4],
  [HEX_W / 2, HEX_TOP_H / 4],
  [0, HEX_TOP_H / 2],
  [-HEX_W / 2, HEX_TOP_H / 4],
  [-HEX_W / 2, -HEX_TOP_H / 4],
];

/** Center of a hex in world pixels. Odd rows shift right by half a tile. */
export function hexToWorld(col: number, row: number): { x: number; y: number } {
  const x = col * HEX_W + (row % 2 !== 0 ? HEX_W / 2 : 0) + HEX_W / 2;
  const y = row * ROW_H + HEX_TOP_H / 2;
  return { x, y };
}

/** Top-left corner for stamping the 65×89 tile image of a hex. */
export function hexImageTopLeft(col: number, row: number): { x: number; y: number } {
  const c = hexToWorld(col, row);
  return { x: c.x - HEX_W / 2, y: c.y - HEX_TOP_H / 2 };
}

/**
 * Nearest hex to a world point. Uses the row/col estimate then checks the
 * neighborhood by true distance — robust at the staggered edges without
 * cube-coordinate rounding.
 *
 * The world is unbounded in both axes (negative coordinates are ordinary), so
 * this never clamps: there is no edge of the map to fall off.
 */
export function worldToHex(x: number, y: number): HexCoord {
  const rowGuess = Math.round((y - HEX_TOP_H / 2) / ROW_H);
  let best: HexCoord = { col: 0, row: 0 };
  let bestDist = Infinity;
  for (let row = rowGuess - 1; row <= rowGuess + 1; row++) {
    const offset = row % 2 !== 0 ? HEX_W / 2 : 0;
    const colGuess = Math.round((x - offset - HEX_W / 2) / HEX_W);
    for (let col = colGuess - 1; col <= colGuess + 1; col++) {
      const c = hexToWorld(col, row);
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { col, row };
      }
    }
  }
  return best;
}

/** The 6 neighbors of a hex (odd-r offset layout), clockwise from east. */
export function neighbors({ col, row }: HexCoord): HexCoord[] {
  const odd = row % 2 !== 0;
  return [
    { col: col + 1, row },
    { col: col + (odd ? 1 : 0), row: row + 1 },
    { col: col + (odd ? 0 : -1), row: row + 1 },
    { col: col - 1, row },
    { col: col + (odd ? 0 : -1), row: row - 1 },
    { col: col + (odd ? 1 : 0), row: row - 1 },
  ];
}
