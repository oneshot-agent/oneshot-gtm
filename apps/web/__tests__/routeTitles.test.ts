import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every route declares a tab title. Without this a new route silently inherits
 * the bare suffix, which is the state the whole app was in before.
 */
const ROUTES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");

describe("route titles", () => {
  const files = readdirSync(ROUTES).filter((f) => f.endsWith(".tsx") && f !== "__root.tsx");

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)("%s declares staticData.title", (file) => {
    expect(readFileSync(join(ROUTES, file), "utf8")).toMatch(/staticData:\s*\{\s*title:/);
  });
});
