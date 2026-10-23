import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const spend = vi.hoisted(() => ({ refuse: false, reserved: 0 }));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    tryReserveDailySpend: (amount: number) => {
      if (spend.refuse)
        return { granted: false, reason: "daily spend ceiling reached", status: {} };
      spend.reserved += amount;
      return { granted: true, release: () => {}, status: {} };
    },
  };
});

const { getLedger, loadConfig, productBriefText } = await import("@oneshot-gtm/core");
const {
  approveCodeAnswer,
  captureCodeQuestion,
  codeAnswersForThread,
  deriveCodeAnswer,
  dismissCodeAnswer,
  listCodeAnswers,
  sweepCodeAnswers,
  testSourceRepo,
} = await import("../src/code-answers.ts");

// Answers from your code end to end over a real temp git checkout: capture,
// derive (model steps stubbed), approve into the brief, and the staleness
// sweep when the code changes.

const QUESTION = "What happens when two people approve the same item at once?";

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

let dir: string;
let cfg: ReturnType<typeof loadConfig>;
const pick = vi.fn();
const answer = vi.fn();
const deps = { pick, answer };
const ledger = () => getLedger();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-code-answers-"));
  git(dir, "init", "-q", "-b", "main");
  write(dir, "src/approve.ts", "export function approve() { /* first wins */ }\n");
  write(dir, "src/other.ts", "export const other = 1;\n");
  write(dir, "README.md", "# Widgets\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  cfg = { ...loadConfig(), productBrief: "Widgets approves things.", sourceRepo: { path: dir } };
  ledger().codeAnswers.db.exec("DELETE FROM code_answers");
  pick.mockReset().mockResolvedValue(["src/approve.ts"]);
  answer.mockReset().mockResolvedValue({
    answered: true,
    answer: "Only the first approval goes through.",
    rewritten: false,
  });
  spend.refuse = false;
  spend.reserved = 0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function captured(threadKey = "thread-1") {
  const out = captureCodeQuestion({ question: QUESTION, threadKey, ledger: ledger(), cfg });
  if (!out) throw new Error("not captured");
  return out;
}

describe("captureCodeQuestion", () => {
  it("asks for a derive only for a new question with a repo connected", () => {
    const first = captured();
    expect(first).toMatchObject({ created: true, shouldDerive: true });
    expect(first.answer).toMatchObject({ status: "open", askedCount: 1 });
    const off = captureCodeQuestion({
      question: "Can I export everything as a spreadsheet file?",
      ledger: ledger(),
      cfg: { sourceRepo: undefined },
    });
    expect(off?.shouldDerive).toBe(false);
  });
});

describe("deriveCodeAnswer", () => {
  it("reads the picked files at one commit and lands pending", async () => {
    const { answer: row } = captured();
    const out = await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    expect(out.status).toBe("pending");
    expect(out.answer).toMatchObject({
      status: "pending",
      answer: "Only the first approval goes through.",
      files: [{ path: "src/approve.ts" }],
      commit: git(dir, "rev-parse", "HEAD"),
      deriving: false,
    });
    expect(pick.mock.calls[0]![0]).toMatchObject({
      question: QUESTION,
      paths: ["README.md", "src/approve.ts", "src/other.ts"],
      readme: "# Widgets\n",
    });
    expect(answer.mock.calls[0]![0]).toMatchObject({
      strict: true,
      sources: [{ path: "src/approve.ts", content: expect.stringContaining("first wins") }],
    });
    expect(spend.reserved).toBe(1);
    expect(codeAnswersForThread("thread-1", { ledger: ledger() })[0]?.status).toBe("pending");
  });

  it("stores why when the code does not settle it", async () => {
    const { answer: row } = captured();
    answer.mockResolvedValueOnce({ answered: false, why: "the source does not show it" });
    const out = await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    expect(out.answer).toMatchObject({
      status: "unresolved",
      whyUnresolved: "the source does not show it",
    });
  });

  it("is unresolved without a model answer when no file looks related", async () => {
    const { answer: row } = captured();
    pick.mockResolvedValueOnce([]);
    const out = await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    expect(out.status).toBe("unresolved");
    expect(answer).not.toHaveBeenCalled();
  });

  it("does not call the model again while the files are unchanged", async () => {
    const { answer: row } = captured();
    await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    // An unrelated file moving does not count.
    write(dir, "src/other.ts", "export const other = 2;\n");
    git(dir, "commit", "-q", "-am", "unrelated");
    const again = await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    expect(again.status).toBe("cached");
    expect(again.answer?.commit).toBe(git(dir, "rev-parse", "HEAD"));
    expect(pick).toHaveBeenCalledTimes(1);
    const forced = await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps, force: true });
    expect(forced.status).toBe("pending");
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it("stops at the daily spend ceiling and leaves the row open", async () => {
    const { answer: row } = captured();
    spend.refuse = true;
    const out = await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    expect(out).toMatchObject({ status: "failed", reason: "daily spend ceiling reached" });
    expect(out.answer).toMatchObject({ status: "open", deriving: false });
    expect(pick).not.toHaveBeenCalled();
  });

  it("never throws: a failing model leaves the row as it was", async () => {
    const { answer: row } = captured();
    pick.mockRejectedValueOnce(new Error("provider down"));
    const out = await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    expect(out).toMatchObject({ status: "failed", reason: "provider down" });
    expect(out.answer?.status).toBe("open");
  });

  it("skips a decided question", async () => {
    const { answer: row } = captured();
    await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    dismissCodeAnswer(row.id, { ledger: ledger() });
    expect((await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps })).status).toBe(
      "skipped",
    );
  });
});

describe("approve and the brief", () => {
  it("an approved answer joins the brief", async () => {
    const { answer: row } = captured();
    await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    expect(productBriefText(cfg, ledger())).toBe("Widgets approves things.");
    expect(approveCodeAnswer(row.id, { by: "founder", ledger: ledger() })).toMatchObject({
      answer: { status: "approved" },
    });
    expect(productBriefText(cfg, ledger())).toContain(
      `- ${QUESTION}\n  Only the first approval goes through.`,
    );
    expect(listCodeAnswers({ ledger: ledger() })[0]?.status).toBe("approved");
  });
});

describe("sweepCodeAnswers", () => {
  async function approved(text?: string) {
    const { answer: row } = captured();
    await deriveCodeAnswer(row.id, { cfg, ledger: ledger(), deps });
    approveCodeAnswer(row.id, { by: "founder", text: text ?? null, ledger: ledger() });
    return row.id;
  }

  it("is free when the commit has not moved", async () => {
    const id = await approved();
    const out = await sweepCodeAnswers({ cfg, ledger: ledger(), deps });
    expect(out).toMatchObject({ checked: 0, stale: 0, rederived: 0 });
    expect(ledger().codeAnswers.get(id)?.status).toBe("approved");
  });

  it("carries an unchanged answer to the new commit", async () => {
    const id = await approved();
    write(dir, "src/other.ts", "export const other = 3;\n");
    git(dir, "commit", "-q", "-am", "unrelated");
    const out = await sweepCodeAnswers({ cfg, ledger: ledger(), deps });
    expect(out).toMatchObject({ checked: 1, unchanged: 1, stale: 0 });
    expect(ledger().codeAnswers.get(id)).toMatchObject({
      status: "approved",
      commit: git(dir, "rev-parse", "HEAD"),
    });
  });

  it("a changed file takes the answer out of the brief and re-derives it into pending", async () => {
    const id = await approved();
    write(dir, "src/approve.ts", "export function approve() { /* last wins */ }\n");
    git(dir, "commit", "-q", "-am", "behaviour change");
    answer.mockResolvedValueOnce({
      answered: true,
      answer: "The last approval wins.",
      rewritten: false,
    });
    const out = await sweepCodeAnswers({ cfg, ledger: ledger(), deps });
    expect(out).toMatchObject({ checked: 1, stale: 1, rederived: 1 });
    expect(ledger().codeAnswers.get(id)).toMatchObject({
      status: "pending",
      answer: "The last approval wins.",
    });
    expect(productBriefText(cfg, ledger())).toBe("Widgets approves things.");
  });

  it("a founder-edited answer goes stale with its text kept", async () => {
    const id = await approved("The first one in wins, always.");
    git(dir, "rm", "-q", "src/approve.ts");
    git(dir, "commit", "-q", "-m", "removed");
    const out = await sweepCodeAnswers({ cfg, ledger: ledger(), deps });
    expect(out).toMatchObject({ stale: 1, rederived: 0 });
    expect(ledger().codeAnswers.get(id)).toMatchObject({
      status: "stale",
      answer: "The first one in wins, always.",
      founderEdited: true,
    });
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("is skipped without a repo", async () => {
    expect(
      await sweepCodeAnswers({ cfg: { ...cfg, sourceRepo: undefined }, ledger: ledger() }),
    ).toMatchObject({
      skipped: true,
    });
  });
});

describe("testSourceRepo", () => {
  it("counts readable files at the resolved commit", async () => {
    expect(await testSourceRepo({ path: dir })).toEqual({
      ok: true,
      backend: "local",
      ref: "HEAD",
      commit: git(dir, "rev-parse", "HEAD"),
      readableFiles: 3,
    });
  });

  it("explains what is wrong", async () => {
    expect(await testSourceRepo({ path: join(dir, "missing") })).toMatchObject({
      ok: false,
      backend: "local",
      error: expect.stringContaining("no folder"),
    });
    expect(await testSourceRepo(undefined)).toMatchObject({ ok: false });
  });
});
