import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
import { angleTextKey, draftVersionAngle } from "../src/ledger-drafts.ts";

/**
 * Draft versions (ledger-drafts.ts): every draft put in front of the founder
 * leaves a row, intro (target_queue) and follow-up (cadence_state) alike, and
 * the ledger's own draft setters/clearers are the only writers.
 */

let dbPath: string;
let ledger: Ledger;

/** A second connection for writing the pre-versioning envelopes the tests plant. */
function rawDb(): Database {
  return new Database(dbPath);
}

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-draft-versions-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // already gone
    }
  }
});

const ANGLE_A = {
  text: "For a founder selling to clinics — the stack breaks",
  origin: "configured" as const,
};
const ANGLE_B = {
  text: "For a CTO shipping agents — egress is the hole",
  origin: "configured" as const,
};

function enqueue(email: string, play = "luma-events"): number {
  const id = ledger.enqueueTarget({
    playName: play,
    payload: { email, name: "P", yourEdge: `${ANGLE_A.text} // ${ANGLE_B.text}` },
    dedupeKey: `k:${email}`,
    source: "test",
  });
  if (id == null) throw new Error("enqueue failed");
  return id;
}

function draft(over: Partial<Parameters<Ledger["setQueueDraft"]>[0]["draft"]> = {}) {
  return {
    subject: "s",
    body: "body one",
    flags: [],
    sent: false,
    receiptIds: [],
    dryRun: true,
    ...over,
  };
}

describe("helpers", () => {
  it("angleTextKey normalizes case and punctuation", () => {
    expect(angleTextKey("For a Founder — selling to clinics!")).toBe(
      "for a founder selling to clinics",
    );
    expect(angleTextKey("  x  ")).toBe("x");
  });
  it("draftVersionAngle shape-checks and defaults origin", () => {
    expect(draftVersionAngle(null)).toBeNull();
    expect(draftVersionAngle({ text: "  " })).toBeNull();
    expect(draftVersionAngle({ text: "a" })).toEqual({ text: "a", origin: "configured" });
    expect(draftVersionAngle({ text: "a", origin: "generated" })).toEqual({
      text: "a",
      origin: "generated",
    });
  });
});

describe("intro drafts (target_queue)", () => {
  it("first draft opens a version; a regenerate discards it with the reason and opens the next", () => {
    const id = enqueue("a@x.dev");
    ledger.setQueueDraft({ id, draft: draft({ angle: ANGLE_A }) });
    let versions = ledger.draftVersionsFor({ queueId: id });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      outcome: "open",
      step_index: 0,
      queue_id: id,
      prospect_key: "a@x.dev",
      angle_key: angleTextKey(ANGLE_A.text),
      angle_text: ANGLE_A.text,
      angle_origin: "configured",
    });

    ledger.setQueueDraft({
      id,
      draft: draft({ body: "body two", angle: ANGLE_B }),
      discardReason: "rotate",
    });
    versions = ledger.draftVersionsFor({ queueId: id });
    expect(versions.map((v) => [v.body, v.outcome, v.discard_reason])).toEqual([
      ["body two", "open", null],
      ["body one", "discarded", "rotate"],
    ]);
    expect(versions[1]!.closed_at).not.toBeNull();
  });

  it("defaults the discard reason to redraft (a machine re-draft is no judgment)", () => {
    const id = enqueue("b@x.dev");
    ledger.setQueueDraft({ id, draft: draft() });
    ledger.setQueueDraft({ id, draft: draft({ body: "again" }) });
    expect(ledger.draftVersionsFor({ queueId: id })[1]).toMatchObject({
      outcome: "discarded",
      discard_reason: "redraft",
    });
  });

  it("setQueueDraftIfCurrent versions the same way and carries its reason", () => {
    const id = enqueue("c@x.dev");
    ledger.setQueueDraft({ id, draft: draft() });
    const row = ledger.getQueueRow(id)!;
    const saved = ledger.setQueueDraftIfCurrent({
      id,
      previousDraft: row.last_draft_json,
      previousPayload: row.payload_json,
      draft: draft({ body: "regenerated" }),
      discardReason: "regenerate",
    });
    expect(saved).toBe(true);
    expect(
      ledger.draftVersionsFor({ queueId: id }).map((v) => [v.outcome, v.discard_reason]),
    ).toEqual([
      ["open", null],
      ["discarded", "regenerate"],
    ]);
    // A stale CAS write records nothing.
    const stale = ledger.setQueueDraftIfCurrent({
      id,
      previousDraft: row.last_draft_json,
      previousPayload: row.payload_json,
      draft: draft({ body: "lost race" }),
    });
    expect(stale).toBe(false);
    expect(ledger.draftVersionsFor({ queueId: id })).toHaveLength(2);
  });

  it("a human send closes the open version as sent; a machine send as auto_sent", () => {
    const human = enqueue("d@x.dev");
    ledger.setQueueDraft({ id: human, draft: draft({ angle: ANGLE_A }) });
    ledger.setQueueDraft({
      id: human,
      draft: draft({ sent: true, dryRun: false, receiptIds: [1], angle: ANGLE_A }),
      sentBy: "human",
    });
    expect(ledger.draftVersionsFor({ queueId: human })).toHaveLength(1);
    expect(ledger.draftVersionsFor({ queueId: human })[0]).toMatchObject({ outcome: "sent" });

    const machine = enqueue("e@x.dev");
    ledger.setQueueDraft({ id: machine, draft: draft({ angle: ANGLE_A }) });
    ledger.setQueueDraft({
      id: machine,
      draft: draft({ sent: true, dryRun: false, receiptIds: [2], angle: ANGLE_A }),
      sentBy: "machine",
    });
    expect(ledger.draftVersionsFor({ queueId: machine })[0]).toMatchObject({
      outcome: "auto_sent",
    });
  });

  it("a drain that drafts and sends in one pass records the sent text directly", () => {
    const id = enqueue("f@x.dev");
    ledger.setQueueDraft({
      id,
      draft: draft({ sent: true, dryRun: false, receiptIds: [3], angle: ANGLE_B }),
      sentBy: "machine",
    });
    const versions = ledger.draftVersionsFor({ queueId: id });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ outcome: "auto_sent", angle_text: ANGLE_B.text });
  });

  it("a send whose body differs from the open draft discards it as a redraft and records what shipped", () => {
    const id = enqueue("g@x.dev");
    ledger.setQueueDraft({ id, draft: draft({ body: "previewed" }) });
    ledger.setQueueDraft({
      id,
      draft: draft({ body: "re-drafted and sent", sent: true, dryRun: false, receiptIds: [4] }),
      sentBy: "machine",
    });
    expect(
      ledger.draftVersionsFor({ queueId: id }).map((v) => [v.body, v.outcome, v.discard_reason]),
    ).toEqual([
      ["re-drafted and sent", "auto_sent", null],
      ["previewed", "discarded", "redraft"],
    ]);
  });

  it("error stubs and empty bodies are not versions", () => {
    const id = enqueue("h@x.dev");
    ledger.setQueueDraft({
      id,
      draft: draft({ subject: "(error)", body: "", flags: ["error: boom"] }),
    });
    ledger.setQueueDraft({ id, draft: draft({ body: "   " }) });
    expect(ledger.draftVersionsFor({ queueId: id })).toHaveLength(0);
  });

  it("a draft stored before versioning existed is seeded as what the first regenerate replaced", () => {
    const id = enqueue("pre@x.dev");
    // Write the envelope directly, the way every row looked before draft_versions.
    rawDb()
      .prepare(`UPDATE target_queue SET last_draft_json = ?, last_drafted_at = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          subject: "old subject",
          body: "old body",
          flags: [],
          sent: false,
          receiptIds: [],
          dryRun: true,
          draftedAt: "2026-09-10T10:00:00.000Z",
          angle: ANGLE_A,
        }),
        "2026-09-10T10:00:00.000Z",
        id,
      );
    expect(ledger.draftVersionsFor({ queueId: id })).toHaveLength(0);
    ledger.setQueueDraft({
      id,
      draft: draft({ body: "new body", angle: ANGLE_B }),
      discardReason: "rotate",
    });
    const versions = ledger.draftVersionsFor({ queueId: id });
    expect(versions.map((v) => [v.body, v.outcome, v.discard_reason, v.angle_text])).toEqual([
      ["new body", "open", null, ANGLE_B.text],
      ["old body", "discarded", "rotate", ANGLE_A.text],
    ]);
    // The seeded version keeps the time it was really drafted.
    expect(versions[1]!.created_at).toBe("2026-09-10T10:00:00.000Z");
  });

  it("a pre-versioning draft sent verbatim (send-draft or mark-sent) is recorded as sent, once", () => {
    const sendDraft = enqueue("pre2@x.dev");
    const stored = JSON.stringify({ subject: "s", body: "reviewed body", flags: [], sent: false });
    rawDb()
      .prepare(`UPDATE target_queue SET last_draft_json = ? WHERE id = ?`)
      .run(stored, sendDraft);
    ledger.setQueueDraft({
      id: sendDraft,
      draft: draft({ body: "reviewed body", sent: true, dryRun: false, receiptIds: [9] }),
      sentBy: "human",
    });
    expect(ledger.draftVersionsFor({ queueId: sendDraft }).map((v) => [v.body, v.outcome])).toEqual(
      [["reviewed body", "sent"]],
    );

    const markSent = enqueue("pre3@x.dev");
    rawDb()
      .prepare(`UPDATE target_queue SET last_draft_json = ? WHERE id = ?`)
      .run(stored, markSent);
    expect(ledger.closeQueueDraftVersion(markSent, "sent")).toBe(true);
    expect(ledger.draftVersionsFor({ queueId: markSent }).map((v) => [v.body, v.outcome])).toEqual([
      ["reviewed body", "sent"],
    ]);
    // An already-sent or error envelope seeds nothing.
    const sentEnv = enqueue("pre4@x.dev");
    rawDb()
      .prepare(`UPDATE target_queue SET last_draft_json = ? WHERE id = ?`)
      .run(JSON.stringify({ subject: "s", body: "gone out", flags: [], sent: true }), sentEnv);
    expect(ledger.closeQueueDraftVersion(sentEnv, "sent")).toBe(false);
  });

  it("closeQueueDraftVersion closes the open version (mark-sent path) and reports when nothing is open", () => {
    const id = enqueue("i@x.dev");
    expect(ledger.closeQueueDraftVersion(id, "sent")).toBe(false);
    ledger.setQueueDraft({ id, draft: draft() });
    expect(ledger.closeQueueDraftVersion(id, "sent")).toBe(true);
    expect(ledger.draftVersionsFor({ queueId: id })[0]).toMatchObject({ outcome: "sent" });
    expect(ledger.closeQueueDraftVersion(id, "sent")).toBe(false);
  });

  it("falls back to the dedupe key when the payload has no email", () => {
    const id = ledger.enqueueTarget({
      playName: "x-amplify-dm",
      payload: { handle: "@p" },
      dedupeKey: "x:@p",
      source: "test",
    })!;
    ledger.setQueueDraft({ id, draft: draft() });
    expect(ledger.draftVersionsFor({ queueId: id })[0]!.prospect_key).toBe("x:@p");
  });
});

const payload = (angle?: { text: string; origin: "configured" | "generated" }) => ({
  kind: "email",
  subject: "follow",
  body: "follow body",
  ...(angle ? { angle } : {}),
});

describe("follow-up drafts (cadence_state)", () => {
  function cadence(email: string, play = "stack-consolidation"): number {
    const prospectId = ledger.upsertProspect({ name: "P", email, company: null, source: "test" });
    ledger.enrollCadence({ prospectId, playName: play, nextDueAt: new Date().toISOString() });
    return prospectId;
  }
  it("a preview opens a version for current_step + 1 with the payload's angle", () => {
    const pid = cadence("j@x.dev");
    ledger.setCadenceDraft({
      prospectId: pid,
      playName: "stack-consolidation",
      draft: { subject: "follow", body: "follow body", flags: [], payload: payload(ANGLE_B) },
      discardReason: "regenerate",
    });
    const slot = { prospectId: pid, playName: "stack-consolidation", stepIndex: 1 };
    const versions = ledger.draftVersionsFor(slot);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      outcome: "open",
      step_index: 1,
      prospect_id: pid,
      queue_id: null,
      prospect_key: "j@x.dev",
      angle_text: ANGLE_B.text,
    });
  });

  it("a second preview discards the first as regenerated; advanceCadence closes the open one as sent", () => {
    const pid = cadence("k@x.dev");
    const input = { prospectId: pid, playName: "stack-consolidation" };
    ledger.setCadenceDraft({
      ...input,
      draft: { subject: "a", body: "one", flags: [], payload: payload() },
      discardReason: "regenerate",
    });
    ledger.setCadenceDraft({
      ...input,
      draft: { subject: "a", body: "two", flags: [], payload: payload() },
      discardReason: "regenerate",
    });
    ledger.advanceCadence({ ...input, newStep: 1, nextDueAt: null });
    const versions = ledger.draftVersionsFor({ ...input, stepIndex: 1 });
    expect(versions.map((v) => [v.body, v.outcome, v.discard_reason])).toEqual([
      ["two", "sent", null],
      ["one", "discarded", "regenerate"],
    ]);
    // The next preview is for step 2 — a fresh slot.
    ledger.setCadenceDraft({
      ...input,
      draft: { subject: "b", body: "three", flags: [], payload: payload() },
    });
    expect(ledger.draftVersionsFor({ ...input, stepIndex: 2 })).toHaveLength(1);
    expect(ledger.draftVersionsFor({ ...input, stepIndex: 1 })).toHaveLength(2);
  });

  it("a cadence preview stored before versioning is seeded on the next preview and on send", () => {
    const play = "stack-consolidation";
    const stored = JSON.stringify({
      subject: "old follow",
      body: "old follow body",
      flags: [],
      payload: { kind: "email", subject: "old follow", body: "old follow body", angle: ANGLE_B },
      draftedAt: "2026-09-11T09:00:00.000Z",
    });
    const write = (pid: number) =>
      rawDb()
        .prepare(
          `UPDATE cadence_state SET next_step_draft_json = ? WHERE prospect_id = ? AND play_name = ?`,
        )
        .run(stored, pid, play);

    const regenerated = cadence("q@x.dev");
    write(regenerated);
    ledger.setCadenceDraft({
      prospectId: regenerated,
      playName: play,
      draft: { subject: "new", body: "new follow body", flags: [], payload: payload(ANGLE_A) },
      discardReason: "regenerate",
    });
    expect(
      ledger
        .draftVersionsFor({ prospectId: regenerated, playName: play, stepIndex: 1 })
        .map((v) => [v.body, v.outcome, v.discard_reason, v.angle_text, v.created_at]),
    ).toEqual([
      ["new follow body", "open", null, ANGLE_A.text, expect.any(String)],
      ["old follow body", "discarded", "regenerate", ANGLE_B.text, "2026-09-11T09:00:00.000Z"],
    ]);

    const sent = cadence("r@x.dev");
    write(sent);
    ledger.advanceCadence({ prospectId: sent, playName: play, newStep: 1, nextDueAt: null });
    expect(
      ledger
        .draftVersionsFor({ prospectId: sent, playName: play, stepIndex: 1 })
        .map((v) => [v.body, v.outcome]),
    ).toEqual([["old follow body", "sent"]]);
  });

  it("breakup closes as sent; other terminal statuses, stop, clear and reply abandon the open draft", () => {
    const play = "stack-consolidation";
    const mk = (email: string) => {
      const pid = cadence(email);
      ledger.setCadenceDraft({
        prospectId: pid,
        playName: play,
        draft: { subject: "s", body: "b", flags: [], payload: payload() },
      });
      return pid;
    };
    const outcome = (pid: number) => {
      const v = ledger.draftVersionsFor({ prospectId: pid, playName: play, stepIndex: 1 })[0]!;
      return [v.outcome, v.discard_reason];
    };

    const breakup = mk("l@x.dev");
    ledger.setCadenceStatus({ prospectId: breakup, playName: play, status: "breakup" });
    expect(outcome(breakup)).toEqual(["sent", null]);

    const replied = mk("m@x.dev");
    ledger.setCadenceStatus({ prospectId: replied, playName: play, status: "replied" });
    expect(outcome(replied)).toEqual(["discarded", "abandoned"]);

    const stopped = mk("n@x.dev");
    expect(ledger.stopCadence({ prospectId: stopped, playName: play, reason: "other" })).toBe(true);
    expect(outcome(stopped)).toEqual(["discarded", "abandoned"]);

    const cleared = mk("o@x.dev");
    ledger.clearCadenceDraft({ prospectId: cleared, playName: play });
    expect(outcome(cleared)).toEqual(["discarded", "abandoned"]);

    const active = mk("p@x.dev");
    ledger.setCadenceStatus({ prospectId: active, playName: play, status: "active" });
    expect(outcome(active)).toEqual(["open", null]);
  });
});

describe("aggregates", () => {
  it("angleUsageByPlay counts distinct prospects per angle and draftUsageByPlay splits intro from follow-up", () => {
    const play = "luma-events";
    // Prospect 1: shown A, rotated to B, sent B.
    const q1 = enqueue("u1@x.dev", play);
    ledger.setQueueDraft({ id: q1, draft: draft({ angle: ANGLE_A }) });
    ledger.setQueueDraft({
      id: q1,
      draft: draft({ body: "b2", angle: ANGLE_B }),
      discardReason: "rotate",
    });
    ledger.setQueueDraft({
      id: q1,
      draft: draft({ body: "b2", sent: true, dryRun: false, angle: ANGLE_B }),
      sentBy: "human",
    });
    // Prospect 2: shown A twice (regenerated), sent A.
    const q2 = enqueue("u2@x.dev", play);
    ledger.setQueueDraft({ id: q2, draft: draft({ angle: ANGLE_A }) });
    ledger.setQueueDraft({
      id: q2,
      draft: draft({ body: "b3", angle: ANGLE_A }),
      discardReason: "regenerate",
    });
    ledger.setQueueDraft({
      id: q2,
      draft: draft({ body: "b3", sent: true, dryRun: false, angle: ANGLE_A }),
      sentBy: "human",
    });
    // Prospect 3: drain sent A unseen.
    const q3 = enqueue("u3@x.dev", play);
    ledger.setQueueDraft({
      id: q3,
      draft: draft({ sent: true, dryRun: false, angle: ANGLE_A }),
      sentBy: "machine",
    });
    // Prospect 4: a generated alternative, still open.
    const q4 = enqueue("u4@x.dev", play);
    ledger.setQueueDraft({
      id: q4,
      draft: draft({ angle: { text: "Made-up angle", origin: "generated" } }),
    });
    // A follow-up on prospect 1, sent on angle A.
    const pid = ledger.upsertProspect({
      name: "U1",
      email: "u1@x.dev",
      company: null,
      source: "test",
    });
    ledger.enrollCadence({ prospectId: pid, playName: play, nextDueAt: new Date().toISOString() });
    ledger.setCadenceDraft({
      prospectId: pid,
      playName: play,
      draft: {
        subject: "f",
        body: "f1",
        flags: [],
        payload: { kind: "email", subject: "f", body: "f1", angle: ANGLE_A },
      },
      discardReason: "regenerate",
    });
    ledger.setCadenceDraft({
      prospectId: pid,
      playName: play,
      draft: {
        subject: "f",
        body: "f2",
        flags: [],
        payload: { kind: "email", subject: "f", body: "f2", angle: ANGLE_A },
      },
      discardReason: "regenerate",
    });
    ledger.advanceCadence({ prospectId: pid, playName: play, newStep: 1, nextDueAt: null });

    const usage = ledger.angleUsageByPlay()[play]!;
    const byText = Object.fromEntries(usage.map((r) => [r.angleText, r]));
    // A: offered to u1, u2, u3 and (follow-up) u1 again → 3 distinct; rotated away by u1; redrafted by u2 and (follow-up) u1; sent by u2 and u1's follow-up; auto-sent to u3.
    expect(byText[ANGLE_A.text]).toMatchObject({
      origin: "configured",
      offered: 3,
      rotatedAway: 1,
      redrafted: 2,
      sent: 2,
      autoSent: 1,
    });
    expect(byText[ANGLE_B.text]).toMatchObject({
      offered: 1,
      rotatedAway: 0,
      redrafted: 0,
      sent: 1,
      autoSent: 0,
    });
    expect(byText["Made-up angle"]).toMatchObject({ origin: "generated", offered: 1, sent: 0 });
    expect(ledger.angleUsageByPlay()["other-play"]).toBeUndefined();

    expect(ledger.draftUsageByPlay()[play]).toEqual({
      intro: { open: 1, regenerated: 1, rotated: 1, sent: 2, autoSent: 1, replied: 0 },
      followUp: { open: 0, regenerated: 1, rotated: 0, sent: 1, autoSent: 0, replied: 0 },
    });
    expect(ledger.draftUsageByPlay()["other-play"]).toBeUndefined();
  });

  it("credits one reply once, to the latest send in the slot", () => {
    const play = "double-send";
    const q1 = enqueue("dd@x.dev", play);
    ledger.setQueueDraft({
      id: q1,
      draft: draft({ sent: true, dryRun: false, angle: ANGLE_A }),
      sentBy: "human",
    });
    // The same person reached again through a second row: a second sent
    // version in the same prospect/play/step slot, on another angle.
    const q2 = ledger.enqueueTarget({
      playName: play,
      payload: { email: "dd@x.dev", name: "P", yourEdge: `${ANGLE_A.text} // ${ANGLE_B.text}` },
      dedupeKey: "k2:dd@x.dev",
      source: "test",
    })!;
    ledger.setQueueDraft({
      id: q2,
      draft: draft({ sent: true, dryRun: false, angle: ANGLE_B }),
      sentBy: "human",
    });
    const p = ledger.upsertProspect({ name: "DD", email: "dd@x.dev", company: null, source: "t" });
    ledger.recordSequenceEvent({
      prospectId: p,
      playName: play,
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    ledger.markLatestStepReplied({ prospectId: p, playName: play });
    const byText = Object.fromEntries(
      ledger.angleUsageByPlay()[play]!.map((r) => [r.angleText, r]),
    );
    expect(byText[ANGLE_A.text]?.replied).toBe(0);
    expect(byText[ANGLE_B.text]?.replied).toBe(1);
    expect(ledger.draftUsageByPlay()[play]?.intro.replied).toBe(1);
  });

  it("counts a person reached by both a reviewed and an unattended send once", () => {
    const play = "reached-union";
    const q1 = enqueue("ru@x.dev", play);
    ledger.setQueueDraft({
      id: q1,
      draft: draft({ sent: true, dryRun: false, angle: ANGLE_A }),
      sentBy: "human",
    });
    const q2 = ledger.enqueueTarget({
      playName: play,
      payload: { email: "ru@x.dev", name: "P", yourEdge: ANGLE_A.text },
      dedupeKey: "k2:ru@x.dev",
      source: "test",
    })!;
    ledger.setQueueDraft({
      id: q2,
      draft: draft({ sent: true, dryRun: false, angle: ANGLE_A }),
      sentBy: "machine",
    });
    const row = ledger.angleUsageByPlay()[play]!.find((r) => r.angleText === ANGLE_A.text)!;
    expect(row).toMatchObject({ sent: 1, autoSent: 1, reached: 1 });
  });

  it("credits a reply to the angle and step of the send that got it", () => {
    const play = "reply-attribution";
    // u10 gets an intro on A and replies to it; u11 gets an intro on B and never replies.
    const q10 = enqueue("u10@x.dev", play);
    ledger.setQueueDraft({
      id: q10,
      draft: draft({ sent: true, dryRun: false, angle: ANGLE_A }),
      sentBy: "human",
    });
    const q11 = enqueue("u11@x.dev", play);
    ledger.setQueueDraft({
      id: q11,
      draft: draft({ sent: true, dryRun: false, angle: ANGLE_B }),
      sentBy: "machine",
    });
    // The intro draft predates the prospect row: attribution goes through the email.
    const p10 = ledger.upsertProspect({
      name: "U10",
      email: "u10@x.dev",
      company: null,
      source: "t",
    });
    const p11 = ledger.upsertProspect({
      name: "U11",
      email: "u11@x.dev",
      company: null,
      source: "t",
    });
    for (const prospectId of [p10, p11]) {
      ledger.recordSequenceEvent({
        prospectId,
        playName: play,
        stepIndex: 0,
        channel: "email",
        status: "sent",
      });
    }
    ledger.markLatestStepReplied({ prospectId: p10, playName: play });

    const byText = Object.fromEntries(
      ledger.angleUsageByPlay()[play]!.map((r) => [r.angleText, r]),
    );
    expect(byText[ANGLE_A.text]).toMatchObject({ sent: 1, replied: 1 });
    expect(byText[ANGLE_B.text]).toMatchObject({ autoSent: 1, replied: 0 });
    expect(ledger.draftUsageByPlay()[play]?.intro).toMatchObject({
      sent: 1,
      autoSent: 1,
      replied: 1,
    });
    expect(ledger.draftUsageByPlay()[play]?.followUp.replied).toBe(0);
    expect(ledger.draftUsageByVoice()[play]?.plain.replied).toBe(1);
  });
});

describe("draft version writer reservations", () => {
  for (const operation of ["queue replace", "queue close", "cadence replace", "cadence advance"]) {
    it(`${operation} reserves the writer before reading the draft it will change`, () => {
      const id = enqueue("locking@x.dev");
      const prospectId = ledger.upsertProspect({
        name: "P",
        email: "locking@x.dev",
        company: null,
        source: "test",
      });
      const playName = "stack-consolidation";
      ledger.enrollCadence({ prospectId, playName, nextDueAt: new Date().toISOString() });
      const db = (ledger as unknown as { db: Database }).db;
      const other = rawDb();
      other.exec("PRAGMA busy_timeout=0");
      const original = db.query;
      let attempted = false;
      db.query = ((...args: Parameters<Database["query"]>) => {
        if (!attempted) {
          attempted = true;
          // A real second connection tries to replace the source envelope at
          // the first read. It must be excluded until this operation commits.
          expect(() =>
            other.prepare("UPDATE target_queue SET last_draft_json = NULL WHERE id = ?").run(id),
          ).toThrow(/locked|busy/i);
        }
        return original.apply(db, args);
      }) as Database["query"];
      try {
        if (operation === "queue replace") ledger.setQueueDraft({ id, draft: draft() });
        if (operation === "queue close") ledger.closeQueueDraftVersion(id, "sent");
        if (operation === "cadence replace")
          ledger.setCadenceDraft({
            prospectId,
            playName,
            draft: { subject: "s", body: "b", flags: [], payload: payload() },
          });
        if (operation === "cadence advance")
          ledger.advanceCadence({ prospectId, playName, newStep: 1, nextDueAt: null });
        expect(attempted).toBe(true);
      } finally {
        db.query = original;
        other.close();
      }
    });
  }
});

describe("voice_key on versions", () => {
  it("carries the draft's voiceKey through the queue path and splits usage by voice on/off", () => {
    const play = "luma-events";
    const q1 = enqueue("v1@x.dev", play);
    ledger.setQueueDraft({ id: q1, draft: draft({ voiceKey: "abcd1234" } as never) });
    ledger.setQueueDraft({
      id: q1,
      draft: draft({ body: "b2", voiceKey: "abcd1234" } as never),
      discardReason: "regenerate",
    });
    ledger.setQueueDraft({
      id: q1,
      draft: draft({ body: "b2", sent: true, dryRun: false, voiceKey: "abcd1234" } as never),
      sentBy: "human",
    });
    const q2 = enqueue("v2@x.dev", play);
    ledger.setQueueDraft({ id: q2, draft: draft({}) });
    ledger.setQueueDraft({
      id: q2,
      draft: draft({ body: "b3", sent: true, dryRun: false }),
      sentBy: "human",
    });
    const keys = ledger.draftVersionsFor({ queueId: q1 }).map((v) => v.voice_key);
    expect(keys).toEqual(["abcd1234", "abcd1234"]);
    expect(ledger.draftVersionsFor({ queueId: q2 }).map((v) => v.voice_key)).toEqual([null, null]);
    const split = ledger.draftUsageByVoice()[play]!;
    expect(split.voiced).toMatchObject({ sent: 1, regenerated: 1 });
    expect(split.plain).toMatchObject({ sent: 1, regenerated: 0 });
  });
});
