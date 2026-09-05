import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Where Add Prospect lives.
 *
 * It used to be the second item in the sidebar, ahead of the Queue and the
 * Replies you read every day, for an act you perform occasionally. It moved to
 * the Queue — the page its result lands on — and the route stayed put so
 * bookmarks and ⌘K still resolve. These are cheap guards on that arrangement,
 * because each half is easy to undo without noticing the other.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p: string): string => readFileSync(join(SRC, p), "utf8");

describe("add-prospect placement", () => {
  it("is not a sidebar destination", () => {
    const nav = read("routes/__root.tsx");
    expect(nav).not.toContain('to: "/add-prospect"');
  });

  it("is an action on the Queue, next to the rows it produces", () => {
    expect(read("routes/queue.tsx")).toContain("AddProspectForm");
  });

  it("is still reachable from the palette", () => {
    expect(read("components/shell/CommandPalette.tsx")).toContain('go("/add-prospect")');
  });

  it("keeps the standalone route, so bookmarks still resolve", () => {
    expect(read("routes/add-prospect.tsx")).toContain('createFileRoute("/add-prospect")');
  });

  it("has one form, not two copies drifting apart", () => {
    // Both entry points render the extracted component; neither builds its own.
    for (const f of ["routes/add-prospect.tsx", "routes/queue.tsx"]) {
      expect(read(f)).not.toContain("api.addProspect");
    }
    expect(read("components/queue/AddProspectForm.tsx")).toContain("api.addProspect");
  });
});
