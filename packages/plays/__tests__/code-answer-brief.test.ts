import { beforeEach, describe, expect, it } from "vitest";
import { draftLearningContext, getLedger, loadConfig } from "@oneshot-gtm/core";
import { offerBlock, offerInputHash, offerProductHash } from "../src/_prospect-offer.ts";

// An approved code answer reaches the prompts that read the product brief:
// the offer writer's block (kept whole even when the brief is clipped), the
// offer hashes (so cached offers re-derive), and the reply writer's product
// facts.

const QUESTION = "What happens when two people approve the same item at once?";
const ANSWER = "Only the first approval goes through.";

function approve(): void {
  const store = getLedger().codeAnswers;
  const { record } = store.capture({ question: QUESTION, threadKey: "t1" })!;
  store.recordDerive(record.id, {
    status: "pending",
    answer: ANSWER,
    files: [{ path: "src/approve.ts", sha256: "a".repeat(64) }],
    commit: "1".repeat(40),
    promptVersion: "v",
    digest: "d",
  });
  store.approve(record.id, { by: "founder" });
}

beforeEach(() => {
  getLedger().codeAnswers.db.exec("DELETE FROM code_answers");
});

describe("approved code answers in the brief", () => {
  it("the offer block carries the answer whole when the brief is clipped", () => {
    const cfg = { pilotOffer: null, productBrief: "Widgets approves things. ".repeat(400) };
    const before = offerBlock(null, cfg, "repo-interest")!;
    expect(before).not.toContain(ANSWER);
    approve();
    const after = offerBlock(null, cfg, "repo-interest")!;
    expect(after).toContain(`- ${QUESTION}\n  ${ANSWER}`);
    // The founder's brief is the part that gave way.
    expect(after).toContain("…\n\nHOW IT WORKS");
    expect(after.length).toBeLessThanOrEqual(before.length + 1);
  });

  it("the offer hashes move on approval, so cached offers are re-derived", () => {
    const cfg = {
      productOneLiner: "Widgets",
      productBrief: "Widgets approves things.",
      pilotOffer: null,
    };
    const input = offerInputHash("research", cfg);
    const product = offerProductHash(cfg);
    approve();
    expect(offerInputHash("research", cfg)).not.toBe(input);
    expect(offerProductHash(cfg)).not.toBe(product);
  });

  it("the reply writer's product facts include it", () => {
    const cfg = { ...loadConfig(), productBrief: "Widgets approves things." };
    approve();
    const { text } = draftLearningContext(getLedger(), { channel: "email", stage: "reply", cfg });
    expect(text).toContain(
      `PRODUCT FACTS (the only source of product claims and links):\nWidgets approves things.`,
    );
    expect(text).toContain(ANSWER);
  });
});
