import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPackageVersion } from "../src/version.ts";

describe("readPackageVersion", () => {
  it("reads the caller package's version (../package.json from the file's dir)", () => {
    // This test lives at packages/core/__tests__/, so ../package.json is
    // packages/core/package.json — the same version the helper should return.
    const expected = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }).version;
    expect(readPackageVersion(import.meta.url)).toBe(expected);
  });

  it("falls back to 0.0.0 on an unreadable/garbage url", () => {
    expect(readPackageVersion("file:///nonexistent/deeply/nested/x.ts")).toBe("0.0.0");
  });
});
