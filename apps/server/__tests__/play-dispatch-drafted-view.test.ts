import { describe, expect, it } from "vitest";
import { toDraftedView } from "../src/api/_play-dispatch.ts";

const base = { subject: "s", body: "b", flags: [], receiptIds: [], sent: false };

describe("toDraftedView evidenceClause", () => {
  it("keeps the flag when the draft recorded it, true or false", () => {
    expect(toDraftedView({ ...base, evidenceClause: true }).evidenceClause).toBe(true);
    expect(toDraftedView({ ...base, evidenceClause: false }).evidenceClause).toBe(false);
  });

  it("leaves it absent when the draft did not record it", () => {
    expect("evidenceClause" in toDraftedView(base)).toBe(false);
  });
});
