import { describe, expect, it } from "vitest";
import { productNameOf } from "../src/product-brief.ts";

describe("productNameOf", () => {
  it("reads the name the one-liner opens with", () => {
    expect(
      productNameOf({
        productOneLiner: "Acme is the scheduling layer for clinics: hand it a list.",
      }),
    ).toBe("Acme");
    expect(productNameOf({ productOneLiner: "Acme brings back patients…" })).toBe("Acme");
    expect(productNameOf({ productOneLiner: "Acme Clinics is the playbook you run." })).toBe(
      "Acme",
    );
    expect(productNameOf({ productOneLiner: "Acme.ai finds leaks." })).toBe("Acme.ai");
  });

  it("is null when the one-liner does not open with a name", () => {
    expect(productNameOf({ productOneLiner: null })).toBeNull();
    expect(productNameOf({ productOneLiner: "" })).toBeNull();
    expect(productNameOf({ productOneLiner: "We help clinics book patients." })).toBeNull();
    expect(productNameOf({ productOneLiner: "A tool for clinics." })).toBeNull();
    expect(productNameOf({ productOneLiner: "helps clinics book patients" })).toBeNull();
  });
});
