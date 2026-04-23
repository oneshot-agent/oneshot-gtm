import { describe, expect, it } from "vitest";
import { loadPrompt } from "../src/prompts.ts";

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
