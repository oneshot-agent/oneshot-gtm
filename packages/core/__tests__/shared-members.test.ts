import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeAllowedHost, normalizeMemberEmail, SharedDb } from "../src/shared-db.ts";

// Members and allowed hosts live in the shared database so that every
// workspace's server, each with its own connection to the file, agrees.

let dir: string;
let db: SharedDb;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-members-"));
  db = new SharedDb(join(dir, "s.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("members", () => {
  it("stores the email lowercased and keeps one row per email", () => {
    const first = db.addMember({ email: " Ana@Example.COM ", name: "Ana", role: "member" });
    expect(first.outcome).toBe("added");
    expect(first.member).toMatchObject({ email: "ana@example.com", name: "Ana", role: "member" });
    expect(first.member.removed_at).toBeNull();

    // The same person again: the row is kept, the role is what was asked, the name stays.
    const again = db.addMember({ email: "ANA@example.com", role: "owner" });
    expect(again.outcome).toBe("updated");
    expect(again.member.id).toBe(first.member.id);
    expect(again.member).toMatchObject({ name: "Ana", role: "owner" });
    expect(db.listMembers()).toHaveLength(1);
    expect(db.activeMember("Ana@Example.com")?.id).toBe(first.member.id);
  });

  it("a removed member reads as nobody until added back", () => {
    db.addMember({ email: "ana@example.com", role: "member" });
    expect(db.removeMember("Ana@example.com")).toBe(true);
    expect(db.removeMember("ana@example.com")).toBe(false);
    expect(db.activeMember("ana@example.com")).toBeNull();
    expect(db.listMembers()).toEqual([]);
    expect(db.listMembers({ includeRemoved: true })[0]!.removed_at).not.toBeNull();

    expect(db.addMember({ email: "ana@example.com", role: "member" }).outcome).toBe("restored");
    expect(db.activeMember("ana@example.com")?.removed_at).toBeNull();
    expect(db.removeMember("nobody@example.com")).toBe(false);
  });

  it("names the owner added first, and nobody once no active owner is left", () => {
    expect(db.ownerMember()).toBeNull();
    db.addMember({ email: "mia@example.com", role: "member" });
    expect(db.ownerMember()).toBeNull();
    db.addMember({ email: "first@example.com", role: "owner" });
    db.addMember({ email: "second@example.com", role: "owner" });
    expect(db.ownerMember()?.email).toBe("first@example.com");
    db.removeMember("first@example.com");
    expect(db.ownerMember()?.email).toBe("second@example.com");
  });

  it("refuses what is not an email", () => {
    for (const bad of ["", "   ", "no-at-sign", "two words@example.com", "@example.com"]) {
      expect(normalizeMemberEmail(bad)).toBeNull();
      expect(() => db.addMember({ email: bad, role: "member" })).toThrow(/Not an email/);
      expect(db.activeMember(bad)).toBeNull();
    }
    expect(db.listMembers({ includeRemoved: true })).toEqual([]);
    // A Tailscale login need not be a mailbox: GitHub sign-ins look like this.
    expect(normalizeMemberEmail("Ana@github")).toBe("ana@github");
  });

  it("another connection to the same file sees the same members and hosts", () => {
    db.addMember({ email: "ana@example.com", role: "owner" });
    db.allowHost("gtm-host.tail1234.ts.net");
    const other = new SharedDb(join(dir, "s.sqlite"));
    try {
      expect(other.activeMember("ana@example.com")?.role).toBe("owner");
      expect(other.isAllowedHost("gtm-host.tail1234.ts.net")).toBe(true);
      expect(() => other.removeMember("ana@example.com")).toThrow(/last owner/);
      expect(() => other.addMember({ email: "ana@example.com", role: "member" })).toThrow(
        /last owner/,
      );
      expect(db.activeMember("ana@example.com")?.role).toBe("owner");
      db.addMember({ email: "backup@example.com", role: "owner" });
      other.removeMember("ana@example.com");
      other.disallowHost("gtm-host.tail1234.ts.net");
      expect(db.activeMember("ana@example.com")).toBeNull();
      expect(db.isAllowedHost("gtm-host.tail1234.ts.net")).toBe(false);
    } finally {
      other.close();
    }
  });
});

describe("allowed hosts", () => {
  it("stores the bare hostname whatever form it was typed in", () => {
    expect(normalizeAllowedHost("https://GTM-Host.Tail1234.ts.net:4031/queue?x=1")).toBe(
      "gtm-host.tail1234.ts.net",
    );
    expect(normalizeAllowedHost("gtm-host.tail1234.ts.net.")).toBe("gtm-host.tail1234.ts.net");
    expect(normalizeAllowedHost("100.64.0.7:3030")).toBe("100.64.0.7");

    expect(db.allowHost("https://GTM-Host.Tail1234.ts.net:4031/")).toBe(true);
    expect(db.allowHost("gtm-host.tail1234.ts.net")).toBe(false);
    expect(db.allowedHosts()).toEqual(["gtm-host.tail1234.ts.net"]);
    expect(db.isAllowedHost("GTM-HOST.tail1234.ts.net")).toBe(true);
    expect(db.isAllowedHost("other.tail1234.ts.net")).toBe(false);

    expect(db.disallowHost("gtm-host.tail1234.ts.net:3030")).toBe(true);
    expect(db.disallowHost("gtm-host.tail1234.ts.net")).toBe(false);
    expect(db.allowedHosts()).toEqual([]);
  });

  it("refuses loopback names and what is not a hostname", () => {
    for (const bad of [
      "",
      "localhost",
      "127.0.0.1:3030",
      "http://localhost:3030",
      "a b",
      "*",
      "-x.example",
    ]) {
      expect(normalizeAllowedHost(bad)).toBeNull();
      expect(() => db.allowHost(bad)).toThrow(/Not a hostname/);
      expect(db.isAllowedHost(bad)).toBe(false);
    }
    expect(db.allowedHosts()).toEqual([]);
  });

  it("refuses a line break wherever it sits", () => {
    for (const bad of [
      "gtm-host.ts.net\nother.ts.net",
      "gtm-host.ts.net/queue\nx",
      "gtm-host.ts.net/a\nb/c",
      "gtm-host.ts.net\r\n/queue",
      "gtm-host.ts.net/queue\u2028x",
      "gtm-host.ts.net#a\u2029b",
    ]) {
      expect(normalizeAllowedHost(bad)).toBeNull();
      expect(db.isAllowedHost(bad)).toBe(false);
    }
    // Spaces and tabs after the hostname are part of the path, as before.
    expect(normalizeAllowedHost("gtm-host.ts.net/a b\tc")).toBe("gtm-host.ts.net");
  });

  it("normalizes a long input of path characters in linear time", () => {
    // Each `#` used to start a scan that ran to the line break and failed:
    // 80,000 of them took 5.5s, and this many took over 30s.
    const long = `${"#".repeat(200_000)}\nx`;
    const started = performance.now();
    expect(normalizeAllowedHost(long)).toBeNull();
    expect(normalizeAllowedHost(`gtm-host.ts.net${"#".repeat(200_000)}`)).toBe("gtm-host.ts.net");
    expect(normalizeAllowedHost(`${"/".repeat(200_000)}x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
