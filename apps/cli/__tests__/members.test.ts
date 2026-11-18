import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `members` commands against a real shared database on a temp dir: what one
// command writes, the next reads back, and so does a second connection to the
// file, which is how a workspace's server sees it.

const lines: string[] = [];
vi.mock("../src/output.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/output.ts")>("../src/output.ts");
  const say = (s: string) => void lines.push(s);
  return {
    ...actual,
    c: { cyan: (s: string) => s, dim: (s: string) => s, green: (s: string) => s },
    header: say,
    ok: say,
    warn: say,
    note: say,
    bail: (message: string, code = 1): never => {
      lines.push(message);
      throw new actual.CommandExit(code);
    },
  };
});

const { getSharedDb, SharedDb, sharedDbPath } = await import("@oneshot-gtm/core");
const { CommandExit } = await import("../src/output.ts");
const {
  commandMembersAdd,
  commandMembersAllowHost,
  commandMembersDisallowHost,
  commandMembersList,
  commandMembersRemove,
} = await import("../src/commands/members.ts");

const HOST = "gtm-host.tail1234.ts.net";
let dir: string;
let sharedBefore: string | undefined;

beforeEach(() => {
  sharedBefore = process.env["ONESHOT_GTM_SHARED"];
  dir = mkdtempSync(join(tmpdir(), "oneshot-gtm-members-cli-"));
  process.env["ONESHOT_GTM_SHARED"] = dir;
  lines.length = 0;
});
afterEach(() => {
  if (sharedBefore === undefined) delete process.env["ONESHOT_GTM_SHARED"];
  else process.env["ONESHOT_GTM_SHARED"] = sharedBefore;
  getSharedDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("members CLI", () => {
  it("add, list and remove round-trip through the shared database", async () => {
    await commandMembersAdd("Owner@Example.com", { owner: true, name: "Olive Owner" });
    await commandMembersAdd("mia@example.com");
    expect(lines.join("\n")).toContain("added Olive Owner <owner@example.com> as owner");
    expect(lines.join("\n")).toContain("added mia@example.com as member");
    // No host allowed yet: the command says how to allow one.
    expect(lines.join("\n")).toContain("members allow-host");

    // A separate connection, as a workspace's server has.
    const server = new SharedDb(sharedDbPath());
    try {
      expect(server.listMembers().map((m) => [m.email, m.role, m.name])).toEqual([
        ["owner@example.com", "owner", "Olive Owner"],
        ["mia@example.com", "member", null],
      ]);

      lines.length = 0;
      await commandMembersList();
      const listed = lines.join("\n");
      expect(listed).toMatch(/owner@example\.com\s+owner\s+Olive Owner/);
      expect(listed).toMatch(/mia@example\.com\s+member/);
      expect(listed).toContain("Allowed hosts: none");

      await commandMembersRemove("MIA@example.com");
      expect(server.activeMember("mia@example.com")).toBeNull();
      lines.length = 0;
      await commandMembersList();
      expect(lines.join("\n")).not.toContain("mia@example.com");

      // Added again, the member is back, with the role asked for this time.
      await commandMembersAdd("mia@example.com", { owner: true });
      expect(server.activeMember("mia@example.com")?.role).toBe("owner");
    } finally {
      server.close();
    }
  });

  it("allow-host and disallow-host round-trip, in whatever form the host is typed", async () => {
    await commandMembersAllowHost(`https://${HOST.toUpperCase()}:3030/`);
    expect(lines.join("\n")).toContain("No members yet");
    expect(getSharedDb().allowedHosts()).toEqual([HOST]);
    await commandMembersAllowHost(HOST);
    expect(lines.join("\n")).toContain("already allowed");
    expect(getSharedDb().allowedHosts()).toEqual([HOST]);

    lines.length = 0;
    await commandMembersList();
    expect(lines.join("\n")).toContain(`Allowed hosts: ${HOST}`);

    await commandMembersDisallowHost(HOST);
    expect(getSharedDb().allowedHosts()).toEqual([]);
  });

  it("exits nonzero, changing nothing, on a bad email, an unknown member or a host it cannot allow", async () => {
    await expect(commandMembersAdd("not-an-email")).rejects.toBeInstanceOf(CommandExit);
    await expect(commandMembersRemove("nobody@example.com")).rejects.toBeInstanceOf(CommandExit);
    await expect(commandMembersAllowHost("localhost")).rejects.toBeInstanceOf(CommandExit);
    await expect(commandMembersDisallowHost(HOST)).rejects.toBeInstanceOf(CommandExit);
    expect(getSharedDb().listMembers({ includeRemoved: true })).toEqual([]);
    expect(getSharedDb().allowedHosts()).toEqual([]);
  });
});
