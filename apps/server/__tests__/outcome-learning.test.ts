import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  angleTextKey,
  decideLearning,
  getLedger,
  getReplyReviewStore,
  loadConfig,
  qualifyingAngles,
  saveConfig,
} from "@oneshot-gtm/core";
import { OUTCOME_COOLDOWN_MS, refreshOutcomeLearning } from "../src/outcome-learning.ts";

// Reply-based content suggestions (source `outcome`): a configured angle that
// clearly out-replies its play's other angles on one channel and stage is
// offered as one "lead with" preference in that area's reply-based slot.

const ledger = getLedger();
const ldb = (ledger as unknown as { db: Database }).db;
const store = getReplyReviewStore();
const original = loadConfig();
const NOW = Date.parse("2026-11-10T00:00:00.000Z");
const DAY = 86_400_000;

const A = "For a team shipping weekly — the release notes write themselves";
const B = "For a support lead — tickets answer themselves";

let seq = 0;
/** `people` distinct people sent `angle` on `play`; the first `replied` of them replied to that step. */
function seedAngle(input: {
  play?: string;
  angle: string;
  people: number;
  replied: number;
  channel?: "email" | "linkedin";
  step?: number;
  origin?: "configured" | "generated";
  outcome?: "sent" | "auto_sent";
  closedAt?: string;
}): void {
  const play = input.play ?? "show-hn";
  const step = input.step ?? 0;
  const channel = input.channel ?? "email";
  for (let i = 0; i < input.people; i++) {
    const email = `p${seq++}@x.dev`;
    const prospectId = Number(
      ldb.query("INSERT INTO prospects(name, email, source) VALUES('P', ?, 't')").run(email)
        .lastInsertRowid,
    );
    ldb
      .query(
        `INSERT INTO draft_versions(play_name, prospect_key, step_index, prospect_id, subject, body,
           angle_key, angle_text, angle_origin, outcome, channel, closed_at)
         VALUES (?,?,?,?,'Hi','body',?,?,?,?,?,?)`,
      )
      .run(
        play,
        email,
        step,
        prospectId,
        angleTextKey(input.angle),
        input.angle,
        input.origin ?? "configured",
        input.outcome ?? "sent",
        channel,
        input.closedAt ?? "2026-10-01T00:00:00.000Z",
      );
    if (i < input.replied)
      ldb
        .query(
          "INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status) VALUES (?,?,?,?,'replied')",
        )
        .run(prospectId, play, step, channel);
  }
}

const pending = () => ledger.learning.list({ kind: "preference", status: "pending" });

beforeEach(() => {
  for (const table of [
    "learning_proposals",
    "learning_guidance",
    "learning_jobs",
    "learning_state",
    "draft_versions",
    "sequence_events",
    "prospects",
  ])
    ldb.exec(`DELETE FROM ${table}`);
  store.db.exec("DELETE FROM reply_learning_state");
  saveConfig(original);
});
afterEach(() => saveConfig(original));

it("proposes one reply-backed lead-with preference, with the counts", () => {
  seedAngle({ angle: A, people: 61, replied: 7 });
  seedAngle({ angle: B, people: 212, replied: 4 });
  // A style proposal waits in the same channel and stage; the reply-based one does not replace it.
  const style = ledger.learning.insert({
    kind: "preference",
    scope: { channel: "email", stage: "first_touch" },
    current: null,
    proposed: { instruction: "Open with the point, not a greeting.", source: "style" },
    evidence: { refs: [] },
    evidenceSummary: "",
    baselineKey: "",
    dedupeKey: "email:first_touch:open with the point not a greeting",
  })!;

  expect(refreshOutcomeLearning(NOW)).toBe(1);
  const rows = pending().filter((p) => p.scope.basis === "replies");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    scope: { channel: "email", stage: "first_touch", basis: "replies" },
    proposed: {
      instruction: `When the research supports it, lead with: ${A}`,
      source: "outcome",
    },
    evidence: {
      method: "outcome",
      counts: { reached: 61, replied: 7, otherReached: 212, otherReplied: 4 },
    },
    evidenceSummary:
      "7 of 61 replied on this angle, against 4 of 212 on the play's other angles (show-hn, email first touches).",
  });
  expect(rows[0]!.evidence.refs).toHaveLength(7);
  expect(rows[0]!.evidence.counts!["p"]).toBeLessThan(0.1);
  expect(ledger.learning.get(style.id)?.status).toBe("pending");

  // Approved, it becomes guidance on email first touches with its own source.
  decideLearning(ledger, rows[0]!.id, "approve");
  expect(ledger.learning.listGuidance()).toMatchObject([
    { source: "outcome", channel: "email", stage: "first_touch" },
  ]);
  expect(ledger.learning.guidance({ channel: "email", stage: "first_touch" }).instructions).toEqual(
    [expect.objectContaining({ instruction: `When the research supports it, lead with: ${A}` })],
  );
});

it("proposes nothing under 30 people, under 3 replies, or without a clear lead", () => {
  const cases: Array<[string, () => void]> = [
    ["29 people", () => seedAngle({ angle: A, people: 29, replied: 7 })],
    ["2 replies", () => seedAngle({ angle: A, people: 61, replied: 2 })],
    // 11% against 12%: not double.
    ["no lift", () => seedAngle({ angle: A, people: 61, replied: 7 })],
    ["generated", () => seedAngle({ angle: A, people: 61, replied: 7, origin: "generated" })],
    // Exactly double (10% against 5%) but too few people to rule out chance. Last: checked below.
    ["not significant", () => seedAngle({ angle: A, people: 30, replied: 3 })],
  ];
  const others: Record<string, [number, number]> = {
    "29 people": [212, 4],
    "2 replies": [212, 0],
    "no lift": [212, 25],
    "not significant": [20, 1],
    generated: [212, 4],
  };
  for (const [name, seed] of cases) {
    for (const table of [
      "learning_proposals",
      "learning_jobs",
      "draft_versions",
      "sequence_events",
    ])
      ldb.exec(`DELETE FROM ${table}`);
    seed();
    const [people, replied] = others[name]!;
    seedAngle({ angle: B, people, replied });
    expect(refreshOutcomeLearning(NOW), name).toBe(0);
    expect(pending(), name).toEqual([]);
  }
  // The not-significant case clears every count rule and fails only the test.
  const row = ledger.angleOutcomesByStage().find((r) => r.angleText === A)!;
  expect(row).toMatchObject({ reached: 30, replied: 3, otherReached: 20, otherReplied: 1 });
  expect(
    qualifyingAngles([row], { minReached: 0, minReplied: 0, minLift: 0, maxP: 1.01 })[0]!.p,
  ).toBeGreaterThan(0.1);
});

it("runs at most once a day, and a later angle in the area waits for 10 new sends", () => {
  seedAngle({ angle: A, people: 61, replied: 7 });
  seedAngle({ angle: B, people: 212, replied: 4 });
  const C = "For an ops lead — the handoffs stop dropping";
  const D = "For an ops lead — the invoices reconcile";
  seedAngle({ play: "job-change", angle: C, people: 40, replied: 6 });
  seedAngle({ play: "job-change", angle: D, people: 200, replied: 3 });
  expect(refreshOutcomeLearning(NOW)).toBe(1);
  const first = pending()[0]!;
  // Cooldown: nothing runs again the same day.
  expect(refreshOutcomeLearning(NOW + 60_000)).toBe(0);
  // A day later: the pending text is not raised again, and the other
  // qualifying angle is held until the area has 10 new sends.
  expect(refreshOutcomeLearning(NOW + OUTCOME_COOLDOWN_MS)).toBe(0);
  expect(pending().map((p) => p.id)).toEqual([first.id]);
  // Unattended sends count: it is replies, not review, that this reads.
  seedAngle({
    angle: B,
    people: 10,
    replied: 0,
    outcome: "auto_sent",
    closedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(refreshOutcomeLearning(NOW + 2 * OUTCOME_COOLDOWN_MS)).toBe(1);
  const next = pending();
  expect(next).toHaveLength(1);
  expect(next[0]!.id).not.toBe(first.id);
  expect(ledger.learning.get(first.id)).toMatchObject({
    status: "stale",
    decided: { reason: "superseded" },
  });
});

it("never raises a dismissed angle again", () => {
  seedAngle({ angle: A, people: 61, replied: 7 });
  seedAngle({ angle: B, people: 212, replied: 4 });
  refreshOutcomeLearning(NOW);
  decideLearning(ledger, pending()[0]!.id, "dismiss");
  seedAngle({
    angle: A,
    people: 20,
    replied: 3,
    closedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(refreshOutcomeLearning(NOW + DAY)).toBe(0);
  expect(pending()).toEqual([]);
});

it("splits by channel and stage, and skips LinkedIn while LinkedIn copy is templates", () => {
  // A follow-up result is its own area; the intro's numbers do not mix in.
  seedAngle({ angle: A, people: 61, replied: 7, step: 1 });
  seedAngle({ angle: B, people: 212, replied: 4, step: 1 });
  seedAngle({ angle: A, people: 61, replied: 7, channel: "linkedin" });
  seedAngle({ angle: B, people: 212, replied: 4, channel: "linkedin" });
  expect(refreshOutcomeLearning(NOW)).toBe(1);
  expect(pending().map((p) => p.scope)).toEqual([
    { channel: "email", stage: "follow_up", basis: "replies" },
  ]);
  saveConfig({ ...original, linkedin: { writer: "model" } });
  expect(refreshOutcomeLearning(NOW + DAY)).toBe(1);
  expect(pending().map((p) => p.scope)).toContainEqual({
    channel: "linkedin",
    stage: "first_touch",
    basis: "replies",
  });
});

it("does nothing while the workspace's learning is paused, and keeps its daily run", () => {
  seedAngle({ angle: A, people: 61, replied: 7 });
  seedAngle({ angle: B, people: 212, replied: 4 });
  store.learning.setEnabled("default", false);
  expect(refreshOutcomeLearning(NOW)).toBe(0);
  store.learning.setEnabled("default", true);
  expect(refreshOutcomeLearning(NOW + 60_000)).toBe(1);
});
