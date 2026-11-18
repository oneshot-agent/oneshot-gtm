import { describe, expect, it } from "vitest";
import { WORKSPACE_NAME_PATTERN } from "../src/lib/createWorkspace.ts";

// Browsers compile an input's pattern as ^(?:pattern)$ with the `v` flag.
const browserPattern = () => new RegExp(`^(?:${WORKSPACE_NAME_PATTERN})$`, "v");

describe("workspace name input pattern", () => {
  it("compiles under the v flag, so the browser enforces it", () => {
    expect(browserPattern).not.toThrow();
  });

  it("accepts the names the server accepts and rejects the rest", () => {
    const re = browserPattern();
    for (const name of ["acme", "acme-1", "1a", "a".repeat(32)]) expect(re.test(name)).toBe(true);
    for (const name of ["Acme", "-acme", "a b", "a".repeat(33), "é", ""]) {
      expect(re.test(name), name).toBe(false);
    }
  });
});
