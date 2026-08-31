import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

// Dossier persistence + the research candidate selector. `dossier_json` was
// read as free Tier-1 context by the reply drafter but never written by
// anything in production, so these are the writers that close that gap.

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-research-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
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

function add(email: string, extra: Record<string, unknown> = {}): number {
  return ledger.upsertProspect({ email, name: "Pat", source: "repo-interest", ...extra });
}

describe("setProspectDossier", () => {
  it("writes a dossier onto a prospect that has none", () => {
    const id = add("a@x.dev");
    ledger.setProspectDossier(id, "role: staff engineer");
    expect(ledger.getProspectById(id)?.dossier_json).toBe("role: staff engineer");
  });

  it("OVERWRITES an existing dossier — unlike the write-once identity path", () => {
    const id = add("b@x.dev", { dossier_json: "stale" });
    ledger.setProspectDossier(id, "fresh");
    expect(ledger.getProspectById(id)?.dossier_json).toBe("fresh");
    // Contrast: updateProspectIdentity is COALESCE-guarded and cannot clobber.
    ledger.updateProspectIdentity(id, { company: "Acme" });
    expect(ledger.updateProspectIdentity(id, { company: "Other" })).toBe(false);
    expect(ledger.getProspectById(id)?.company).toBe("Acme");
  });

  it("clears with null", () => {
    const id = add("c@x.dev", { dossier_json: "something" });
    ledger.setProspectDossier(id, null);
    expect(ledger.getProspectById(id)?.dossier_json).toBeNull();
  });
});

describe("setProspectIcpVerdict", () => {
  it("persists 'unclear' as a real verdict, distinct from never-judged", () => {
    const id = add("d@x.dev");
    expect(ledger.getProspectById(id)?.icp_verdict).toBeNull();
    ledger.setProspectIcpVerdict(id, "unclear", "handle only, no role text");
    expect(ledger.getProspectById(id)?.icp_verdict).toBe("unclear");
    expect(ledger.getProspectById(id)?.icp_verdict_reason).toBe("handle only, no role text");
  });

  it("still flips between verdicts in either direction", () => {
    const id = add("e@x.dev");
    ledger.setProspectIcpVerdict(id, "unclear");
    ledger.setProspectIcpVerdict(id, "pass", "builds agents");
    expect(ledger.getProspectById(id)?.icp_verdict).toBe("pass");
    ledger.setProspectIcpVerdict(id, "reject", "recruiter");
    expect(ledger.getProspectById(id)?.icp_verdict).toBe("reject");
  });
});

describe("listProspectsForResearch", () => {
  it("selects unjudged rows that have a URL to chase", () => {
    const withUrl = add("f@x.dev", { source_profile_url: "https://github.com/f" });
    add("g@x.dev"); // unjudged but no URL — nothing to research against
    const ids = ledger.listProspectsForResearch({ scopes: ["unjudged"] }).map((r) => r.id);
    expect(ids).toContain(withUrl);
    expect(ids).toHaveLength(1);
  });

  it("selects prospects with an active cadence", () => {
    const id = add("h@x.dev", { source_profile_url: "https://github.com/h" });
    ledger.setProspectIcpVerdict(id, "pass"); // judged, so 'unjudged' would miss it
    ledger.enrollCadence({
      prospectId: id,
      playName: "repo-interest",
      nextDueAt: new Date().toISOString(),
    });
    expect(ledger.listProspectsForResearch({ scopes: ["unjudged"] }).map((r) => r.id)).toEqual([]);
    expect(ledger.listProspectsForResearch({ scopes: ["active"] }).map((r) => r.id)).toEqual([id]);
  });

  it("unions the scopes rather than intersecting them", () => {
    const unjudged = add("i@x.dev", { source_profile_url: "https://github.com/i" });
    const active = add("j@x.dev", { source_profile_url: "https://github.com/j" });
    ledger.setProspectIcpVerdict(active, "pass");
    ledger.enrollCadence({
      prospectId: active,
      playName: "repo-interest",
      nextDueAt: new Date().toISOString(),
    });
    const ids = ledger
      .listProspectsForResearch({ scopes: ["active", "unjudged"] })
      .map((r) => r.id);
    expect(ids.toSorted()).toEqual([unjudged, active].toSorted());
  });

  it("excludes rows that already hold a dossier, so a run resumes instead of re-buying", () => {
    const done = add("k@x.dev", {
      source_profile_url: "https://github.com/k",
      dossier_json: "already researched",
    });
    expect(ledger.listProspectsForResearch({ scopes: ["unjudged"] }).map((r) => r.id)).toEqual([]);
    expect(
      ledger
        .listProspectsForResearch({ scopes: ["unjudged"], includeResearched: true })
        .map((r) => r.id),
    ).toEqual([done]);
  });

  it("'all' still requires something for deepResearchPerson to key on", () => {
    const keyed = add("l@x.dev");
    const unkeyed = ledger.upsertProspect({ email: null, name: "No Contact" });
    const ids = ledger.listProspectsForResearch({ scopes: ["all"] }).map((r) => r.id);
    expect(ids).toContain(keyed);
    expect(ids).not.toContain(unkeyed);
  });

  it("falls back to the default scopes when none are given", () => {
    const id = add("m@x.dev", { source_profile_url: "https://github.com/m" });
    // An empty list means "unspecified", not "match nothing" — same shape as
    // the other list* helpers. It must never widen to every row, though: this
    // one is picked up by the default `unjudged` scope, not by a missing filter.
    expect(ledger.listProspectsForResearch({ scopes: [] as never }).map((r) => r.id)).toEqual([id]);
    expect(ledger.listProspectsForResearch().map((r) => r.id)).toEqual([id]);
  });

  it("honours the limit", () => {
    for (const e of ["n@x.dev", "o@x.dev", "p@x.dev"]) {
      add(e, { source_profile_url: `https://github.com/${e}` });
    }
    expect(ledger.listProspectsForResearch({ scopes: ["unjudged"], limit: 2 })).toHaveLength(2);
  });
});
