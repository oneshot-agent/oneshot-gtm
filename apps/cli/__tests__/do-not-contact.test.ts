import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ledger } from "@oneshot-gtm/core";

// `find do-not-contact`: a real ledger on a temp file, with the list in the
// (mocked) loaded config. Rows are seeded before the list exists, the way a
// founder adds an entry after the fact.

let ledger: Ledger;
let doNotContact: { domains?: string[]; companies?: string[] } | undefined;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({ ...actual.loadConfig(), doNotContact }),
  };
});
vi.mock("../src/output.ts", () => ({
  c: { dim: (s: string) => s },
  header: () => {},
  ok: () => {},
  warn: () => {},
}));

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const { commandDoNotContact } = await import("../src/commands/do-not-contact.ts");

const PLAY = "design-partner-loi";
let dbPath: string;
let n = 0;

beforeEach(() => {
  dbPath = join(tmpdir(), `oneshot-gtm-dnc-${Date.now()}-${++n}.sqlite`);
  ledger = new RealLedger(dbPath);
  vi.spyOn(console, "log").mockImplementation(() => {});
  doNotContact = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

function row(key: string, payload: Record<string, unknown>): number {
  return ledger.enqueueTarget({ playName: PLAY, payload, dedupeKey: key, source: "test" })!;
}

function cadence(email: string, company: string): number {
  const id = ledger.upsertProspect({ name: "Dana Lee", email, company });
  ledger.enrollCadence({ prospectId: id, playName: PLAY, nextDueAt: "2026-11-20T00:00:00Z" });
  return id;
}

describe("find do-not-contact", () => {
  it("does nothing with an empty list", async () => {
    const id = row("a", { email: "a@dental.example", company: "Example Dental" });
    const out = await commandDoNotContact({ dryRun: false });
    expect(out).toEqual({ rows: [], cadences: [], skipped: [] });
    expect(ledger.getQueueRow(id)!.status).toBe("pending");
  });

  it("a dry run lists the matches and changes nothing", async () => {
    const id = row("a", { email: "a@other.com", company: "Example Dental, PLLC" });
    const prospect = cadence("b@dental.example", "Elsewhere");
    doNotContact = { domains: ["dental.example"], companies: ["Example Dental"] };
    const out = await commandDoNotContact({ dryRun: true });
    expect(out.rows).toHaveLength(1);
    expect(out.cadences).toHaveLength(1);
    expect(ledger.getQueueRow(id)!.status).toBe("pending");
    expect(ledger.getCadence(prospect, PLAY)!.status).toBe("active");
  });

  it("rejects unsent rows and stops active cadences at a listed company, and leaves the rest", async () => {
    const pending = row("a", { email: "a@other.com", company: "Example Dental" });
    const approved = row("b", { email: "b@dental.example", company: "Elsewhere" });
    ledger.setQueueStatus({ id: approved, status: "approved" });
    const kept = row("c", { email: "c@acme.com", company: "Acme" });
    const stopped = cadence("d@other.com", "Example Dental of Springfield");
    const live = cadence("e@acme.com", "Acme");
    doNotContact = { domains: ["dental.example"], companies: ["Example Dental"] };

    const out = await commandDoNotContact({ dryRun: false });

    expect(out.rows).toHaveLength(2);
    for (const id of [pending, approved]) {
      const r = ledger.getQueueRow(id)!;
      expect(r.status).toBe("rejected");
      expect(r.notes).toMatch(/^auto: do-not-contact — /);
    }
    expect(ledger.getQueueRow(kept)!.status).toBe("pending");
    const cad = ledger.getCadence(stopped, PLAY)!;
    expect(cad.status).toBe("stopped");
    expect(cad.stop_reason).toBe("do_not_contact");
    expect(ledger.getCadence(live, PLAY)!.status).toBe("active");
  });

  it("rejects an email-only row by the company stored for that address", async () => {
    const id = row("g", { email: "g@gmail.example" });
    ledger.upsertProspect({ name: "Gil Moe", email: "g@gmail.example", company: "Example Dental" });
    doNotContact = { companies: ["Example Dental"] };
    const out = await commandDoNotContact({ dryRun: false });
    expect(out.rows).toHaveLength(1);
    expect(ledger.getQueueRow(id)!.status).toBe("rejected");
  });

  it("leaves a row a send has claimed, and stops a cadence by its row's website", async () => {
    const claimed = row("a", { email: "a@dental.example" });
    ledger.setQueueStatus({ id: claimed, status: "approved" });
    expect(
      ledger.claimQueueSendingMarker({ id: claimed, startedAtIso: new Date().toISOString() }),
    ).toBe(true);
    const prospect = cadence("f@gmail.example", "Elsewhere");
    row("f", { email: "f@gmail.example", website: "https://dental.example" });
    doNotContact = { domains: ["dental.example"] };

    const out = await commandDoNotContact({ dryRun: false });

    expect(out.skipped).toHaveLength(1);
    expect(ledger.getQueueRow(claimed)!.status).toBe("approved");
    expect(ledger.getCadence(prospect, PLAY)!.stop_reason).toBe("do_not_contact");
  });
});
