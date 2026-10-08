import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import type { EmailIdentity, OneShotConfig } from "../src/types.ts";

// Issue #794: the capacity picker reserves a slot under BEGIN IMMEDIATE, so
// concurrent sends can't all read the same `remaining`. Real on-disk ledger
// (reservations are SQL), mocked config, stubbed Gmail transport with a delay.
let dbPath: string;
let ledger: Ledger;
let mockCfg: Partial<OneShotConfig>;
let sendDelayMs = 0;
let failSends = false;

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...mockCfg }),
    loadGmailTokens: () => ({
      "gmail:a@x.com": { refreshToken: "rt-a", address: "a@x.com" },
      "gmail:b@x.com": { refreshToken: "rt-b", address: "b@x.com" },
    }),
  };
});

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return { ...actual, getLedger: () => ledger };
});

const { sendEmail } = await import("../src/oneshot.ts");
const {
  SendDeferredError,
  resolveSenderIdentity,
  resolveSenderSlot,
  releaseSendReservation,
  identityCapacities,
  poolSendCapacity,
  hasAnySendCapacity,
  remainingToday,
} = await import("../src/send-routing.ts");
const { _resetGmailCache } = await import("../src/gmail.ts");

function gmail(addr: string, cap: number): EmailIdentity {
  return {
    id: `gmail:${addr}`,
    provider: "gmail",
    address: addr,
    maxPerDay: cap,
    warmup: null,
  };
}

function oneshot(id: string, domain: string, cap: number): EmailIdentity {
  return {
    id,
    provider: "oneshot",
    sendingDomain: domain,
    maxPerDay: cap,
    warmup: null,
  };
}

let sentCount = 0;
function stubGmail() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (new URL(u).hostname === "oauth2.googleapis.com") {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (u.endsWith("/profile")) {
        return new Response(JSON.stringify({ emailAddress: "a@x.com" }), { status: 200 });
      }
      if (u.endsWith("/messages/send")) {
        if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
        if (failSends) return new Response("bad request", { status: 400 });
        sentCount++;
        return new Response(JSON.stringify({ id: `gm-${sentCount}`, threadId: "th" }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

const email = (n: number) => ({ to: `p${n}@acme.com`, subject: `s${n}`, body: `b${n}` });
const ctx = { playName: "test-play" };

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-reserve-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  mockCfg = { emailProvider: "gmail", emailIdentities: [gmail("a@x.com", 3)] };
  sendDelayMs = 0;
  failSends = false;
  sentCount = 0;
  process.env["GMAIL_CLIENT_ID"] = "test";
  process.env["GMAIL_CLIENT_SECRET"] = "test";
  _resetGmailCache();
  stubGmail();
});

afterEach(() => {
  vi.unstubAllGlobals();
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("concurrent sends against one identity", () => {
  it("sends exactly `remaining` and defers the rest with SendDeferredError", async () => {
    sendDelayMs = 30;
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => sendEmail(email(n), ctx)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SendDeferredError);
    }
    expect(sentCount).toBe(3);
    // Confirmed once each: 3 receipts, no leftover reservations, view at cap.
    expect(ledger.countEmailSendsSince("gmail:a@x.com", "2000-01-01 00:00:00")).toBe(3);
    expect(ledger.liveSendReservations().byGroup.size).toBe(0);
    expect(identityCapacities().get("gmail:a@x.com")).toMatchObject({
      capToday: 3,
      domainSentToday: 3,
      remaining: 0,
    });
  });
});

describe("reservation lifecycle", () => {
  it("a failed send releases its reservation", async () => {
    failSends = true;
    await expect(sendEmail(email(1), ctx)).rejects.toThrow();
    expect(ledger.liveSendReservations().byGroup.size).toBe(0);
    expect(remainingToday(mockCfg.emailIdentities![0]!)).toBe(3);
  });

  it("a deferred pick holds nothing and a released slot frees capacity", () => {
    const slots = [1, 2, 3].map((n) => resolveSenderSlot(`q${n}@acme.com`));
    expect(slots.every((s) => s.reservationId != null)).toBe(true);
    expect(() => resolveSenderIdentity("q4@acme.com")).toThrow(SendDeferredError);
    expect(hasAnySendCapacity()).toBe(false);
    releaseSendReservation(slots[0]!.reservationId);
    expect(hasAnySendCapacity()).toBe(true);
    expect(resolveSenderSlot("q5@acme.com").reservationId).not.toBeNull();
  });

  it("an expired reservation stops counting", () => {
    const id = gmail("a@x.com", 3).id;
    const t0 = new Date("2026-06-12T12:00:00Z");
    ledger.reserveSendSlot(`id:${id}`, id, t0);
    const within = new Date(t0.getTime() + 9 * 60 * 1000);
    const after = new Date(t0.getTime() + 11 * 60 * 1000);
    expect(ledger.liveSendReservations(within).byGroup.get(`id:${id}`)).toBe(1);
    expect(ledger.liveSendReservations(after).byGroup.size).toBe(0);
    expect(identityCapacities(after).get(id)!.remaining).toBe(3);
    expect(identityCapacities(within).get(id)!.remaining).toBe(2);
  });

  it("a confirmed send is counted exactly once (receipt, not receipt + reservation)", async () => {
    const out = await sendEmail(email(1), ctx);
    expect(out.receiptId).toBeGreaterThan(0);
    const view = identityCapacities().get("gmail:a@x.com")!;
    expect(view.domainSentToday).toBe(1);
    expect(view.identitySentToday).toBe(1);
    expect(view.remaining).toBe(2);
    expect(poolSendCapacity()).toEqual({ sentToday: 1, capToday: 3 });
  });

  it("recordReceipt consumes the reservation it is handed, even on an idempotent replay", () => {
    const id = "gmail:a@x.com";
    const r1 = ledger.reserveSendSlot(`id:${id}`, id);
    ledger.recordReceipt({
      playName: "p",
      callType: "email.send",
      senderIdentity: id,
      oneshotRequestId: "m-1",
      reservationId: r1,
    });
    expect(ledger.liveSendReservations().byGroup.size).toBe(0);
    const r2 = ledger.reserveSendSlot(`id:${id}`, id);
    ledger.recordReceipt({
      playName: "p",
      callType: "email.send",
      senderIdentity: id,
      oneshotRequestId: "m-1",
      reservationId: r2,
    });
    expect(ledger.liveSendReservations().byGroup.size).toBe(0);
    expect(ledger.countEmailSendsSince(id, "2000-01-01 00:00:00")).toBe(1);
  });
});

describe("cap groups", () => {
  it("one-domain OneShot identities share one reservation pool", () => {
    const a = oneshot("os-a", "shared.example", 2);
    const b = oneshot("os-b", "shared.example", 2);
    mockCfg = { emailProvider: "oneshot", emailIdentities: [a, b] };
    resolveSenderSlot("x1@acme.com");
    resolveSenderSlot("x2@acme.com");
    expect(ledger.liveSendReservations().byGroup.get("domain:shared.example")).toBe(2);
    expect(() => resolveSenderIdentity("x3@acme.com")).toThrow(SendDeferredError);
    const view = identityCapacities();
    expect(view.get("os-a")).toMatchObject({ domainSentToday: 2, capToday: 2, remaining: 0 });
    expect(view.get("os-b")!.remaining).toBe(0);
  });

  it("spreads reservations across separate mailboxes by remaining capacity", () => {
    mockCfg = {
      emailProvider: "gmail",
      emailIdentities: [gmail("a@x.com", 2), gmail("b@x.com", 2)],
    };
    const picks = [1, 2, 3, 4].map((n) => resolveSenderIdentity(`y${n}@acme.com`).id);
    expect(picks.filter((p) => p === "gmail:a@x.com")).toHaveLength(2);
    expect(picks.filter((p) => p === "gmail:b@x.com")).toHaveLength(2);
    expect(() => resolveSenderIdentity("y5@acme.com")).toThrow(SendDeferredError);
  });
});

describe("pinned sender path (unchanged)", () => {
  it("bypasses the picker and takes no reservation, even at the cap", () => {
    const id = "gmail:a@x.com";
    ledger.assignSender("pinned@acme.com", id);
    [1, 2, 3].map((n) => resolveSenderSlot(`z${n}@acme.com`));
    expect(() => resolveSenderIdentity("z4@acme.com")).toThrow(SendDeferredError);
    const before = ledger.liveSendReservations().byGroup.get(`id:${id}`);
    const pinned = resolveSenderSlot("pinned@acme.com");
    expect(pinned.identity.id).toBe(id);
    expect(pinned.reservationId).toBeNull();
    expect(ledger.liveSendReservations().byGroup.get(`id:${id}`)).toBe(before);
  });
});
