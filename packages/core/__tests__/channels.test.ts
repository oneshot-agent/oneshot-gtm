import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  channelAddresses,
  channelOf,
  firstTouchSender,
  isOutreachChannel,
  xHandleFrom,
} from "../src/channels.ts";
import { Ledger } from "../src/ledger.ts";

describe("channel registry", () => {
  it("knows email, linkedin and x", () => {
    expect(isOutreachChannel("linkedin")).toBe(true);
    expect(isOutreachChannel("fax")).toBe(false);
  });

  it("reads anything unknown as email, the column default", () => {
    expect(channelOf("x")).toBe("x");
    expect(channelOf(null)).toBe("email");
    expect(channelOf("fax")).toBe("email");
  });

  it("finds the channels a payload has an address for", () => {
    expect(
      channelAddresses({
        email: "a@x.com",
        linkedinUrl: "https://www.linkedin.com/in/a",
        handle: "a",
      }),
    ).toEqual(["email", "linkedin", "x"]);
    expect(channelAddresses({ linkedinUrl: "https://www.linkedin.com/company/acme" })).toEqual([]);
    expect(channelAddresses({ twitterUrl: "https://x.com/home" })).toEqual([]);
  });

  it("says who sends each first touch today", () => {
    expect(firstTouchSender("email")).toBe("api");
    expect(firstTouchSender("x")).toBe("manual");
    expect(firstTouchSender("linkedin")).toBe("api");
  });
});

let dbPath: string;
beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-channels-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
});
afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("queue channel column", () => {
  it("defaults to email and stores what the finder passes", () => {
    const ledger = new Ledger(dbPath);
    try {
      const email = ledger.enqueueTarget({
        playName: "show-hn",
        payload: {},
        dedupeKey: "a",
        source: "t",
      })!;
      const x = ledger.enqueueTarget({
        playName: "x-amplify-dm",
        payload: {},
        dedupeKey: "b",
        source: "t",
        channel: "x",
      })!;
      expect(ledger.getQueueRow(email)!.channel).toBe("email");
      expect(ledger.getQueueRow(x)!.channel).toBe("x");
    } finally {
      ledger.close();
    }
  });

  it("migration backfills existing X DM rows as channel x", () => {
    new Ledger(dbPath).close();
    const db = new Database(dbPath);
    db.exec("ALTER TABLE target_queue DROP COLUMN channel");
    db.exec("ALTER TABLE draft_versions DROP COLUMN channel");
    db.exec(
      `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source) VALUES
       ('x-amplify-dm', '{}', 'dm', 't'), ('show-hn', '{}', 'hn', 't')`,
    );
    db.exec("PRAGMA user_version = 3");
    db.close();

    const ledger = new Ledger(dbPath);
    try {
      const rows = ledger.listQueue({ limit: 10 });
      const byKey = Object.fromEntries(rows.map((r) => [r.dedupe_key, r.channel]));
      expect(byKey).toEqual({ dm: "x", hn: "email" });
    } finally {
      ledger.close();
    }
  });
});

describe("xHandleFrom", () => {
  it("reads handles and profile URLs, and refuses what isn't a profile", () => {
    expect(xHandleFrom("@dana_lee")).toBe("dana_lee");
    expect(xHandleFrom("https://x.com/dana_lee")).toBe("dana_lee");
    expect(xHandleFrom("https://twitter.com/dana_lee/status/1")).toBe("dana_lee");
    expect(xHandleFrom("https://x.com/home")).toBeNull();
    expect(xHandleFrom("https://x.com/login")).toBeNull();
    expect(xHandleFrom("@notifications")).toBeNull();
    expect(xHandleFrom("https://example.com/dana")).toBeNull();
    expect(xHandleFrom("")).toBeNull();
  });
});
