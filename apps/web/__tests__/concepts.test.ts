import { describe, expect, it } from "vitest";
import { CONCEPTS, getConcept, PRIORITY_CONCEPTS } from "../src/lib/concepts.ts";

describe("dashboard concept registry", () => {
  it("resolves known concepts and rejects unknown or inherited keys", () => {
    expect(getConcept("rocs")?.href).toBe("https://docs.oneshotagent.com/oneshot-gtm/rocs");
    expect(getConcept("missing")).toBeUndefined();
    expect(getConcept("toString")).toBeUndefined();
  });
  it("supports concepts before a docs page is available", () => {
    expect(
      getConcept("local", { local: { title: "Local", body: "Explanation" } })?.href,
    ).toBeUndefined();
    expect(
      getConcept("local", { local: { title: "Local", body: "Explanation", href: null } })?.href,
    ).toBeNull();
  });
  it("covers all priority components and links only to the GTM docs", () => {
    expect(Object.keys(PRIORITY_CONCEPTS)).toHaveLength(6);
    for (const id of Object.values(PRIORITY_CONCEPTS)) expect(getConcept(id)?.body).toBeTruthy();
    for (const entry of Object.values(CONCEPTS)) {
      expect(entry.title).toBeTruthy();
      expect(entry.body.length).toBeGreaterThan(20);
      expect(new URL(entry.href).origin).toBe("https://docs.oneshotagent.com");
      expect(new URL(entry.href).pathname).toMatch(/^\/oneshot-gtm\/[a-z-]+$/);
    }
  });
});
