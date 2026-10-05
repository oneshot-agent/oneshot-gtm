import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { saveConfig, loadConfig } from "../src/config.ts";
import {
  _resetInviteLimitsCacheForTests,
  describeInviteQuota,
  linkedInInviteStatus,
  reserveLinkedInInvite,
} from "../src/linkedin-invite-quota.ts";
import { isSendDeferred } from "../src/send-routing.ts";
import { RESERVATION_TTL_MS, SharedDb } from "../src/shared-db.ts";

const account = (remaining: number | null) => async () => ({
  limits: { invites: { limit: 25, used: 0, pending: 0, remaining, resets_at: null } },
});

function setShare(n: number | undefined): void {
  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    ...(n === undefined ? { linkedin: undefined } : { linkedin: { invitesPerDay: n } }),
  });
}

function freshDb(): SharedDb {
  return new SharedDb(join(mkdtempSync(join(tmpdir(), "invite-slots-")), "shared.sqlite"));
}

beforeEach(() => {
  _resetInviteLimitsCacheForTests();
  setShare(undefined);
});

describe("SharedDb invite slots", () => {
  it("reserves, confirms and releases", () => {
    const db = freshDb();
    const day = new Date().toISOString().slice(0, 10);
    const a = db.reserveInviteSlot({ accountId: "acct", workspace: "w1", limit: 2 });
    expect("id" in a).toBe(true);
    const b = db.reserveInviteSlot({ accountId: "acct", workspace: "w1", limit: 2 });
    expect(db.reserveInviteSlot({ accountId: "acct", workspace: "w1", limit: 2 })).toEqual({
      full: true,
      used: 2,
    });
    if ("id" in a) db.confirmInviteSlot(a.id);
    if ("id" in b) db.releaseInviteSlot(b.id);
    expect(db.inviteSlotsUsed("acct", "w1", day)).toBe(1);
    expect("id" in db.reserveInviteSlot({ accountId: "acct", workspace: "w1", limit: 2 })).toBe(
      true,
    );
  });

  it("never releases a confirmed slot", () => {
    const db = freshDb();
    const day = new Date().toISOString().slice(0, 10);
    const a = db.reserveInviteSlot({ accountId: "acct", workspace: "w1", limit: 5 });
    if (!("id" in a)) throw new Error("expected a slot");
    db.confirmInviteSlot(a.id);
    db.releaseInviteSlot(a.id);
    expect(db.inviteSlotsUsed("acct", "w1", day)).toBe(1);
  });

  it("holds two workspaces sharing one account to their own shares", () => {
    const db = freshDb();
    for (let i = 0; i < 3; i++)
      db.reserveInviteSlot({ accountId: "acct", workspace: "w1", limit: 3 });
    expect("full" in db.reserveInviteSlot({ accountId: "acct", workspace: "w1", limit: 3 })).toBe(
      true,
    );
    for (let i = 0; i < 2; i++) {
      expect("id" in db.reserveInviteSlot({ accountId: "acct", workspace: "w2", limit: 2 })).toBe(
        true,
      );
    }
    expect("full" in db.reserveInviteSlot({ accountId: "acct", workspace: "w2", limit: 2 })).toBe(
      true,
    );
    // A different account is a separate count.
    expect("id" in db.reserveInviteSlot({ accountId: "other", workspace: "w1", limit: 3 })).toBe(
      true,
    );
  });

  it("starts each UTC day from zero and stops counting an orphaned reservation", () => {
    const db = freshDb();
    const t0 = new Date("2026-10-05T12:00:00Z");
    expect(
      "id" in db.reserveInviteSlot({ accountId: "a", workspace: "w", limit: 1, now: t0 }),
    ).toBe(true);
    expect(
      "full" in db.reserveInviteSlot({ accountId: "a", workspace: "w", limit: 1, now: t0 }),
    ).toBe(true);
    // Crash between reserve and confirm: the slot frees after the TTL.
    const later = new Date(t0.getTime() + RESERVATION_TTL_MS + 1000);
    expect(
      "id" in db.reserveInviteSlot({ accountId: "a", workspace: "w", limit: 1, now: later }),
    ).toBe(true);
    // Next UTC day.
    const nextDay = new Date("2026-10-06T00:01:00Z");
    expect(
      "id" in db.reserveInviteSlot({ accountId: "a", workspace: "w", limit: 1, now: nextDay }),
    ).toBe(true);
  });

  it("never exceeds the share under concurrent reservations from separate connections", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "invite-slots-")), "shared.sqlite");
    const dbs = Array.from({ length: 6 }, () => new SharedDb(path));
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        Promise.resolve().then(() =>
          dbs[i % dbs.length]!.reserveInviteSlot({ accountId: "acct", workspace: "w1", limit: 5 }),
        ),
      ),
    );
    expect(results.filter((r) => "id" in r)).toHaveLength(5);
    expect(results.filter((r) => "full" in r)).toHaveLength(25);
  });
});

describe("reserveLinkedInInvite", () => {
  it("lets a send through with no share when the account has invites left", async () => {
    const slot = await reserveLinkedInInvite({ accountId: "acct-free", fetchAccount: account(9) });
    slot.confirm();
  });

  it("defers when the workspace share is used, and a released slot frees it", async () => {
    setShare(1);
    const first = await reserveLinkedInInvite({
      accountId: "acct-share",
      fetchAccount: account(9),
    });
    const err = await reserveLinkedInInvite({
      accountId: "acct-share",
      fetchAccount: account(9),
    }).catch((e: unknown) => e);
    expect(isSendDeferred(err)).toBe(true);
    first.release();
    const again = await reserveLinkedInInvite({
      accountId: "acct-share",
      fetchAccount: account(9),
    });
    again.confirm();
    const afterConfirm = await reserveLinkedInInvite({
      accountId: "acct-share",
      fetchAccount: account(9),
    }).catch((e: unknown) => e);
    expect(isSendDeferred(afterConfirm)).toBe(true);
  });

  it("defers when the account has no invites remaining, without spending a slot", async () => {
    setShare(5);
    const err = await reserveLinkedInInvite({
      accountId: "acct-zero",
      fetchAccount: account(0),
    }).catch((e: unknown) => e);
    expect(isSendDeferred(err)).toBe(true);
    const status = await linkedInInviteStatus("acct-zero", account(0));
    expect(status.used).toBe(0);
  });

  it("falls back to the account cap alone when the account can't be read", async () => {
    const slot = await reserveLinkedInInvite({
      accountId: "acct-err",
      fetchAccount: async () => {
        throw new Error("down");
      },
    });
    slot.release();
  });

  it("refreshes the account position at most every few minutes", async () => {
    let reads = 0;
    const fetchAccount = async () => {
      reads++;
      return account(9)();
    };
    await (await reserveLinkedInInvite({ accountId: "acct-ttl", fetchAccount })).confirm();
    await (await reserveLinkedInInvite({ accountId: "acct-ttl", fetchAccount })).confirm();
    expect(reads).toBe(1);
  });
});

describe("status line", () => {
  it("shows the share and the account position", async () => {
    setShare(12);
    for (let i = 0; i < 8; i++) {
      (await reserveLinkedInInvite({ accountId: "acct-line", fetchAccount: account(9) })).confirm();
    }
    const status = await linkedInInviteStatus("acct-line", account(9));
    expect(describeInviteQuota(status)).toBe(
      "LinkedIn invites today: 4 of 12 left · account 1 left",
    );
  });

  it("shows only the account when no share is set", async () => {
    const status = await linkedInInviteStatus("acct-solo", account(9));
    expect(describeInviteQuota(status)).toBe("LinkedIn invites today: account 9 left");
  });
});
