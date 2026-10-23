import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import { LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION } from "../src/ledger-schema.ts";
import {
  normalizeQuestion,
  questionSimilarity,
  toCodeAnswerView,
  type CodeAnswerFile,
} from "../src/code-answers-store.ts";
import { CODE_ANSWERS_HEADING, productBriefText } from "../src/product-brief.ts";

// Answers from your code: the ledger half. One row per question, folded by
// near-duplicate, with guarded status transitions; only approved answers
// reach the composed brief.

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-code-answers-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

const FILES: CodeAnswerFile[] = [{ path: "src/approve.ts", sha256: "a".repeat(64) }];
const COMMIT = "1".repeat(40);

function derived(id: string, status: "pending" | "unresolved" = "pending") {
  return ledger.codeAnswers.recordDerive(id, {
    status,
    answer: status === "pending" ? "Two approvals of the same item never both go through." : null,
    why: status === "unresolved" ? "the source does not show it" : null,
    files: FILES,
    commit: COMMIT,
    promptVersion: "v-test",
    digest: "d1",
  });
}

function capture(question: string, threadKey: string | null = "thread-1") {
  return ledger.codeAnswers.capture({ question, threadKey })!;
}

describe("migration v17", () => {
  it("creates code_answers and is the latest step", () => {
    expect(LEDGER_MIGRATIONS.find((m) => m.name === "code-answers")?.version).toBe(17);
    expect(LEDGER_SCHEMA_VERSION).toBe(17);
    const db = new Database(dbPath);
    try {
      const cols = (
        db.query("PRAGMA table_info(code_answers)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toEqual(
        expect.arrayContaining([
          "question_key",
          "status",
          "files_json",
          "commit_sha",
          "asked_count",
        ]),
      );
    } finally {
      db.close();
    }
  });
});

describe("question identity", () => {
  it("normalizes case and punctuation", () => {
    expect(normalizeQuestion("  How do you handle RETRIES?! ")).toBe("how do you handle retries");
  });

  it("scores rephrasings high and a different subject low", () => {
    expect(
      questionSimilarity(
        "How do you handle concurrent writes to the approval queue?",
        "how do you handle concurrent writes on the approval queues",
      ),
    ).toBeGreaterThanOrEqual(0.8);
    expect(
      questionSimilarity(
        "How do you handle concurrent writes to the approval queue?",
        "How do you handle billing for the approval queue?",
      ),
    ).toBeLessThan(0.8);
  });

  it("matches base forms with their inflections", () => {
    expect(questionSimilarity("How is an invoice created?", "How do you create an invoice?")).toBe(
      1,
    );
    expect(questionSimilarity("Who handles retries?", "What about handling a retry?")).toBe(1);
    expect(questionSimilarity("Do you process boxes?", "Do you process a box?")).toBe(1);
  });
});

describe("capture", () => {
  it("inserts a new question as open", () => {
    const out = capture("What happens when two people approve the same item?");
    expect(out.created).toBe(true);
    expect(out.record).toMatchObject({
      status: "open",
      askedCount: 1,
      sourceThreadKey: "thread-1",
    });
  });

  it("folds a near-duplicate into the existing row and counts each thread once", () => {
    const first = capture("What happens when two people approve the same item?");
    const again = capture("what happens when two people approve the same items", "thread-2");
    expect(again.created).toBe(false);
    expect(again.bumped).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    expect(again.record.askedCount).toBe(2);
    // Regenerating drafts on the same thread does not count as asking again.
    const repeat = capture("What happens when two people approve the same item?", "thread-2");
    expect(repeat.bumped).toBe(false);
    expect(repeat.record.askedCount).toBe(2);
    expect(ledger.codeAnswers.list()).toHaveLength(1);
    expect(ledger.codeAnswers.forThread("thread-2").map((r) => r.id)).toEqual([first.record.id]);
  });

  it("keeps a different question separate", () => {
    capture("What happens when two people approve the same item?");
    capture("Can I export my data as a spreadsheet?");
    expect(ledger.codeAnswers.list()).toHaveLength(2);
  });

  it("refuses text too short to be a question", () => {
    expect(ledger.codeAnswers.capture({ question: "how?" })).toBeNull();
  });
});

describe("transitions", () => {
  it("derive → pending → approved, then markStale takes it out", () => {
    const { record } = capture("What happens when two people approve the same item?");
    expect(ledger.codeAnswers.claimDerive(record.id)).toBe(true);
    // A second derive while the first holds the lease is refused.
    expect(ledger.codeAnswers.claimDerive(record.id)).toBe(false);
    const pending = derived(record.id)!;
    expect(pending).toMatchObject({ status: "pending", commit: COMMIT, deriving: false });
    expect(toCodeAnswerView(pending).files).toEqual([{ path: "src/approve.ts" }]);
    expect(toCodeAnswerView(pending)).not.toHaveProperty("pinned");

    const approved = ledger.codeAnswers.approve(record.id, { by: "founder" });
    expect("record" in approved && approved.record).toMatchObject({
      status: "approved",
      founderEdited: false,
    });
    expect(ledger.codeAnswers.approved()).toHaveLength(1);

    expect(ledger.codeAnswers.markStale(record.id)).toBe(true);
    expect(ledger.codeAnswers.get(record.id)).toMatchObject({
      status: "stale",
      answer: "Two approvals of the same item never both go through.",
    });
    expect(ledger.codeAnswers.approved()).toHaveLength(0);
  });

  it("an edit on approve is the founder's text and keeps the file pins", () => {
    const { record } = capture("What happens when two people approve the same item?");
    derived(record.id);
    const out = ledger.codeAnswers.approve(record.id, {
      text: "Only the first approval counts.",
      by: "f",
    });
    expect("record" in out && out.record).toMatchObject({
      answer: "Only the first approval counts.",
      founderEdited: true,
      files: [{ path: "src/approve.ts" }],
    });
  });

  it("an unresolved question needs the founder's text, which no file pins", () => {
    const { record } = capture("What happens when two people approve the same item?");
    derived(record.id, "unresolved");
    expect(ledger.codeAnswers.get(record.id)?.whyUnresolved).toBe("the source does not show it");
    expect(ledger.codeAnswers.approve(record.id, { by: "f" })).toMatchObject({
      error: expect.stringContaining("write the answer"),
    });
    const out = ledger.codeAnswers.approve(record.id, { text: "The first one wins.", by: "f" });
    expect("record" in out && out.record).toMatchObject({ status: "approved", files: [] });
  });

  it("refuses an answer carrying a link", () => {
    const { record } = capture("What happens when two people approve the same item?");
    derived(record.id);
    expect(
      ledger.codeAnswers.approve(record.id, { text: "See https://example.com/docs", by: "f" }),
    ).toMatchObject({ error: expect.stringContaining("links") });
  });

  it("a derive finishing after the founder decided does not overwrite the decision", () => {
    const { record } = capture("What happens when two people approve the same item?");
    derived(record.id);
    ledger.codeAnswers.approve(record.id, { by: "f" });
    expect(derived(record.id)).toBeNull();
    expect(ledger.codeAnswers.claimDerive(record.id)).toBe(false);
    ledger.codeAnswers.dismiss(record.id, { by: "f" });
    expect(ledger.codeAnswers.get(record.id)?.status).toBe("dismissed");
    expect(derived(record.id)).toBeNull();
    // A dismissed question asked again keeps its status: it only counts.
    const again = capture("What happens when two people approve the same item?", "thread-9");
    expect(again.record).toMatchObject({ status: "dismissed", askedCount: 2 });
  });

  it("markStale ignores rows that are not approved or pending", () => {
    const { record } = capture("What happens when two people approve the same item?");
    expect(ledger.codeAnswers.markStale(record.id)).toBe(false);
  });
});

describe("productBriefText", () => {
  it("is the raw brief until an answer is approved", () => {
    const cfg = { productBrief: "We approve things." };
    const { record } = capture("What happens when two people approve the same item?");
    derived(record.id);
    expect(productBriefText(cfg, ledger)).toBe("We approve things.");
    ledger.codeAnswers.approve(record.id, { by: "f" });
    expect(productBriefText(cfg, ledger)).toBe(
      `We approve things.\n\n${CODE_ANSWERS_HEADING}\n- What happens when two people approve the same item?\n  Two approvals of the same item never both go through.`,
    );
    ledger.codeAnswers.markStale(record.id);
    expect(productBriefText(cfg, ledger)).toBe("We approve things.");
  });

  it("under a cap, clips the founder's brief and keeps the answers whole", () => {
    const cfg = { productBrief: "x".repeat(500) };
    expect(productBriefText(cfg, ledger, { max: 100 })).toBe(`${"x".repeat(99)}…`);
    const { record } = capture("What happens when two people approve the same item?");
    derived(record.id);
    ledger.codeAnswers.approve(record.id, { by: "f" });
    const block = `${CODE_ANSWERS_HEADING}\n- What happens when two people approve the same item?\n  Two approvals of the same item never both go through.`;
    const out = productBriefText(cfg, ledger, { max: 400 })!;
    expect(out.length).toBe(400);
    expect(out.endsWith(`…\n\n${block}`)).toBe(true);
    // A brief that fits is left alone.
    expect(productBriefText({ productBrief: "Short." }, ledger, { max: 400 })).toBe(
      `Short.\n\n${block}`,
    );
  });

  it("adds nothing without a brief, or with no ledger", () => {
    const { record } = capture("What happens when two people approve the same item?");
    derived(record.id);
    ledger.codeAnswers.approve(record.id, { by: "f" });
    expect(productBriefText({ productBrief: null }, ledger)).toBeNull();
    expect(productBriefText({ productBrief: "  " }, ledger)).toBe("  ");
    expect(productBriefText({ productBrief: "Brief." }, null)).toBe("Brief.");
  });
});
