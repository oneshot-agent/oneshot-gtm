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
    registerAngleRefreshTrigger((id) => calls.push(id));
    const id = h.ledger.upsertProspect({ email: "b@x.dev" });

    triggerAngleRefresh(id);

    expect(calls).toEqual([id]);
  });

  it("no-ops for a prospect id that does not exist", () => {
    const calls: number[] = [];
    registerAngleRefreshTrigger((id) => calls.push(id));

    triggerAngleRefresh(999999);

    expect(calls).toEqual([]);
  });

  it("debounces — does not re-trigger while the angle is fresher than the stale window", () => {
    const calls: number[] = [];
    registerAngleRefreshTrigger((id) => calls.push(id));
    const id = h.ledger.upsertProspect({ email: "c@x.dev" });
    h.ledger.setProspectAngle(id, JSON.stringify({ hook: "fresh" })); // stamps angle_synthesized_at = now

    triggerAngleRefresh(id);

    expect(calls).toEqual([]);
  });

  it("fires again once the existing angle is older than the stale window", () => {
    const calls: number[] = [];
    registerAngleRefreshTrigger((id) => calls.push(id));
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
});
