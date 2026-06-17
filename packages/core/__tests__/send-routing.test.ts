import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import type { EmailIdentity, OneShotConfig } from "../src/types.ts";

// Real on-disk ledger (assignments + receipt counters are SQL), mocked config.
let dbPath: string;
let ledger: Ledger;
let mockCfg: Partial<OneShotConfig>;

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...mockCfg }),
  };
});

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return {
    ...actual,
    getLedger: () => ledger,
  };
});

const {
  SendDeferredError,
  isSendDeferred,
  isTransientToolError,
  resolveSenderIdentity,
  hasAnySendCapacity,
  todayStartSqliteUtc,
  warmupCap,
  capGroupKey,
  identityCapacities,
} = await import("../src/send-routing.ts");
const { LEGACY_ONESHOT_ID } = await import("../src/identities.ts");

const gmailA: EmailIdentity = {
  id: "gmail:a@x.com",
  provider: "gmail",
  address: "a@x.com",
  maxPerDay: 50,
  warmup: { startPerDay: 10, incrementPerWeek: 10 },
};
const gmailB: EmailIdentity = {
  id: "gmail:b@x.com",
  provider: "gmail",
  address: "b@x.com",
  maxPerDay: 50,
  warmup: { startPerDay: 10, incrementPerWeek: 10 },
};
const oneshotId: EmailIdentity = {
  id: "oneshot-main",
  provider: "oneshot",
  sendingDomain: "x-mail.com",
  maxPerDay: null,
  warmup: null,
};

function recordSend(identityId: string, playName = "test-play"): void {
  ledger.recordReceipt({ playName, callType: "email.send", senderIdentity: identityId });
}

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-routing-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
  mockCfg = { emailIdentities: [gmailA, gmailB], emailProvider: "oneshot" };
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("warmupCap", () => {
  const now = new Date("2026-06-12T12:00:00Z");

  it("is uncapped only when maxPerDay and warmup are both null", () => {
    expect(warmupCap(oneshotId, null, now)).toBe(Infinity);
  });

  it("starts at startPerDay before any send", () => {
    expect(warmupCap(gmailA, null, now)).toBe(10);
  });

  it("ramps by incrementPerWeek per full week since first send", () => {
    expect(warmupCap(gmailA, "2026-06-12 11:00:00", now)).toBe(10); // <1 week
    expect(warmupCap(gmailA, "2026-06-05 12:00:00", now)).toBe(20); // exactly 1 week
    expect(warmupCap(gmailA, "2026-05-15 12:00:00", now)).toBe(50); // 4 weeks
  });

  it("clamps at maxPerDay", () => {
    expect(warmupCap(gmailA, "2025-01-01 00:00:00", now)).toBe(50);
  });

  it("fixed cap without warmup returns maxPerDay flat", () => {
    const fixed: EmailIdentity = { ...gmailA, warmup: null, maxPerDay: 30 };
    expect(warmupCap(fixed, null, now)).toBe(30);
  });
});

describe("daily counting (SQLite timestamp format)", () => {
  it("counts a receipt recorded right now — same-day rows are not excluded", () => {
    recordSend(gmailA.id);
    expect(ledger.countEmailSendsSince(gmailA.id, todayStartSqliteUtc())).toBe(1);
  });

  it("only counts email.send receipts for the given identity", () => {
    recordSend(gmailA.id);
    ledger.recordReceipt({ playName: "p", callType: "llm.complete", senderIdentity: gmailA.id });
    recordSend(gmailB.id);
    expect(ledger.countEmailSendsSince(gmailA.id, todayStartSqliteUtc())).toBe(1);
  });
});

describe("resolveSenderIdentity", () => {
  it("pins a fresh prospect to the most-available identity and stays sticky", () => {
    // Tilt capacity: gmailA has sent 3 today, gmailB none.
    for (let i = 0; i < 3; i++) recordSend(gmailA.id);
    const first = resolveSenderIdentity("new@acme.com");
    expect(first.id).toBe(gmailB.id);
    // Sticky even after B's capacity drops below A's.
    for (let i = 0; i < 9; i++) recordSend(gmailB.id);
    expect(resolveSenderIdentity("new@acme.com").id).toBe(gmailB.id);
  });

  it("prefers warming (capped) identities over an uncapped overflow identity", () => {
    // Regression: "most remaining capacity" must not let an uncapped OneShot
    // identity (∞ remaining) starve the warming Gmail accounts forever.
    mockCfg = { emailIdentities: [oneshotId, gmailA], emailProvider: "oneshot" };
    expect(resolveSenderIdentity("warmup@acme.com").id).toBe(gmailA.id);
  });

  it("falls back to the uncapped identity once every capped one is full", () => {
    mockCfg = {
      emailIdentities: [oneshotId, { ...gmailA, maxPerDay: 0, warmup: null }],
      emailProvider: "oneshot",
    };
    expect(resolveSenderIdentity("overflow@acme.com").id).toBe(oneshotId.id);
  });

  it("tie on remaining capacity breaks toward fewer sends today", () => {
    // A: cap 50, sent 10 → remaining 40. B: cap 45 (fixed), sent 5 → remaining 40.
    const fixedA: EmailIdentity = { ...gmailA, warmup: null, maxPerDay: 50 };
    const fixedB: EmailIdentity = { ...gmailB, warmup: null, maxPerDay: 45 };
    mockCfg = { emailIdentities: [fixedA, fixedB], emailProvider: "oneshot" };
    for (let i = 0; i < 10; i++) recordSend(fixedA.id);
    for (let i = 0; i < 5; i++) recordSend(fixedB.id);
    expect(resolveSenderIdentity("tie@acme.com").id).toBe(fixedB.id);
  });

  it("throws a config error (not deferral) when the pinned identity was removed", () => {
    ledger.assignSender("pinned@acme.com", "gone-identity");
    expect(() => resolveSenderIdentity("pinned@acme.com")).toThrow(/no longer configured/);
    try {
      resolveSenderIdentity("pinned@acme.com");
    } catch (err) {
      expect(isSendDeferred(err)).toBe(false);
    }
  });

  it("lazy-pins prospects with pre-rotation email history to the legacy identity", () => {
    mockCfg = {
      emailIdentities: [
        { id: LEGACY_ONESHOT_ID, provider: "oneshot", maxPerDay: null, warmup: null },
        gmailA,
      ],
      emailProvider: "oneshot",
    };
    const prospectId = ledger.upsertProspect({ email: "old@acme.com", source: "show-hn" });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    expect(resolveSenderIdentity("old@acme.com").id).toBe(LEGACY_ONESHOT_ID);
    // …and the pin persisted.
    expect(ledger.getSenderAssignment("old@acme.com")).toBe(LEGACY_ONESHOT_ID);
  });

  it("defers when every identity is at its cap", () => {
    mockCfg = {
      emailIdentities: [{ ...gmailA, maxPerDay: 0, warmup: null }],
      emailProvider: "oneshot",
    };
    expect(() => resolveSenderIdentity("fresh@acme.com")).toThrow(SendDeferredError);
    expect(hasAnySendCapacity()).toBe(false);
  });

  it("legacy mode (null identities) routes everything to the synthesized uncapped identity", () => {
    mockCfg = { emailIdentities: null, emailProvider: "oneshot" };
    const identity = resolveSenderIdentity("anyone@acme.com");
    expect(identity.id).toBe(LEGACY_ONESHOT_ID);
    expect(hasAnySendCapacity()).toBe(true);
  });

  it("assignment race: INSERT OR IGNORE keeps the first winner", () => {
    expect(ledger.assignSender("race@acme.com", gmailA.id)).toBe(gmailA.id);
    expect(ledger.assignSender("race@acme.com", gmailB.id)).toBe(gmailA.id);
  });
});

describe("per-domain capping (OneShot mailboxes share a domain budget)", () => {
  const ramp = { startPerDay: 10, incrementPerWeek: 10 };
  const onA: EmailIdentity = {
    id: "oneshot:a@acme.com",
    provider: "oneshot",
    sendingDomain: "acme.com",
    mailbox: "a",
    maxPerDay: 50,
    warmup: ramp,
  };
  const onB: EmailIdentity = {
    id: "oneshot:b@acme.com",
    provider: "oneshot",
    sendingDomain: "acme.com",
    mailbox: "b",
    maxPerDay: 50,
    warmup: ramp,
  };
  const onOther: EmailIdentity = {
    id: "oneshot:c@other.com",
    provider: "oneshot",
    sendingDomain: "other.com",
    mailbox: "c",
    maxPerDay: 50,
    warmup: ramp,
  };

  /** Record a send and back-date its created_at (SQLite UTC) for ramp-anchor tests. */
  function recordSendAt(identityId: string, createdAtSqlite: string): void {
    const id = ledger.recordReceipt({
      playName: "test-play",
      callType: "email.send",
      senderIdentity: identityId,
    });
    (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE receipts SET created_at = ? WHERE id = ?")
      .run(createdAtSqlite, id);
  }

  it("groups oneshot identities by domain, gmail by id", () => {
    expect(capGroupKey(onA)).toBe(capGroupKey(onB)); // same domain → one group
    expect(capGroupKey(onA)).not.toBe(capGroupKey(onOther));
    expect(capGroupKey(gmailA)).not.toBe(capGroupKey(gmailB)); // gmail per-account
  });

  it("counts both mailboxes on one domain against a single ramp, then defers", () => {
    mockCfg = { emailIdentities: [onA, onB], emailProvider: "oneshot" };
    // Fresh-day cap for the domain = startPerDay = 10. Split 6 + 4 across mailboxes.
    for (let i = 0; i < 6; i++) recordSend(onA.id);
    for (let i = 0; i < 4; i++) recordSend(onB.id);
    expect(() => resolveSenderIdentity("fresh@x.com")).toThrow(SendDeferredError);
    expect(hasAnySendCapacity()).toBe(false);
  });

  it("keeps separate domains on independent budgets", () => {
    mockCfg = { emailIdentities: [onA, onOther], emailProvider: "oneshot" };
    for (let i = 0; i < 10; i++) recordSend(onA.id); // acme.com full (cap 10)
    expect(resolveSenderIdentity("fresh@x.com").id).toBe(onOther.id);
  });

  it("spreads new prospects across mailboxes within a domain (tie-break on own sends)", () => {
    mockCfg = { emailIdentities: [onA, onB], emailProvider: "oneshot" };
    // Domain not full (3/10). A sent 2, B sent 1 → shared remaining 7; tie breaks to B.
    for (let i = 0; i < 2; i++) recordSend(onA.id);
    recordSend(onB.id);
    expect(resolveSenderIdentity("fresh@x.com").id).toBe(onB.id);
  });

  it("an uncapped mailbox makes its whole domain uncapped (overflow absorber)", () => {
    const onUncapped: EmailIdentity = {
      id: "oneshot:bulk@acme.com",
      provider: "oneshot",
      sendingDomain: "acme.com",
      mailbox: "bulk",
      maxPerDay: null,
      warmup: null,
    };
    mockCfg = { emailIdentities: [onA, onUncapped], emailProvider: "oneshot" };
    for (let i = 0; i < 100; i++) recordSend(onA.id); // would blow any finite cap
    // Domain has an uncapped member → still has capacity (overflow), never defers.
    expect(() => resolveSenderIdentity("fresh@x.com")).not.toThrow();
    expect(hasAnySendCapacity()).toBe(true);
  });

  it("anchors the domain ramp on the EARLIEST mailbox's first send", () => {
    mockCfg = { emailIdentities: [onA, onB], emailProvider: "oneshot" };
    // onA's first send was 15 days ago → 2 full weeks → domain ramp 10 + 2*10 = 30.
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    recordSendAt(onA.id, fifteenDaysAgo);
    const caps = identityCapacities();
    expect(caps.get(onA.id)?.capToday).toBe(30);
    expect(caps.get(onB.id)?.capToday).toBe(30); // shared ceiling
  });

  it("identityCapacities reports the shared domain total vs each mailbox's own sends", () => {
    mockCfg = { emailIdentities: [onA, onB], emailProvider: "oneshot" };
    for (let i = 0; i < 3; i++) recordSend(onA.id);
    recordSend(onB.id);
    const caps = identityCapacities();
    expect(caps.get(onA.id)?.identitySentToday).toBe(3);
    expect(caps.get(onB.id)?.identitySentToday).toBe(1);
    expect(caps.get(onA.id)?.domainSentToday).toBe(4); // shared
    expect(caps.get(onB.id)?.domainSentToday).toBe(4);
  });

  it("gmail accounts on the same email domain do NOT share a cap", () => {
    const gA: EmailIdentity = { ...gmailA, address: "a@team.com" };
    const gB: EmailIdentity = { ...gmailB, address: "b@team.com" };
    mockCfg = { emailIdentities: [gA, gB], emailProvider: "oneshot" };
    for (let i = 0; i < 10; i++) recordSend(gA.id); // gA full (cap 10), gB untouched
    expect(resolveSenderIdentity("fresh@x.com").id).toBe(gB.id);
  });
});

describe("isTransientToolError", () => {
  it("flags platform/transport failures as transient (must not become a durable verdict)", () => {
    for (const m of [
      "Job failed: Tool execution failed. (ref: 35a99138)",
      "The operation timed out.",
      "enrichProfile deadline exceeded (120s)",
      "fetch failed",
      "could not fetch balance",
      "read ECONNRESET",
      "request failed with status 503",
      "429 Too Many Requests",
      "network error: connection lost",
    ]) {
      expect(isTransientToolError(new Error(m))).toBe(true);
    }
  });

  it("does NOT flag genuine negatives (those ARE durable verdicts)", () => {
    for (const m of [
      "email not found",
      "address is undeliverable",
      "no profile data for this person",
      "domain_not_owned",
      // bare "network" must NOT over-match a genuine negative
      "no profile found on this professional network",
    ]) {
      expect(isTransientToolError(new Error(m))).toBe(false);
    }
    expect(isTransientToolError(null)).toBe(false);
    expect(isTransientToolError("")).toBe(false);
  });
});
