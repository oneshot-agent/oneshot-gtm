import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSharedDb } from "@oneshot-gtm/core";
import { setJsonMode } from "../src/output.ts";
import { commandWorkspaceOverlaps } from "../src/commands/workspace.ts";

// The shared DB is vitest.setup.ts's temp one.

function cadence(
  workspace: string,
  rows: Array<{ id: number; play: string; email: string | null; slug?: string; status?: string }>,
): void {
  getSharedDb().syncCadencePresence(
    workspace,
    rows.map((r) => ({
      prospectId: r.id,
      playName: r.play,
      email: r.email,
      linkedinUrl: r.slug ? `https://www.linkedin.com/in/${r.slug}` : null,
      status: r.status ?? "active",
    })),
    "all",
  );
}

describe("workspace overlaps", () => {
  let out: string;
  let stdout: string;
  beforeEach(() => {
    process.env["ONESHOT_GTM_WORKSPACE"] = "alpha";
    out = "";
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((
      s: string | Uint8Array,
      cb?: unknown,
    ) => {
      out += String(s);
      stdout += String(s);
      if (typeof cb === "function") cb();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      out += String(s);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
    for (const ws of ["alpha", "beta", "gamma"]) cadence(ws, []);
    delete process.env["ONESHOT_GTM_WORKSPACE"];
  });

  it("lists people live here and elsewhere by play pair, and changes nothing", async () => {
    cadence("alpha", [
      { id: 1, play: "intro", email: "jane@acme.dev" },
      { id: 2, play: "intro", email: null, slug: "sam-roe", status: "paused" },
      { id: 3, play: "intro", email: "solo@acme.dev" },
      { id: 4, play: "intro", email: "done@acme.dev", status: "completed" },
    ]);
    cadence("beta", [
      { id: 10, play: "their-play", email: "jane@acme.dev", status: "paused" },
      { id: 11, play: "their-play", email: "sam@else.example", slug: "sam-roe" },
      { id: 12, play: "their-play", email: "done@acme.dev" },
    ]);
    cadence("gamma", [{ id: 20, play: "ended", email: "solo@acme.dev", status: "replied" }]);
    const before = getSharedDb().cadencePresenceOf("alpha");

    await commandWorkspaceOverlaps({});
    expect(out).toContain("2 people in a live sequence here and in another workspace");
    expect(out).toContain("intro here · beta their-play  2");
    expect(out).toContain("jane@acme.dev  #1 active · there #10 paused");
    expect(out).toContain("linkedin.com/in/sam-roe  #2 paused · there #11 active");
    expect(out).not.toContain("solo@acme.dev");
    expect(out).not.toContain("done@acme.dev");
    expect(getSharedDb().cadencePresenceOf("alpha")).toEqual(before);

    stdout = "";
    await commandWorkspaceOverlaps({ json: true });
    expect(JSON.parse(stdout)).toEqual({
      schemaVersion: 1,
      command: "workspace overlaps",
      workspace: "alpha",
      peopleCount: 2,
      pairs: [
        {
          play: "intro",
          otherWorkspace: "beta",
          otherPlay: "their-play",
          people: [
            {
              prospectId: 1,
              email: "jane@acme.dev",
              linkedinSlug: null,
              status: "active",
              otherProspectId: 10,
              otherStatus: "paused",
            },
            {
              prospectId: 2,
              email: null,
              linkedinSlug: "sam-roe",
              status: "paused",
              otherProspectId: 11,
              otherStatus: "active",
            },
          ],
        },
      ],
    });
  });

  it("says so when there is no overlap", async () => {
    cadence("alpha", [{ id: 1, play: "intro", email: "jane@acme.dev" }]);
    await commandWorkspaceOverlaps({});
    expect(out).toContain("nobody in a live sequence here is in one in another workspace");
  });
});
