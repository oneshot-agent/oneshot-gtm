import { describe, expect, it } from "vitest";
import { composeTitle, resolveRouteTitle, SUFFIX } from "../src/lib/documentTitle.ts";

describe("composeTitle", () => {
  it("names the page and the workspace", () => {
    expect(composeTitle("Queue", "sdk")).toBe(`Queue · sdk · ${SUFFIX}`);
  });

  it("drops the default workspace, the way the sidebar dot does", () => {
    expect(composeTitle("Queue", "default")).toBe(`Queue · ${SUFFIX}`);
  });

  it("survives a route with no declared title", () => {
    expect(composeTitle(null, "gtm")).toBe(`gtm · ${SUFFIX}`);
    expect(composeTitle(null, null)).toBe(SUFFIX);
  });

  it("does not render the suffix twice", () => {
    expect(composeTitle(SUFFIX, null)).toBe(SUFFIX);
  });

  it("ignores whitespace-only segments", () => {
    expect(composeTitle("  ", "  ")).toBe(SUFFIX);
  });
});

/** What /run/$playName declares: the useful title is in the params. */
const runTitle = (p: Record<string, string>) => `Run ${p["playName"] ?? ""}`.trim();

describe("resolveRouteTitle", () => {
  it("takes a string", () => {
    expect(resolveRouteTitle("Queue", {})).toBe("Queue");
  });

  it("takes a function of the params, for /run/$playName", () => {
    expect(resolveRouteTitle(runTitle, { playName: "free-pilot" })).toBe("Run free-pilot");
    expect(resolveRouteTitle(runTitle, {})).toBe("Run");
  });

  it("treats an empty or absent title as undeclared", () => {
    expect(resolveRouteTitle(undefined, {})).toBeNull();
    expect(resolveRouteTitle("", {})).toBeNull();
  });
});
