import { describe, expect, it } from "vitest";
import { nearDuplicateOffer, offerContentWords, offersNearDuplicate } from "../src/index.ts";

// One offer reworded must not count as two of the five: the writer drops the
// second, and the queue's Next offer skips it.

const vetting =
  "clear pending carrier vetting backlogs by verifying motor carrier operating authority and active safety records";

describe("offersNearDuplicate", () => {
  it("catches an offer that drops one word from another", () => {
    expect(
      offersNearDuplicate(
        vetting,
        "clear pending carrier vetting backlogs by verifying motor carrier operating authority and safety records",
      ),
    ).toBe(true);
  });

  it("catches the same job with its verbs inflected", () => {
    expect(
      offersNearDuplicate(
        vetting,
        "clearing pending carrier vetting backlogs by verifying motor carrier operating authority and safety records",
      ),
    ).toBe(true);
  });

  it("keeps the same words in another order apart: each action keeps its object", () => {
    expect(
      offersNearDuplicate(
        "collect invoices and verify receipts",
        "collect receipts and verify invoices",
      ),
    ).toBe(false);
  });

  it("keeps an offer and its negation apart", () => {
    expect(offersNearDuplicate("verify invoices are paid", "verify invoices are not paid")).toBe(
      false,
    );
    expect(
      offersNearDuplicate(
        "invoices from approved suppliers can be paid early",
        "invoices from approved suppliers cannot be paid early",
      ),
    ).toBe(false);
    expect(
      offersNearDuplicate(
        "invoices from approved suppliers can be paid early",
        "invoices from approved suppliers can't be paid early",
      ),
    ).toBe(false);
    expect(
      offersNearDuplicate(
        "book repair calls without a dispatcher",
        "book urgent repair calls without a dispatcher",
      ),
    ).toBe(true);
  });

  it("catches an offer that drops one modifier, and no more", () => {
    expect(
      offersNearDuplicate(
        "clear carrier vetting backlogs by verifying motor carrier operating authority and active safety records",
        vetting,
      ),
    ).toBe(true);
    expect(
      offersNearDuplicate(
        "clear carrier vetting backlogs by verifying motor carrier operating authority and safety records",
        vetting,
      ),
    ).toBe(false);
  });

  it("keeps an offer that adds an action, even on an object it already names", () => {
    expect(
      offersNearDuplicate(
        "verify invoices and reconcile receipts",
        "verify invoices and reconcile invoices and verify receipts",
      ),
    ).toBe(false);
    expect(
      offersNearDuplicate("reconcile carrier invoices", "reconcile and dispute carrier invoices"),
    ).toBe(false);
  });

  it("keeps a number's unit: a percentage is not an amount", () => {
    expect(offersNearDuplicate("save 10% on shipping", "save $10 on shipping")).toBe(false);
    expect(
      offersNearDuplicate("save 10 percent on outbound shipping", "save 10 on outbound shipping"),
    ).toBe(false);
    expect(
      offersNearDuplicate("save 10 percent on outbound shipping", "save 10% on outbound shipping"),
    ).toBe(true);
    // A thousands separator is not a clause break.
    expect(
      offersNearDuplicate(
        "recover $10,000 in duplicate carrier charges",
        "recover $10000 in duplicate carrier charges",
      ),
    ).toBe(true);
  });

  it("treats equal text as a duplicate whatever its case and punctuation", () => {
    expect(offersNearDuplicate("Clear the backlog.", "clear the backlog")).toBe(true);
    expect(offersNearDuplicate("the", "The")).toBe(true);
  });

  it("keeps genuinely different offers on the same firm", () => {
    const distinct = [
      "reconcile import duty rates across freight manifests",
      "resolve vendor vat registration mismatches across supplier invoices",
      "cut detention charges by scheduling carrier dock appointments",
      "recover overbilled accessorial charges across carrier invoices",
      "verify carrier insurance certificates before tendering loads",
      "verify carrier operating authority before tendering loads",
      vetting,
    ];
    for (const a of distinct) {
      for (const b of distinct) {
        if (a !== b) expect(offersNearDuplicate(a, b), `${a} | ${b}`).toBe(false);
      }
    }
  });

  it("keeps a different action on the same object", () => {
    expect(
      offersNearDuplicate(
        "verify carrier insurance certificates before tendering loads",
        "collect carrier insurance certificates before tendering loads",
      ),
    ).toBe(false);
  });

  it("reads the action past a preamble and across its inflections", () => {
    expect(
      offersNearDuplicate(
        "I can verify supplier licensing records",
        "Verify supplier licensing records",
      ),
    ).toBe(true);
    expect(
      offersNearDuplicate(
        "create purchase orders from approved supplier quotes",
        "creating purchase orders from approved supplier quotes",
      ),
    ).toBe(true);
    expect(
      offersNearDuplicate(
        "verifies supplier licensing records",
        "verify supplier licensing records",
      ),
    ).toBe(true);
    expect(
      offersNearDuplicate(
        "verified supplier licensing records",
        "verify supplier licensing records",
      ),
    ).toBe(true);
  });

  it("keeps use and US apart", () => {
    expect(offersNearDuplicate("audit use tax returns", "audit US tax returns")).toBe(false);
  });

  it("keeps offers that differ only in a number", () => {
    expect(
      offersNearDuplicate(
        "close the 2025 vat return backlog for the northern depot",
        "close the 2026 vat return backlog for the northern depot",
      ),
    ).toBe(false);
    expect(
      offersNearDuplicate(
        "close the 2025 vat return backlog for the northern depot",
        "close the vat return backlog for the northern depot",
      ),
    ).toBe(false);
    expect(
      offersNearDuplicate(
        "close the 2025 vat return backlog for the northern depot",
        "close the 2025 vat return backlog for the northern depots",
      ),
    ).toBe(true);
  });

  it("reads US as a jurisdiction, not a stopword", () => {
    expect(offerContentWords("file US sales tax returns").has("us")).toBe(true);
    // A name sets the scope: dropping it is a different offer.
    expect(
      offersNearDuplicate(
        "file US sales tax returns for the depot",
        "file sales tax returns for the depot",
      ),
    ).toBe(false);
    expect(offersNearDuplicate("file US sales tax returns", "file UK sales tax returns")).toBe(
      false,
    );
  });

  it("keeps an offer that joins a second action on", () => {
    const base = "reconcile carrier invoices against rate confirmations";
    expect(offersNearDuplicate(base, `${base} and recover charges`)).toBe(false);
    expect(offersNearDuplicate(`${base}, then recover charges`, base)).toBe(false);
    // The same action again on a new object is a second job too.
    expect(
      offersNearDuplicate(
        "reconcile carrier invoices against rate confirmations and reconcile fuel receipts",
        base,
      ),
    ).toBe(false);
  });

  it("reads with as a condition, not a stopword", () => {
    expect(offerContentWords("match payments with invoices").has("with")).toBe(true);
    expect(
      offersNearDuplicate(
        "match payments with open invoices",
        "match payments against open invoices",
      ),
    ).toBe(false);
  });

  it("keeps a threshold's direction: over is not under", () => {
    expect(
      offersNearDuplicate(
        "flag carrier invoices over $5,000",
        "flag carrier invoices under $5,000",
      ),
    ).toBe(false);
  });

  it("keeps a different object under shared context", () => {
    expect(
      offersNearDuplicate(
        "verify carrier insurance certificates before tendering loads for depot",
        "verify carrier operating authority before tendering loads for depot",
      ),
    ).toBe(false);
  });

  it("keeps an offer that adds a second job to a shared one", () => {
    expect(
      offersNearDuplicate(
        "reconcile carrier invoices against signed rate confirmations",
        "reconcile carrier invoices against rate confirmations and recover overbilled accessorial charges",
      ),
    ).toBe(false);
    expect(
      offersNearDuplicate(
        "reconcile carrier invoices against rate confirmations",
        "reconcile carrier invoices against rate confirmations and recover overbilled accessorial charges",
      ),
    ).toBe(false);
  });
});

describe("offerContentWords", () => {
  it("drops stopwords and possessives and trims plurals and inflections", () => {
    expect([...offerContentWords("Verifying the depot's backlogs, checked")]).toEqual([
      "verify",
      "depot",
      "backlog",
      "check",
    ]);
  });
});

describe("nearDuplicateOffer", () => {
  it("names the first offer the text repeats, else null", () => {
    const seen = ["reconcile import duty rates across freight manifests", vetting];
    expect(
      nearDuplicateOffer(
        "clear pending carrier vetting backlogs by verifying motor carrier operating authority and safety records",
        seen,
      ),
    ).toBe(vetting);
    expect(nearDuplicateOffer("cut detention charges at the dock", seen)).toBeNull();
  });
});
