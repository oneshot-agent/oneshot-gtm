import { describe, expect, it } from "vitest";
import { clearRowActivity, rowActivityOf, setRowActivity } from "./rowActivity.ts";

// One label per row, shared by the offer block and the letter; an operation
// clears only the label it set.

describe("rowActivity", () => {
  it("holds a label per row until its operation clears it", () => {
    const a = setRowActivity(7, "Writing 5 offers and their angles…");
    const b = setRowActivity(8, "Switching to offer 2…");
    expect(rowActivityOf(7)).toBe("Writing 5 offers and their angles…");
    setRowActivity(7, "Rewriting the draft around the offer…", a);
    expect(rowActivityOf(7)).toBe("Rewriting the draft around the offer…");
    clearRowActivity(7, a);
    expect(rowActivityOf(7)).toBeNull();
    expect(rowActivityOf(8)).toBe("Switching to offer 2…");
    clearRowActivity(8, b);
  });

  it("a stale operation's cleanup leaves a newer one's label alone", () => {
    const first = setRowActivity(9, "Switching to offer 2…");
    const second = setRowActivity(9, "Switching to offer 3…");
    clearRowActivity(9, first);
    setRowActivity(9, "Rewriting the draft around the offer…", first);
    expect(rowActivityOf(9)).toBe("Switching to offer 3…");
    clearRowActivity(9, second);
    expect(rowActivityOf(9)).toBeNull();
  });
});
