import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { isGroupOrWorldAccessible, openStateDatabase } from "../src/sqlite-open.ts";
import { Ledger, openLedgerDatabase } from "../src/ledger.ts";
import { SharedDb } from "../src/shared-db.ts";
import { SharedPeople } from "../src/shared-people.ts";
import { ReplyReviewStore } from "../src/reply-review-store.ts";
import { LinkedInInboxStore } from "../src/linkedin-inbox.ts";

// Owner-only state files (#698). Mode bits are synthetic on Windows.
const posix = process.platform !== "win32";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-gtm-sqlite-open-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe.runIf(posix)("openStateDatabase permissions", () => {
  it("creates the file, WAL and SHM owner-only", () => {
    const path = join(dir, "state.sqlite");
    const db = openStateDatabase(path, { busyTimeoutMs: 1000 });
    db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
    for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(mode(file)).toBe(0o600);
    db.close();
  });

  it("creates a missing directory 0700", () => {
    const path = join(dir, "nested", "deeper", "state.sqlite");
    openStateDatabase(path, { busyTimeoutMs: 1000 }).close();
    expect(mode(join(dir, "nested", "deeper"))).toBe(0o700);
    expect(mode(join(dir, "nested"))).toBe(0o700);
  });

  it("heals an existing world-readable file and its SHM on open", () => {
    const path = join(dir, "old.sqlite");
    const legacy = new Database(path);
    legacy.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)");
    legacy.close();
    writeFileSync(`${path}-shm`, "");
    chmodSync(path, 0o644);
    chmodSync(`${path}-shm`, 0o644);

    // Checked while open: on Linux SQLite deletes the -shm when the last
    // connection closes.
    const db = openStateDatabase(path, { busyTimeoutMs: 1000 });
    try {
      expect(mode(path)).toBe(0o600);
      expect(mode(`${path}-shm`)).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it("leaves an existing directory's mode alone", () => {
    chmodSync(dir, 0o755);
    openStateDatabase(join(dir, "state.sqlite"), { busyTimeoutMs: 1000 }).close();
    expect(mode(dir)).toBe(0o755);
  });

  it("every state store opens its file owner-only", () => {
    const paths = {
      ledger: join(dir, "ledger.sqlite"),
      shared: join(dir, "shared.sqlite"),
      people: join(dir, "people.sqlite"),
      review: join(dir, "reply-review.sqlite"),
      linkedin: join(dir, "linkedin-inbox.sqlite"),
    };
    new Ledger(paths.ledger).close();
    new SharedDb(paths.shared).close();
    new SharedPeople(paths.people).close();
    new ReplyReviewStore(paths.review).close();
    new LinkedInInboxStore(paths.linkedin).close();
    for (const path of Object.values(paths)) expect(mode(path)).toBe(0o600);
  });
});

describe("openStateDatabase pragmas", () => {
  it("sets WAL, synchronous=NORMAL, the busy timeout, and foreign keys on request", () => {
    const db = openStateDatabase(join(dir, "p.sqlite"), { busyTimeoutMs: 1234, foreignKeys: true });
    try {
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 1234 });
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });

  it("leaves foreign keys off unless asked", () => {
    const db = openStateDatabase(join(dir, "q.sqlite"), { busyTimeoutMs: 1000 });
    try {
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    } finally {
      db.close();
    }
  });

  it("accepts :memory:", () => {
    const db = openStateDatabase(":memory:", { busyTimeoutMs: 1000 });
    expect(db.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
    db.close();
  });
});

describe("Ledger foreign keys", () => {
  it("rejects a sequence event for a prospect that doesn't exist", () => {
    const ledger = new Ledger(join(dir, "fk.sqlite"));
    try {
      expect(() =>
        ledger.recordSequenceEvent({
          prospectId: 999,
          playName: "p",
          stepIndex: 0,
          channel: "email",
          status: "sent",
        }),
      ).toThrow(/FOREIGN KEY/);
      const id = ledger.upsertProspect({ name: "Ada", email: "ada@x.com", source: "t" });
      expect(() =>
        ledger.recordSequenceEvent({
          prospectId: id,
          playName: "p",
          stepIndex: 0,
          channel: "email",
          status: "sent",
        }),
      ).not.toThrow();
    } finally {
      ledger.close();
    }
  });
});

describe.runIf(posix)("side handles", () => {
  it("a write handle heals an existing ledger's permissions; a read-only one doesn't write", () => {
    const path = join(dir, "ledger.sqlite");
    new Ledger(path).close();
    chmodSync(path, 0o644);
    openLedgerDatabase(path, { readonly: true }).close();
    expect(mode(path)).toBe(0o644);
    const db = openLedgerDatabase(path);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
    expect(mode(path)).toBe(0o600);
  });
});

describe("SharedPeople foreign keys", () => {
  it("rejects an alias for a person that doesn't exist", () => {
    const people = new SharedPeople(join(dir, "people.sqlite"));
    const db = (people as unknown as { db: Database }).db;
    try {
      expect(() =>
        db.query("INSERT INTO person_aliases(alias, person_id) VALUES ('a@x.com', 'nobody')").run(),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      people.close();
    }
  });
});

describe("isGroupOrWorldAccessible", () => {
  it("flags any group or other bit", () => {
    expect(isGroupOrWorldAccessible(0o100600)).toBe(false);
    expect(isGroupOrWorldAccessible(0o100640)).toBe(true);
    expect(isGroupOrWorldAccessible(0o100604)).toBe(true);
  });
});
