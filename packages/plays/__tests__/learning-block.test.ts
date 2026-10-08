import { beforeEach, describe, expect, it } from "vitest";
import { getLedger } from "@oneshot-gtm/core";
import { learningBlock } from "../src/_lib.ts";

// LEARNED WRITING PREFERENCES block (#813): only founder-approved guidance,
// only for the channel and stage being drafted, and nothing at all when
// nothing applies, so an untouched install's prompts are byte-identical.

const ledger = getLedger();
const db = (ledger as unknown as { db: { exec: (sql: string) => void } }).db;

beforeEach(() => {
  for (const table of ["learning_guidance", "learning_state", "learning_proposals"])
    db.exec(`DELETE FROM ${table}`);
});

describe("learningBlock", () => {
  it("is null when nothing is approved", () => {
    expect(learningBlock({ channel: "email", stage: "first_touch" })).toBeNull();
  });

  it("renders only the guidance that matches channel and stage, with a stable key", () => {
    ledger.learning.addGuidance({ instruction: "Lead with the point.", source: "style" });
    ledger.learning.addGuidance({
      instruction: "No greeting in a LinkedIn note.",
      source: "edits",
      channel: "linkedin",
      stage: "first_touch",
    });
    ledger.learning.addGuidance({
      instruction: "Answer the question before anything else.",
      source: "explicit",
      stage: "reply",
    });
    const note = learningBlock({ channel: "linkedin", stage: "first_touch" })!;
    expect(note.text).toContain("LEARNED WRITING PREFERENCES");
    expect(note.text).toContain("- Lead with the point.");
    expect(note.text).toContain("- No greeting in a LinkedIn note.");
    expect(note.text).not.toContain("Answer the question");
    expect(note.key).toMatch(/^[0-9a-f]{12}$/);
    const email = learningBlock({ channel: "email", stage: "reply" })!;
    expect(email.text).toContain("- Answer the question before anything else.");
    expect(email.text).not.toContain("LinkedIn note");
    expect(email.key).not.toBe(note.key);
    expect(learningBlock({ channel: "linkedin", stage: "first_touch" })!.key).toBe(note.key);
  });

  it("drops a disabled or rolled-back row and changes the key", () => {
    const g = ledger.learning.addGuidance({ instruction: "Lead with the point.", source: "style" });
    const before = learningBlock({ channel: "email", stage: "follow_up" })!.key;
    ledger.learning.setGuidanceEnabled(g.id, false);
    expect(learningBlock({ channel: "email", stage: "follow_up" })).toBeNull();
    ledger.learning.setGuidanceEnabled(g.id, true);
    expect(learningBlock({ channel: "email", stage: "follow_up" })!.key).not.toBe(before);
    ledger.learning.rollbackGuidance(g.id);
    expect(learningBlock({ channel: "email", stage: "follow_up" })).toBeNull();
  });

  it("never reads a pending proposal", () => {
    ledger.learning.insert({
      kind: "preference",
      scope: { channel: "email" },
      current: null,
      proposed: { instruction: "Pending only.", source: "edits" },
      evidence: { refs: [] },
      evidenceSummary: "x",
      baselineKey: "",
      dedupeKey: "pending only",
    });
    expect(learningBlock({ channel: "email", stage: "first_touch" })).toBeNull();
  });
});
