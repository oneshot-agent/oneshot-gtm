import { describe, expect, it } from "vitest";
import { workspaceHue } from "../src/lib/workspaceHue.ts";
import { ACCENT_HEX, hueToHex, tintSvg } from "../src/lib/favicon.ts";

describe("workspaceHue", () => {
  it("is deterministic, so gtm always looks like gtm", () => {
    expect(workspaceHue("gtm")).toBe(workspaceHue("gtm"));
  });

  it("separates the workspaces actually in use", () => {
    expect(workspaceHue("gtm")).not.toBe(workspaceHue("sdk"));
  });

  it("stays a legal hue", () => {
    for (const n of ["", "a", "default", "sdk", "a-very-long-workspace-name"]) {
      const h = workspaceHue(n);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("hueToHex", () => {
  it("returns an sRGB hex", () => {
    expect(hueToHex(workspaceHue("sdk"))).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("tracks the hue — two workspaces do not collapse to one colour", () => {
    expect(hueToHex(workspaceHue("gtm"))).not.toBe(hueToHex(workspaceHue("sdk")));
  });
});

describe("tintSvg", () => {
  it("replaces the accent and leaves the rest of the mark alone", () => {
    const svg = `<svg><rect fill="#f5f1ea"/><rect fill="${ACCENT_HEX}"/></svg>`;
    const out = tintSvg(svg, workspaceHue("sdk"));
    expect(out).not.toContain(ACCENT_HEX);
    expect(out).toContain('fill="#f5f1ea"');
  });
});
