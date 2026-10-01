import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POSITIVE_OUTCOME_INTENTS,
  POSITIVE_REPLY_INTENTS,
  REPLY_INTENTS,
  REPLY_INTENT_LABELS,
  isReplyIntent,
  replyIntentMeta,
} from "@oneshot-gtm/shared-types";
import { TRIAGE_CATEGORIES } from "../src/triage.ts";

// The shared REPLY_INTENTS table is the one source of truth: the LLM prompt,
// the runtime validator, and every consumer list must agree with it.
const TRIAGE_PROMPT = readFileSync(
  join(import.meta.dirname, "..", "..", "prompts", "triage.md"),
  "utf8",
);

function promptCategoryLabels(): string[] {
  const section = TRIAGE_PROMPT.split("## Categories")[1]!.split("\n## ")[0]!;
  return [...section.matchAll(/^- `([a-z_]+)` — /gm)].map((m) => m[1]!);
}

describe("REPLY_INTENTS table", () => {
  it("has 14 unique labels, keeping every pre-table label string", () => {
    expect(new Set(REPLY_INTENT_LABELS).size).toBe(REPLY_INTENTS.length);
    expect(REPLY_INTENTS).toHaveLength(14);
    for (const legacy of [
      "interested",
      "not_now",
      "wrong_person",
      "objection",
      "question",
      "unsubscribe",
      "auto_reply",
      "other",
    ]) {
      expect(isReplyIntent(legacy)).toBe(true);
    }
  });

  it("triage.md lists exactly the table's labels, in table order", () => {
    expect(promptCategoryLabels()).toEqual([...REPLY_INTENT_LABELS]);
  });

  it("the runtime validator is the table", () => {
    expect([...TRIAGE_CATEGORIES].toSorted()).toEqual([...REPLY_INTENT_LABELS].toSorted());
  });

  it("only unsubscribe opts a contact out", () => {
    expect(REPLY_INTENTS.filter((i) => i.optOut).map((i) => i.label)).toEqual(["unsubscribe"]);
    expect(replyIntentMeta("not_interested")?.optOut).toBe(false);
    expect(replyIntentMeta("complaint")?.optOut).toBe(false);
  });

  it("awaiting-reply intents come from needsReply", () => {
    expect([...POSITIVE_REPLY_INTENTS]).toEqual(
      REPLY_INTENTS.filter((i) => i.needsReply).map((i) => i.label),
    );
    expect(POSITIVE_REPLY_INTENTS).toContain("complaint");
    expect(POSITIVE_REPLY_INTENTS).not.toContain("unsubscribe");
    expect(POSITIVE_REPLY_INTENTS).not.toContain("not_interested");
  });

  it("outcome-positive intents exclude the new negatives and pitch-backs", () => {
    for (const neg of ["complaint", "not_interested", "unsubscribe", "pitch_back", "not_now"]) {
      expect(POSITIVE_OUTCOME_INTENTS).not.toContain(neg);
    }
    for (const pos of [
      "interested",
      "question",
      "partnership",
      "meeting",
      "intro",
      "objection",
      "other",
    ]) {
      expect(POSITIVE_OUTCOME_INTENTS).toContain(pos);
    }
  });

  it("an unknown string has no table entry", () => {
    expect(replyIntentMeta("__triage_pending__")).toBeNull();
    expect(replyIntentMeta(null)).toBeNull();
    expect(isReplyIntent("definitely_positive")).toBe(false);
  });
});
