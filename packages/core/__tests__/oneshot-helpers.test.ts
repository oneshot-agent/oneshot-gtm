import { describe, expect, it } from "vitest";
import { receiptUrlForId } from "../src/oneshot.ts";

describe("receiptUrlForId", () => {
  it("formats a receipt id as a local:// URL", () => {
    expect(receiptUrlForId(1)).toBe("local://receipt/1");
    expect(receiptUrlForId(42)).toBe("local://receipt/42");
    expect(receiptUrlForId(0)).toBe("local://receipt/0");
  });
});
