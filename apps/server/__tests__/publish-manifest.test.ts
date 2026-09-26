import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The published package installs only `dependencies`. A `workspace:` spec
// there cannot resolve outside this repo, so a fresh `bun x oneshot-gtm-server`
// fails. Workspace packages are bundled by tsdown and belong in devDependencies.
describe("published server manifest", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };

  it("declares no workspace: runtime dependency", () => {
    const workspaceDeps = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) =>
      spec.startsWith("workspace:"),
    );
    expect(workspaceDeps).toEqual([]);
  });

  it("declares every runtime dependency by a registry version", () => {
    for (const spec of Object.values(pkg.dependencies ?? {})) {
      expect(spec).not.toMatch(/^(file:|link:|\.\.?\/)/);
    }
  });
});
