// The belt: what a player carries in their hands, and what comes next.
//
// Tiny, and deliberately its own module — world.ts imports Phaser, which
// cannot be loaded in a test runner, and the one piece of this worth testing
// is the index arithmetic. Cycling walks the belt and then passes through
// BARE HANDS before coming back round, which is a real position rather than a
// gap: hands gather wood, stone and food, and a single-ore drill does not, so
// "put the tool away" is a move a player genuinely needs.

/** How many tools one player can carry. Small enough that cycling stays quick
 *  and that choosing what to bring is a decision rather than an inventory. */
export const BELT_MAX = 4;

/** Bare hands — not an absence, a position on the cycle. */
export const HANDS = -1;

/**
 * The next position after `equipped` on a belt holding `count` tools.
 *
 * Positions run 0 … count-1 and then HANDS, so a belt of two cycles
 * 0 → 1 → hands → 0. An empty belt has nowhere to go and stays at HANDS.
 */
export function nextBeltIndex(equipped: number, count: number): number {
  if (count <= 0) return HANDS;
  const next = equipped + 1;
  return next >= count ? HANDS : next;
}
