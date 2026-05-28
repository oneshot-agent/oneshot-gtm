import { describe, expect, it } from "vitest";
import { _resetPromptCache, loadPrompt } from "../src/prompts.ts";

describe("loadPrompt — name validation", () => {
  it("rejects path traversal", () => {
    expect(() => loadPrompt("../secret")).toThrow(/invalid prompt name/);
    expect(() => loadPrompt("../../etc/passwd")).toThrow(/invalid prompt name/);
  });

  it("rejects absolute paths", () => {
    expect(() => loadPrompt("/etc/passwd")).toThrow(/invalid prompt name/);
  });

  it("rejects names with spaces or special chars", () => {
    expect(() => loadPrompt("name with space")).toThrow(/invalid prompt name/);
    expect(() => loadPrompt("name.md")).toThrow(/invalid prompt name/);
    expect(() => loadPrompt("name$bad")).toThrow(/invalid prompt name/);
  });

  it("throws a 'not found' error (not an 'invalid name' error) for valid-format unknown names", () => {
    expect(() => loadPrompt("definitely_not_a_real_prompt_xyz")).toThrow(/prompt not found/);
  });

  it("accepts hyphens, underscores, and digits", () => {
    // All of these will either load (if present) or throw 'not found' — neither throws 'invalid name'.
    const unknowns = ["a-b", "a_b", "prompt123", "P", "x-y_z-1"];
    for (const name of unknowns) {
      try {
        loadPrompt(name);
      } catch (err) {
        expect((err as Error).message).not.toMatch(/invalid prompt name/);
      }
    }
  });

  it("loads a known prompt file and returns its text", () => {
    const body = loadPrompt("icp-filter");
    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("loadPrompt — humanizer inlining", () => {
  it("replaces the [See _humanizer.md ...] reference with the doc's content", () => {
    _resetPromptCache();
    const out = loadPrompt("competitor-switch-email");
    // The bracketed marker line should be gone…
    expect(out).not.toMatch(/^\[See _humanizer\.md/m);
    // …and replaced with the humanizer body (sample a few canonical lines).
    expect(out).toMatch(/Anti-AI-slop rules/);
    expect(out).toMatch(/Banned vocabulary/);
    expect(out).toMatch(/Banned email openers/);
    expect(out).toMatch(/I noticed/);
  });

  it("leaves prompts without a humanizer reference unchanged", () => {
    _resetPromptCache();
    const out = loadPrompt("agent-builder-extract");
    // Sanity: the extract prompt doesn't include any humanizer content.
    expect(out).not.toMatch(/Anti-AI-slop rules/);
    expect(out).not.toMatch(/Banned vocabulary/);
  });

  it("memoizes the humanizer read across calls", () => {
    _resetPromptCache();
    const a = loadPrompt("competitor-switch-email");
    const b = loadPrompt("competitor-switch-email");
    expect(a).toEqual(b);
  });
});
