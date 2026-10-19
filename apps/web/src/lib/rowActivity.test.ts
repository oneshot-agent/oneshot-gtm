import { describe, expect, it } from "vitest";
import { rowActivityOf, setRowActivity } from "./rowActivity.ts";

// One label per row, shared by the offer block and the letter.

describe("rowActivity", () => {
  it("holds a label per row until it is cleared", () => {
    setRowActivity(7, "Writing 5 offers and their angles…");
    setRowActivity(8, "Switching to offer 2…");
    expect(rowActivityOf(7)).toBe("Writing 5 offers and their angles…");
    setRowActivity(7, "Rewriting the draft around the offer…");
    expect(rowActivityOf(7)).toBe("Rewriting the draft around the offer…");
    setRowActivity(7, null);
    expect(rowActivityOf(7)).toBeNull();
    expect(rowActivityOf(8)).toBe("Switching to offer 2…");
    setRowActivity(8, null);
  });
});
