import { assert, assertFalse } from "jsr:@std/assert@1";
import { foldsIntoPiece, NEW_PIECE_GAP_MS } from "./piece-heuristic.ts";

const T0 = 1_700_000_000_000;
const soon = T0 + 60_000;

Deno.test("a continuation that grew folds into the same piece", () => {
  assert(foldsIntoPiece("The cat sat", "The cat sat on the mat", T0, soon));
});

Deno.test("unrelated writing opens a new piece", () => {
  assertFalse(foldsIntoPiece("The cat sat", "A different opening", T0, soon));
});

Deno.test("whitespace differences do not split a piece", () => {
  assert(foldsIntoPiece("The cat  sat\n", "The cat sat on the mat", T0, soon));
  assert(foldsIntoPiece("The\ncat\tsat", "The cat sat and stayed", T0, soon));
});

// The reason the check is bidirectional: decay means a run can end shorter
// than the version it carried forward.
Deno.test("a run that lost ground to decay stays in the same piece", () => {
  const before = "One two three four five six";
  const after = "One two three"; // drifted away mid-run
  assert(foldsIntoPiece(before, after, T0, soon));
});

Deno.test("a gap longer than the threshold always opens a new piece", () => {
  const later = T0 + NEW_PIECE_GAP_MS + 1;
  assertFalse(foldsIntoPiece("The cat sat", "The cat sat on the mat", T0, later));
});

Deno.test("a gap just inside the threshold still folds", () => {
  const later = T0 + NEW_PIECE_GAP_MS - 1;
  assert(foldsIntoPiece("The cat sat", "The cat sat on the mat", T0, later));
});

Deno.test("empty text on either side is never a continuation", () => {
  assertFalse(foldsIntoPiece("", "The cat sat", T0, soon));
  assertFalse(foldsIntoPiece("The cat sat", "   \n  ", T0, soon));
});

Deno.test("identical text folds (a re-save is the same piece)", () => {
  assert(foldsIntoPiece("The cat sat", "The cat sat", T0, soon));
});
