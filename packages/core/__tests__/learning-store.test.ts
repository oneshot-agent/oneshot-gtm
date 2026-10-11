import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import {
  MAX_ENABLED_GUIDANCE,
  learningKeyOf,
  learningScopeKey,
  normalizeLearnedText,
} from "../src/learning-store.ts";

// Unified learning proposals (issue #813): one store for every learned
// change that waits for founder approval, the guidance rows approved
// preferences become, and the leases of the jobs that generate proposals.

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-learning-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

const T0 = "2026-10-08T00:00:00.000Z";
const T1 = "2026-10-08T01:00:00.000Z";
const T2 = "2026-10-08T02:00:00.000Z";

const insertPreference = (instruction: string, scope = { channel: "email" as const }) =>
  ledger.learning.insert({
    kind: "preference",
    scope,
    current: null,
    proposed: { instruction, source: "edits" },
    evidence: { refs: [{ type: "reply_send", id: "s1" }] },
    evidenceSummary: "Three edited replies shortened the opener.",
    baselineKey: "",
    dedupeKey: normalizeLearnedText(instruction),
    createdAt: T0,
  });

const insertAngle = (prospectId: number, hook: string, createdAt = T0, evidenceId = "r1") =>
  ledger.learning.insert({
    kind: "prospect_angle",
    scope: { prospectId },
    current: { hook: "old hook" },
    proposed: { hook },
    evidence: { refs: [{ type: "inbox_reply", id: evidenceId }], method: "reply" },
    evidenceSummary: "They replied asking about pricing.",
    baselineKey: learningKeyOf({ hook: "old hook" }),
    dedupeKey: `${prospectId}:${learningKeyOf({ hook })}`,
    createdAt,
  });

describe("proposals", () => {
  it("insert + get + list round-trip a pending proposal with its scope and evidence", () => {
    const p = insertPreference("Open with the question, not a greeting")!;
    expect(p).toMatchObject({
      kind: "preference",
      status: "pending",
      legacy: false,
      scope: { channel: "email" },
      proposed: { instruction: "Open with the question, not a greeting", source: "edits" },
      evidence: { refs: [{ type: "reply_send", id: "s1" }] },
      decidedAt: null,
      appliedAt: null,
    });
    expect(ledger.learning.get(p.id)).toEqual(p);
    expect(ledger.learning.list({ kind: "preference", status: "pending" })).toHaveLength(1);
    expect(ledger.learning.list({ kind: "icp" })).toEqual([]);
  });

  it("refuses a second pending proposal with the same kind and dedupe key, and preserves dismissals against unchanged evidence", () => {
    const first = insertPreference("Keep it under eighty words")!;
    expect(insertPreference("Keep it under eighty words!")).toBeNull();
    expect(ledger.learning.hasPendingDuplicate("preference", "keep it under eighty words")).toBe(
      true,
    );
    ledger.learning.decide(first.id, "dismissed", T1);
    expect(insertPreference("Keep it under eighty words")).toBeNull();
    expect(insertPreference("Use fewer than eighty words")).toBeNull();
  });

  it("filters by prospect and play through the scope", () => {
    insertAngle(7, "hook A");
    insertAngle(8, "hook B");
    ledger.learning.insert({
      kind: "campaign_angle",
      scope: { playName: "show-hn" },
      current: { edge: "a // b" },
      proposed: { edge: "a // c" },
      evidence: { refs: [], counts: { offered: 12 } },
      evidenceSummary: "b never sent",
      baselineKey: learningKeyOf("a // b"),
      dedupeKey: learningKeyOf("a // c"),
      createdAt: T0,
    });
    expect(ledger.learning.list({ prospectId: 7 }).map((p) => p.scope.prospectId)).toEqual([7]);
    expect(ledger.learning.list({ playName: "show-hn" })).toHaveLength(1);
    expect(ledger.learning.list({ kind: "prospect_angle" })).toHaveLength(2);
  });

  it("decide() approves once, stores an edited value, and refuses a second decision", () => {
    const p = insertAngle(1, "new hook")!;
    const decided = ledger.learning.decide(p.id, "approved", T1, { hook: "edited hook" });
    expect("view" in decided && decided.view).toMatchObject({
      status: "approved",
      decidedAt: T1,
      decided: { hook: "edited hook" },
    });
    const again = ledger.learning.decide(p.id, "dismissed", T2);
    expect("error" in again && again.error).toContain("already approved");
    expect("error" in ledger.learning.decide("nope", "approved", T2)).toBe(true);
  });

  it("revertToPending clears the decision when applying failed", () => {
    const p = insertAngle(1, "new hook")!;
    ledger.learning.decide(p.id, "approved", T1, { hook: "x" });
    ledger.learning.markApplied(p.id, T1);
    ledger.learning.revertToPending(p.id);
    expect(ledger.learning.get(p.id)).toMatchObject({
      status: "pending",
      decidedAt: null,
      decided: null,
      appliedAt: null,
    });
  });

  it("rollback() reverts only an approved proposal", () => {
    const p = insertAngle(1, "new hook")!;
    expect("error" in ledger.learning.rollback(p.id, T1)).toBe(true);
    ledger.learning.decide(p.id, "approved", T1);
    const rolled = ledger.learning.rollback(p.id, T2);
    expect("view" in rolled && rolled.view).toMatchObject({
      status: "rolled_back",
      rolledBackAt: T2,
      current: { hook: "old hook" },
    });
  });

  it("markStale only touches pending rows in the same kind and scope", () => {
    const a = insertAngle(1, "hook A")!;
    const other = insertAngle(2, "hook C")!;
    const pref = insertPreference("Say hey")!;
    expect(
      ledger.learning.markStale(
        "prospect_angle",
        learningScopeKey("prospect_angle", { prospectId: 1 }),
        T1,
      ),
    ).toBe(1);
    expect(ledger.learning.get(a.id)).toMatchObject({ status: "stale", decidedAt: T1 });
    expect(ledger.learning.get(other.id)?.status).toBe("pending");
    expect(ledger.learning.get(pref.id)?.status).toBe("pending");
  });

  it("allows one pending angle revision per prospect (and per play), whatever the hook", () => {
    const a = insertAngle(1, "hook A")!;
    expect(insertAngle(1, "hook B")).toBeNull();
    expect(insertAngle(2, "hook B")).not.toBeNull();
    ledger.learning.decide(a.id, "dismissed", T1);
    expect(insertAngle(1, "hook B")).toBeNull();
    expect(insertAngle(1, "hook B", T1, "r2")).not.toBeNull();
    // Preferences are not scoped that way: several may wait at once.
    expect(insertPreference("One")).not.toBeNull();
    expect(insertPreference("Two")).not.toBeNull();
  });

  it("wasJustDismissed is true only while the latest decision in scope was a dismissal of that key", () => {
    const a = insertAngle(1, "hook A")!;
    ledger.learning.decide(a.id, "dismissed", T1);
    const key = a.dedupeKey;
    expect(ledger.learning.wasJustDismissed("prospect_angle", key, "prospect:1")).toBe(true);
    expect(ledger.learning.wasJustDismissed("prospect_angle", key, "prospect:2")).toBe(false);
    expect(ledger.learning.wasJustDismissed("prospect_angle", "other", "prospect:1")).toBe(false);
    const b = insertAngle(1, "hook B", T1, "r2");
    ledger.learning.decide(b!.id, "approved", T2);
    expect(ledger.learning.wasJustDismissed("prospect_angle", key, "prospect:1")).toBe(false);
  });

  it("excludedPreferenceTexts collects dismissed proposals and disabled or rolled-back guidance", () => {
    const p = insertPreference("Never open with I hope this finds you well")!;
    ledger.learning.decide(p.id, "dismissed", T1);
    const g = ledger.learning.addGuidance({
      instruction: "Use 'Hey' not 'Hi'",
      source: "explicit",
    });
    ledger.learning.rollbackGuidance(g.id);
    expect(ledger.learning.excludedPreferenceTexts()).toEqual(
      expect.arrayContaining([
        normalizeLearnedText("Never open with I hope this finds you well"),
        normalizeLearnedText("Use 'Hey' not 'Hi'"),
      ]),
    );
  });
});

describe("guidance", () => {
  it("applies by channel and stage, unscoped rows everywhere, and fingerprints the set", () => {
    ledger.learning.addGuidance({ instruction: "Any", source: "style", now: T0 });
    ledger.learning.addGuidance({
      instruction: "Email replies only",
      source: "edits",
      channel: "email",
      stage: "reply",
      now: T1,
    });
    ledger.learning.addGuidance({
      instruction: "LinkedIn only",
      source: "explicit",
      channel: "linkedin",
      now: T2,
    });
    const emailReply = ledger.learning.guidance({ channel: "email", stage: "reply" });
    expect(emailReply.instructions.map((i) => i.instruction)).toEqual([
      "Any",
      "Email replies only",
    ]);
    expect(
      ledger.learning
        .guidance({ channel: "email", stage: "first_touch" })
        .instructions.map((i) => i.instruction),
    ).toEqual(["Any"]);
    expect(
      ledger.learning
        .guidance({ channel: "linkedin", stage: "reply" })
        .instructions.map((i) => i.instruction),
    ).toEqual(["Any", "LinkedIn only"]);
    expect(emailReply.key).toMatch(/^[0-9a-f]{12}$/);
    expect(emailReply.key).not.toBe(
      ledger.learning.guidance({ channel: "linkedin", stage: "reply" }).key,
    );
  });

  it("returns no key when nothing applies, and bumps the version on every change", () => {
    expect(ledger.learning.guidance({ channel: "email", stage: "reply" })).toEqual({
      version: 0,
      key: null,
      instructions: [],
    });
    const g = ledger.learning.addGuidance({ instruction: "Short", source: "style" });
    expect(ledger.learning.guidance().version).toBe(1);
    ledger.learning.setGuidanceEnabled(g.id, false);
    expect(ledger.learning.guidance()).toMatchObject({ version: 2, key: null, instructions: [] });
    ledger.learning.setGuidanceEnabled(g.id, true);
    expect(ledger.learning.guidance().version).toBe(3);
    expect(ledger.learning.rollbackGuidance(g.id)).toBe(true);
    expect(ledger.learning.rollbackGuidance(g.id)).toBe(false);
    expect(ledger.learning.guidance().version).toBe(4);
    expect(() => ledger.learning.setGuidanceEnabled(g.id, true)).toThrow(/rolled-back/);
    expect(ledger.learning.listGuidance()).toEqual([]);
    expect(ledger.learning.listGuidance(true)).toHaveLength(1);
  });

  it("caps enabled guidance at twelve, counting re-enables", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_ENABLED_GUIDANCE; i++)
      ids.push(ledger.learning.addGuidance({ instruction: `Rule ${i}`, source: "style" }).id);
    expect(() => ledger.learning.addGuidance({ instruction: "One more", source: "style" })).toThrow(
      /12 active maximum/,
    );
    ledger.learning.setGuidanceEnabled(ids[0]!, false);
    const extra = ledger.learning.addGuidance({ instruction: "One more", source: "style" });
    expect(() => ledger.learning.setGuidanceEnabled(ids[0]!, true)).toThrow(/12 active maximum/);
    expect(ledger.learning.guidance().instructions).toHaveLength(MAX_ENABLED_GUIDANCE);
    expect(ledger.learning.guidance().instructions.some((i) => i.id === extra.id)).toBe(true);
  });
});

describe("job leases", () => {
  const opts = { cooldownMs: 86_400_000, leaseMs: 300_000 };

  it("grants one lease at a time and spends the cooldown from the attempt", () => {
    const token = ledger.learning.claimJob("preference", 1_000, opts)!;
    expect(token).toBeTruthy();
    expect(ledger.learning.claimJob("preference", 1_500, opts)).toBeNull();
    // Another kind is independent.
    expect(ledger.learning.claimJob("icp", 1_500, opts)).not.toBeNull();
    expect(ledger.learning.finishJob("preference", token, { watermark: 42, now: T1 })).toBe(true);
    expect(ledger.learning.jobState("preference")).toMatchObject({
      token: null,
      watermark: 42,
      refreshed_at: T1,
      error: null,
    });
    expect(ledger.learning.claimJob("preference", 1_000 + 60_000, opts)).toBeNull();
    expect(ledger.learning.claimJob("preference", 1_000 + 86_400_000, opts)).not.toBeNull();
  });

  it("renew extends only a live lease; fail records the reason and keeps the watermark", () => {
    const token = ledger.learning.claimJob("preference", 1_000, opts)!;
    expect(ledger.learning.renewJob("preference", token, 2_000, 300_000)).toBe(true);
    expect(ledger.learning.renewJob("preference", "stale", 2_000, 300_000)).toBe(false);
    expect(ledger.learning.renewJob("preference", token, 1_000 + 400_000, 300_000)).toBe(false);
    ledger.learning.failJob("preference", token, "boom");
    expect(ledger.learning.jobState("preference")).toMatchObject({
      token: null,
      error: "boom",
      watermark: 0,
    });
    expect(ledger.learning.finishJob("preference", token)).toBe(false);
  });
});

const draft = (body: string, sent = false) => ({
  subject: "Hi",
  body,
  flags: [],
  sent,
  receiptIds: [],
  dryRun: false,
});

describe("draftObservationsSince", () => {
  it("returns human sends after the watermark with their regenerated siblings, ignoring drain sends and rotations", () => {
    ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Ada ships" },
      dedupeKey: "a",
      source: "find:show-hn",
    });
    ledger.setQueueDraft({ id: 1, draft: draft("v1") });
    ledger.setQueueDraft({ id: 1, draft: draft("v2"), discardReason: "regenerate" });
    ledger.setQueueDraft({ id: 1, draft: draft("v3"), discardReason: "rotate" });
    ledger.setQueueDraft({ id: 1, draft: draft("v3", true), sentBy: "human" });
    // A drained row: never judged by the founder.
    ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Bot" },
      dedupeKey: "b",
      source: "find:show-hn",
    });
    ledger.setQueueDraft({ id: 2, draft: draft("m1") });
    ledger.setQueueDraft({ id: 2, draft: draft("m1", true), sentBy: "machine" });

    const obs = ledger.learning.draftObservationsSince(0);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      playName: "show-hn",
      stepIndex: 0,
      stage: "first_touch",
      body: "v3",
      rejected: [{ body: "v1" }],
    });
    expect(obs[0]!.isNew).toBe(true);
    expect(ledger.learning.draftObservationsSince(obs[0]!.id)).toEqual([]);
    // A later send brings the earlier one along as context, flagged old.
    ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Later" },
      dedupeKey: "c",
      source: "find:show-hn",
    });
    ledger.setQueueDraft({ id: 3, draft: draft("l1") });
    ledger.setQueueDraft({ id: 3, draft: draft("l1", true), sentBy: "human" });
    const window = ledger.learning.draftObservationsSince(obs[0]!.id);
    expect(window.map((o) => [o.body, o.isNew])).toEqual([
      ["v3", false],
      ["l1", true],
    ]);
    expect(ledger.learning.draftObservationsSince(obs[0]!.id, 100, 0).map((o) => o.body)).toEqual([
      "l1",
    ]);
  });
});
