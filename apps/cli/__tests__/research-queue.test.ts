import { describe, expect, it } from "vitest";
import {
  parseQueueStatuses,
  resolveQueueCap,
  ROW_COST_ESTIMATE_USD,
  selectCandidates,
  type CandidateRow,
} from "../src/commands/research-queue.ts";

// Pure helpers for the queue-row person research backfill. Each one guards a
// paid call: a typo'd status must not widen the run, a sent row must never be
// researched onto a payload nobody can write, and a row that already carries
// research must not be bought twice unless asked.

function row(over: Partial<CandidateRow> & { payload?: Record<string, unknown> }): CandidateRow {
  const { payload, ...rest } = over;
  return {
    id: 1,
    play_name: "luma-events",
    source: "find:luma-events",
    notes: null,
    payload_json: JSON.stringify(
      payload ?? {
        name: "Julia Zabrodska",
        email: "julia@letocaffe.com",
        linkedinUrl: "https://www.linkedin.com/in/julia-zabrodska-akinci-cv",
      },
    ),
    status: "approved",
    prospect_id: null,
    sent_at: null,
    send_started_at: null,
    ...rest,
  };
}

const research = {
  version: 1,
  status: "complete",
  researchedAt: "2026-09-11T20:00:00.000Z",
  seed: {},
  organizations: [],
  costUsd: 0.055,
  cached: false,
};

describe("parseQueueStatuses", () => {
  it("defaults to live = pending + approved", () => {
    expect(parseQueueStatuses(undefined)).toEqual(["pending", "approved"]);
    expect(parseQueueStatuses(" Live ")).toEqual(["pending", "approved"]);
    expect(parseQueueStatuses("approved")).toEqual(["approved"]);
  });

  it("rejects an unknown status rather than silently widening a paid run", () => {
    expect(() => parseQueueStatuses("sent")).toThrow(/unknown --status/);
  });
});

describe("resolveQueueCap", () => {
  it("floors a sane limit and never widens on bad input", () => {
    expect(resolveQueueCap(undefined)).toBeUndefined();
    expect(resolveQueueCap(7.9)).toBe(7);
    expect(resolveQueueCap(Number.NaN)).toBe(0);
    expect(resolveQueueCap(-3)).toBe(0);
  });
});

describe("selectCandidates", () => {
  it("refuses sent and mid-send rows, even under --id", () => {
    const rows = [
      row({ id: 1, sent_at: "2026-09-01T00:00:00Z", status: "sent" }),
      row({ id: 2, send_started_at: "2026-09-11T00:00:00Z" }),
      row({ id: 3 }),
    ];
    const s = selectCandidates(rows, { refresh: false, explicit: true });
    expect(s.notLive).toBe(2);
    expect(s.candidates.map((c) => c.row.id)).toEqual([3]);
  });

  it("skips rows that already carry research unless --refresh, and bypasses that under --id", () => {
    const researched = row({
      id: 4,
      payload: {
        name: "A",
        email: "a@acme.dev",
        linkedinUrl: "https://linkedin.com/in/a",
        personResearch: research,
      },
    });
    expect(selectCandidates([researched], { refresh: false }).researched).toBe(1);
    expect(selectCandidates([researched], { refresh: false }).candidates).toHaveLength(0);
    expect(selectCandidates([researched], { refresh: true }).candidates).toHaveLength(1);
    expect(
      selectCandidates([researched], { refresh: false, explicit: true }).candidates,
    ).toHaveLength(1);
  });

  it("counts rows with nothing to research: no profile URL and no email + name", () => {
    const s = selectCandidates(
      [
        row({ id: 5, payload: { name: "Only A Name" } }),
        row({ id: 6, payload: { email: "someone@acme.dev" } }),
        row({ id: 7, payload: { name: "Email And Name", email: "e@acme.dev" } }),
      ],
      { refresh: false },
    );
    expect(s.noProfile).toBe(2);
    expect(s.candidates.map((c) => c.row.id)).toEqual([7]);
    expect(s.candidates[0]!.seed.email).toBe("e@acme.dev");
  });

  it("carries the seed the research call is handed", () => {
    const s = selectCandidates([row({ id: 8 })], { refresh: false });
    expect(s.candidates[0]!.seed.url).toBe("https://linkedin.com/in/julia-zabrodska-akinci-cv");
    expect(s.candidates[0]!.seed.name).toBe("Julia Zabrodska");
  });

  it("estimates a row at person research plus the company lookup", () => {
    expect(ROW_COST_ESTIMATE_USD).toBeCloseTo(0.055, 6);
  });
});
