// Deciding where one piece ends and the next begins.
//
// Kept free of imports and of any database access so it can be tested on its
// own: the sqlite behind main.ts is remote, so this predicate is the only part
// of piece detection that can be checked without a deploy. Both the live save
// path and the one-shot writing_sessions migration call it, which is what
// makes a migrated history and a freshly written one group the same way.

/** A gap this long means you came back to the page rather than kept going. */
export const NEW_PIECE_GAP_MS = 24 * 60 * 60 * 1000;

/** Runs of whitespace collapse, so a reflow or a stray newline is not a break. */
export function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Does `next` continue the same piece as `prev`?
 *
 * The check is deliberately bidirectional, which is a departure from decision 3
 * on dangerous-writing-app-b0y.1 ("next startsWith prev"). This app *removes*
 * text: a run that loses ground to decay ends shorter than the version it
 * carried forward, so a one-way check reports "unrelated" for precisely the
 * case the grouping exists to catch. Save 400 words, keep going, drift down to
 * 350 — one-way, that is a new piece, and a writer who has a bad session gets
 * their work split in two. Treating a truncation as the same piece costs
 * nothing, since both texts are still stored as their own version either way.
 *
 * Revert by dropping the `|| a.startsWith(b)` term.
 */
export function foldsIntoPiece(
  prev: string,
  next: string,
  prevSavedAt: number,
  now: number,
): boolean {
  if (now - prevSavedAt > NEW_PIECE_GAP_MS) return false;
  const a = normalizeForCompare(prev);
  const b = normalizeForCompare(next);
  if (!a || !b) return false;
  return b.startsWith(a) || a.startsWith(b);
}
