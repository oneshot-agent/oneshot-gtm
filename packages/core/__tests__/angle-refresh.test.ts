import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// triggerAngleRefresh (issue #357): the fire-and-forget seam that lets a new
// human reply / a tagged outcome ask `@oneshot-gtm/find` to re-synthesize a
// prospect's angle, without core importing find back (a cycle). Tested here
// against the REAL registration mechanism and a real Ledger, so the debounce
// (angle_synthesized_at freshness) is exercised against real persisted state
// rather than a mock.

const h = vi.hoisted(() => ({ ledger: null as unknown as import("../src/ledger.ts").Ledger }));

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return { ...actual, getLedger: () => h.ledger };
});

import { Ledger } from "../src/ledger.ts";
import {
  ANGLE_REFRESH_STALE_HOURS,
  _resetAngleRefreshTrigger,
  registerAngleRefreshTrigger,
  triggerAngleRefresh,
} from "../src/angle.ts";

let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-angle-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  h.ledger = new Ledger(dbPath);
  _resetAngleRefreshTrigger();
});

afterEach(() => {
  h.ledger.close();
  _resetAngleRefreshTrigger();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("triggerAngleRefresh", () => {
  it("is a no-op until a trigger is registered", () => {
    const id = h.ledger.upsertProspect({ email: "a@x.dev" });
    expect(() => triggerAngleRefresh(id)).not.toThrow();
  });

  it("calls the registered trigger for a prospect with no angle yet", () => {
    const calls: number[] = [];
    registerAngleRefreshTrigger((id) => {
      calls.push(id);
    });
    const id = h.ledger.upsertProspect({ email: "b@x.dev" });

    triggerAngleRefresh(id);

    expect(calls).toEqual([id]);
  });

  it("no-ops for a prospect id that does not exist", () => {
    const calls: number[] = [];
    registerAngleRefreshTrigger((id) => {
      calls.push(id);
    });

    triggerAngleRefresh(999999);

    expect(calls).toEqual([]);
  });

  it("debounces — does not re-trigger while the angle is fresher than the stale window", () => {
    const calls: number[] = [];
    registerAngleRefreshTrigger((id) => {
      calls.push(id);
    });
    const id = h.ledger.upsertProspect({ email: "c@x.dev" });
    h.ledger.setProspectAngle(id, JSON.stringify({ hook: "fresh" })); // stamps angle_synthesized_at = now

    triggerAngleRefresh(id);

    expect(calls).toEqual([]);
  });

  it("fires again once the existing angle is older than the stale window", () => {
    const calls: number[] = [];
    registerAngleRefreshTrigger((id) => {
      calls.push(id);
    });
    const id = h.ledger.upsertProspect({ email: "d@x.dev" });
    h.ledger.setProspectAngle(id, JSON.stringify({ hook: "old" }));
    // Backdate the stamp past the debounce window directly in the DB — the
    // public API only ever writes "now", so this simulates time passing.
    const staleAt = new Date(
      Date.now() - (ANGLE_REFRESH_STALE_HOURS * 3600_000 + 1000),
    ).toISOString();
    h.ledger["db"]
      .prepare("UPDATE prospects SET angle_synthesized_at = ? WHERE id = ?")
      .run(staleAt, id);

    triggerAngleRefresh(id);

    expect(calls).toEqual([id]);
  });

  it("never throws when the registered trigger itself throws", () => {
    registerAngleRefreshTrigger(() => {
      throw new Error("boom");
    });
    const id = h.ledger.upsertProspect({ email: "e@x.dev" });

    expect(() => triggerAngleRefresh(id)).not.toThrow();
  });

  // Round-1 correction (issue #357): the timestamp debounce alone only
  // protects once a PRIOR refresh has finished and stamped
  // angle_synthesized_at. Two triggers landing before that write — e.g. two
  // replies in one pollInboxReplies() page — must not both launch the paid
  // pipeline concurrently.
  it("drops a second trigger for the same prospect while the first is still in flight", async () => {
    const calls: number[] = [];
    let resolveFirst: (() => void) | null = null;
    registerAngleRefreshTrigger(
      (id) =>
        new Promise<void>((resolve) => {
          calls.push(id);
          resolveFirst = resolve;
        }),
    );
    const id = h.ledger.upsertProspect({ email: "f@x.dev" });

    triggerAngleRefresh(id); // launches, never resolves yet
    triggerAngleRefresh(id); // same prospect, still in flight — must be dropped
    triggerAngleRefresh(id); // a third burst member — also dropped

    expect(calls).toEqual([id]); // only one actual invocation

    resolveFirst!();
    await Promise.resolve();
    await Promise.resolve();

    // Once the in-flight refresh has settled, a fresh trigger is allowed
    // again (the in-flight guard doesn't leak past completion) — gated only
    // by the timestamp debounce, which this test's ledger row never set, so
    // it still fires.
    triggerAngleRefresh(id);
    expect(calls).toEqual([id, id]);
  });

  it("still allows a DIFFERENT prospect's refresh while one prospect is in flight", () => {
    const calls: number[] = [];
    registerAngleRefreshTrigger(
      (id) =>
        new Promise<void>(() => {
          calls.push(id);
        }),
    );
    const idA = h.ledger.upsertProspect({ email: "g@x.dev" });
    const idB = h.ledger.upsertProspect({ email: "h@x.dev" });

    triggerAngleRefresh(idA);
    triggerAngleRefresh(idB);

    expect(calls).toEqual([idA, idB]);
  });

  it("releases the in-flight slot even when the trigger's promise rejects", async () => {
    const calls: number[] = [];
    let rejectFirst: ((err: Error) => void) | null = null;
    registerAngleRefreshTrigger(
      (id) =>
        new Promise<void>((_resolve, reject) => {
          calls.push(id);
          rejectFirst = reject;
        }),
    );
    const id = h.ledger.upsertProspect({ email: "i@x.dev" });

    triggerAngleRefresh(id);
    triggerAngleRefresh(id); // dropped — still in flight

    rejectFirst!(new Error("synthesis failed"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    triggerAngleRefresh(id); // in-flight slot released — allowed again
    expect(calls).toEqual([id, id]);
  });

  // Round-2 correction, issue #357: an outcome dropped by the in-flight
  // guard while a reply-triggered refresh is running must not be lost —
  // the completed write can't reflect an outcome it never saw, and the
  // freshness debounce would then block a retry for
  // ANGLE_REFRESH_STALE_HOURS.
  it("queues a dropped outcome trigger and fires it once the in-flight refresh settles", async () => {
    const calls: Array<{ id: number; context?: { outcome?: { type: string } } }> = [];
    let resolveFirst: (() => void) | null = null;
    registerAngleRefreshTrigger(
      (id, context) =>
        new Promise<void>((resolve) => {
          calls.push({ id, context });
          resolveFirst = resolve;
        }),
    );
    const id = h.ledger.upsertProspect({ email: "j@x.dev" });

    triggerAngleRefresh(id); // reply-triggered, launches and never resolves yet
    triggerAngleRefresh(id, { outcome: { type: "meeting" } }); // dropped but queued

    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toBeUndefined();

    resolveFirst!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The queued outcome fires as a follow-up once the first settles, even
    // though angle_synthesized_at is still unset (bypasses the freshness
    // debounce for this deliberate catch-up).
    expect(calls).toHaveLength(2);
    expect(calls[1]?.id).toBe(id);
    expect(calls[1]?.context).toEqual({ outcome: { type: "meeting" } });
  });

  it("does not queue a dropped REPLY trigger (no outcome) while one is in flight", async () => {
    const calls: number[] = [];
    let resolveFirst: (() => void) | null = null;
    registerAngleRefreshTrigger(
      (id) =>
        new Promise<void>((resolve) => {
          calls.push(id);
          resolveFirst = resolve;
        }),
    );
    const id = h.ledger.upsertProspect({ email: "k@x.dev" });

    triggerAngleRefresh(id);
    triggerAngleRefresh(id); // dropped, no outcome — not queued

    resolveFirst!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([id]); // no follow-up fired
  });

  it("keeps only the LAST queued outcome when several land while one is in flight", async () => {
    const calls: Array<{ outcome?: { type: string } }> = [];
    let resolveFirst: (() => void) | null = null;
    registerAngleRefreshTrigger(
      (id, context) =>
        new Promise<void>((resolve) => {
          calls.push({ outcome: context?.outcome });
          resolveFirst = resolve;
        }),
    );
    const id = h.ledger.upsertProspect({ email: "l@x.dev" });

    triggerAngleRefresh(id);
    triggerAngleRefresh(id, { outcome: { type: "meeting" } });
    triggerAngleRefresh(id, { outcome: { type: "revenue", amount: 5000 } });

    resolveFirst!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.outcome).toEqual({ type: "revenue", amount: 5000 });
  });
});
