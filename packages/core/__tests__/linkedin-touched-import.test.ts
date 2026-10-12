import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import {
  importLedgerInvites,
  importTouchedProfiles,
  parseTouchedFile,
  touchedImportSource,
} from "../src/linkedin-touched-import.ts";
import { canInviteOnLinkedIn } from "../src/linkedin-guard.ts";
import { SharedDb } from "../src/shared-db.ts";

describe("parseTouchedFile", () => {
  it("reads a CSV by its url column (any of the three names) and optional touched_at", () => {
    for (const col of ["profile_url", "linkedin_url", "url"]) {
      const rows = parseTouchedFile(
        `name,${col},touched_at\n"Lee, Dana",https://www.linkedin.com/in/dana-lee,2026-09-01T10:00:00Z\nSam,https://www.linkedin.com/in/sam-q,\n`,
      );
      expect(rows).toEqual([
        { url: "https://www.linkedin.com/in/dana-lee", touchedAt: "2026-09-01T10:00:00Z" },
        { url: "https://www.linkedin.com/in/sam-q" },
      ]);
    }
  });

  it("reads a JSON array of strings and { url, touched_at } objects", () => {
    const rows = parseTouchedFile(
      JSON.stringify([
        "https://www.linkedin.com/in/dana-lee",
        { url: "https://www.linkedin.com/in/sam-q", touched_at: "2026-09-01T10:00:00Z" },
        { url: "https://www.linkedin.com/in/no-date" },
      ]),
    );
    expect(rows).toEqual([
      { url: "https://www.linkedin.com/in/dana-lee" },
      { url: "https://www.linkedin.com/in/sam-q", touchedAt: "2026-09-01T10:00:00Z" },
      { url: "https://www.linkedin.com/in/no-date" },
    ]);
  });

  it("refuses a CSV with no url column and JSON that is not an array", () => {
    expect(() => parseTouchedFile("name,email\nA,a@b.co\n")).toThrow(/no URL column/);
    expect(() => parseTouchedFile('{"url":"x"}')).toThrow(/array/);
    expect(() => parseTouchedFile("[not json")).toThrow(/invalid JSON/);
    expect(() => parseTouchedFile("")).toThrow(/empty/);
  });
});

describe("importTouchedProfiles", () => {
  let dir: string;
  let shared: SharedDb;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linkedin-touched-"));
    shared = new SharedDb(join(dir, "shared.sqlite"));
  });
  afterEach(() => {
    shared.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = [
    { url: "https://it.linkedin.com/in/Dana-Lee/?utm=x" },
    { url: "https://www.linkedin.com/in/sam-q/en" },
    { url: "https://x.com/someone" },
    { url: "https://github.com/someone" },
    { url: "not a url" },
    { url: "" },
  ];

  it("normalises country subdomains and locale suffixes, and rejects X, GitHub and junk", () => {
    const r = importTouchedProfiles(shared, rows);
    expect(r.imported).toBe(2);
    expect(r.present).toBe(0);
    expect(r.rejected).toEqual([
      "https://x.com/someone",
      "https://github.com/someone",
      "not a url",
      "",
    ]);
    expect(shared.linkedInTouch("dana-lee")?.source).toBe("import");
    expect(shared.linkedInTouch("sam-q")?.status).toBe("confirmed");
  });

  it("is idempotent: the same file again imports nothing, and a dry run writes nothing", () => {
    const dry = importTouchedProfiles(shared, rows, { dryRun: true });
    expect(dry.imported).toBe(2);
    expect(shared.countLinkedInTouched()).toBe(0);
    expect(importTouchedProfiles(shared, rows).imported).toBe(2);
    const again = importTouchedProfiles(shared, rows);
    expect(again).toMatchObject({ imported: 0, present: 2 });
    expect(shared.countLinkedInTouched()).toBe(2);
  });

  it("keeps an existing record's source and time, and counts a duplicate line once", () => {
    shared.markLinkedInTouched({
      slug: "dana-lee",
      source: "invite:alpha",
      touchedAt: "2026-01-01T00:00:00.000Z",
    });
    const r = importTouchedProfiles(shared, [
      { url: "https://www.linkedin.com/in/dana-lee" },
      { url: "https://www.linkedin.com/in/new-one" },
      { url: "https://www.linkedin.com/in/new-one/" },
    ]);
    expect(r).toMatchObject({ imported: 1, present: 2 });
    expect(shared.linkedInTouch("dana-lee")).toMatchObject({
      source: "invite:alpha",
      touched_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("uses the file's touched_at, the label as the source, and now for a bad date", () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    importTouchedProfiles(
      shared,
      [
        { url: "https://www.linkedin.com/in/a-one", touchedAt: "2026-09-01T10:00:00Z" },
        { url: "https://www.linkedin.com/in/b-two", touchedAt: "yesterday" },
      ],
      { source: "outbound-tool", now },
    );
    expect(shared.linkedInTouch("a-one")).toMatchObject({
      source: "import:outbound-tool",
      touched_at: "2026-09-01T10:00:00.000Z",
    });
    expect(shared.linkedInTouch("b-two")?.touched_at).toBe(now.toISOString());
    expect(touchedImportSource()).toBe("import");
  });

  it("makes the invite guard refuse an imported slug", () => {
    const ledger = new Ledger(join(dir, "ledger.sqlite"));
    try {
      const person = {
        name: "Dana Lee",
        company: "Acme",
        email: "dana@acme.com",
        linkedinUrl: "https://www.linkedin.com/in/dana-lee",
      };
      const deps = {
        ledger,
        shared,
        inbox: { hasConversationWith: () => false },
      };
      expect(canInviteOnLinkedIn(person, deps)).toEqual({ ok: true });
      importTouchedProfiles(shared, [{ url: "https://de.linkedin.com/in/dana-lee/de" }]);
      const v = canInviteOnLinkedIn(person, deps);
      expect(v).toMatchObject({ ok: false, reason: "already-touched" });
    } finally {
      ledger.close();
    }
  });
});

function invite(ledger: Ledger, url: string): void {
  const id = ledger.upsertProspect({
    name: "Dana Lee",
    email: "dana@acme.com",
    company: "Acme",
    linkedin_url: url,
    source: "test",
  });
  ledger.recordLinkedInInviteEvent({
    prospectId: id,
    playName: "luma-events",
    stepIndex: 0,
    status: "sent",
    metadata: { invitationId: "inv-1" },
  });
}

describe("importLedgerInvites (--from-ledgers)", () => {
  let dir: string;
  let shared: SharedDb;
  let prevWs: string | undefined;
  let prevName: string | undefined;
  let alpha: Ledger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linkedin-ledgers-"));
    prevWs = process.env["ONESHOT_GTM_WORKSPACES"];
    prevName = process.env["ONESHOT_GTM_WORKSPACE"];
    const root = join(dir, "ws");
    const alphaHome = join(root, "alpha");
    const betaHome = join(root, "beta");
    mkdirSync(alphaHome, { recursive: true });
    mkdirSync(betaHome, { recursive: true });
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        default: "alpha",
        workspaces: {
          alpha: { home: alphaHome, port: 3031, createdAt: "" },
          beta: { home: betaHome, port: 3032, createdAt: "" },
        },
      }),
    );
    process.env["ONESHOT_GTM_WORKSPACES"] = root;
    process.env["ONESHOT_GTM_WORKSPACE"] = "beta";
    shared = new SharedDb(join(dir, "shared.sqlite"));
    alpha = new Ledger(join(alphaHome, "ledger.sqlite"));
    invite(alpha, "https://www.linkedin.com/in/dana-lee");
    alpha.close();
  });
  afterEach(() => {
    shared.close();
    if (prevWs === undefined) delete process.env["ONESHOT_GTM_WORKSPACES"];
    else process.env["ONESHOT_GTM_WORKSPACES"] = prevWs;
    if (prevName === undefined) delete process.env["ONESHOT_GTM_WORKSPACE"];
    else process.env["ONESHOT_GTM_WORKSPACE"] = prevName;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Counts every handle opened and closed through the seam. */
  function tracked() {
    const state = { opened: 0, closed: 0 };
    const open = (path: string) => {
      state.opened++;
      const db = new Database(path, { readonly: true });
      const close = db.close.bind(db);
      db.close = () => {
        state.closed++;
        close();
      };
      return db;
    };
    return { state, open };
  }

  it("copies another workspace's invite so the guard in this one refuses it", () => {
    const beta = new Ledger(join(dir, "ws", "beta", "ledger.sqlite"));
    try {
      const person = {
        name: "Dana Lee",
        company: "Acme",
        email: "dana@acme.com",
        linkedinUrl: "https://www.linkedin.com/in/dana-lee",
      };
      const deps = { ledger: beta, shared, inbox: { hasConversationWith: () => false } };
      expect(canInviteOnLinkedIn(person, deps)).toEqual({ ok: true });

      const { state, open } = tracked();
      const first = importLedgerInvites(shared, { open });
      expect(first).toEqual([{ workspace: "alpha", imported: 1, present: 0 }]);
      expect(shared.linkedInTouch("dana-lee")?.source).toBe("invite:alpha");
      expect(canInviteOnLinkedIn(person, deps)).toMatchObject({ ok: false });

      const second = importLedgerInvites(shared, { open });
      expect(second).toEqual([{ workspace: "alpha", imported: 0, present: 1 }]);
      // Every connection opened was closed, including on the already-imported run.
      expect(state.opened).toBe(2);
      expect(state.closed).toBe(2);
    } finally {
      beta.close();
    }
  });

  it("writes nothing on a dry run, and closes the ledger when its read fails", () => {
    const { state, open } = tracked();
    expect(importLedgerInvites(shared, { open, dryRun: true })).toEqual([
      { workspace: "alpha", imported: 1, present: 0 },
    ]);
    expect(shared.countLinkedInTouched()).toBe(0);
    expect(state).toEqual({ opened: 1, closed: 1 });

    // A file with no ledger schema: the history query throws after the open.
    const bare = join(dir, "ws", "alpha", "ledger.sqlite");
    rmSync(bare, { force: true });
    rmSync(`${bare}-wal`, { force: true });
    rmSync(`${bare}-shm`, { force: true });
    new Database(bare, { create: true }).close();
    const failing = tracked();
    const out = importLedgerInvites(shared, { open: failing.open });
    expect(out[0]).toMatchObject({ workspace: "alpha", imported: 0, present: 0 });
    expect(out[0]?.error).toBeTruthy();
    expect(failing.state).toEqual({ opened: 1, closed: 1 });
    expect(shared.countLinkedInTouched()).toBe(0);
  });
});
