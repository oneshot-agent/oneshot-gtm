import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isHumanDecision } from "@oneshot-gtm/core";
import { Ledger } from "../../core/src/ledger.ts";

// Every sent intro of an offer-making play keeps a sent queue row with its
// offer, linked to the prospect, and starts a sequence that owns that offer
// (`cadence_state.offer_json`) and links the row (`queue_id`). An intro sent
// from no queue row (a typed list, the CLI) gets one recorded at send; one
// drawn from a queue row links that row. With a product brief and no offer
// written, the intro is held `no-offer`; without a brief nothing is held.
// Real ledger, stubbed models and send.

let ledger: Ledger;
const llm = { offers: "" as string, drafts: [] as string[] };
const BRIEF = "Thing drafts quotes, checks price lists and sends them for approval.";
const cfg: Record<string, unknown> = {};
const OFFER = {
  offer: "get every enterprise corp renewal quote out the same day it is asked for",
  steps: "drafts the quote, checks the price list and sends it for approval",
  evidence: ["renewal quotes"],
  stage: "enterprise",
  level: "researched",
  return: "renewals closed before the customer shops around, counted per renewal",
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => cfg,
    logEvent: () => {},
    getCachedNewsfeed: () => null,
    recentTouchElsewhere: () => null,
    enrichProfile: async () => ({ result: { profile: { note: "renewal quotes" } }, receiptId: 0 }),
    sendEmail: async (input: { subject: string }) => {
      const receiptId = ledger.recordReceipt({
        playName: "x",
        callType: "email.send",
        signedReceipt: { provider: "test" },
      });
      return { receiptId, result: { status: "sent", cost: 0 }, subject: input.subject };
    },
  };
});

const reply = (content: string) => ({ content, provider: "t", model: "t" });

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => name,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const name = (input.messages[0]?.content ?? "").split(/\s/)[0]!;
      if (name === "prospect-offer") return reply(llm.offers);
      if (name === "prospect-offer-judge") {
        return reply(JSON.stringify({ judgements: [{ offer: 1, label: "relevant", why: "t" }] }));
      }
      if (name === "offer-angles") return reply(JSON.stringify({ angles: [] }));
      const user = input.messages.find((m) => m.role === "user")?.content ?? "";
      llm.drafts.push(user);
      const offer = /^OFFER \(what you offer[^:]*\): (.+)$/m.exec(user)?.[1];
      return reply(
        JSON.stringify({
          subject: "renewal quotes",
          body: offer
            ? `I can ${offer}, start to finish. Worth trying on one team?\n\nFounder`
            : "Would same-day quotes help your team?\n\nFounder",
        }),
      );
    },
  };
});

const { runDesignPartnerLoi } = await import("../src/design-partner-loi.ts");
const { sequenceOfferRecord } = await import("../src/_sequence-offer.ts");
const { introQueueDedupeKey } = await import("../src/_run-play.ts");

const PLAY = "design-partner-loi";
let n = 0;
function target() {
  return {
    name: "Jamie Buyer",
    email: `jamie${++n}@enterprise-corp.example`,
    company: "Enterprise Corp",
    buyerType: "enterprise",
    yourEdge: "quotes the same day",
  };
}

function introRow(email: string) {
  return ledger.getQueueRowByDedupe(PLAY, introQueueDedupeKey(email));
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  llm.offers = JSON.stringify({ offers: [OFFER] });
  llm.drafts = [];
  for (const k of Object.keys(cfg)) delete cfg[k];
  Object.assign(cfg, {
    founderName: "Founder",
    productOneLiner: "thing",
    productBrief: BRIEF,
    pilotOffer: "a month on one team",
    cadenceOverrides: null,
  });
});
afterEach(() => ledger.close());

describe("an intro sent from no queue row", () => {
  it("keeps a sent row with the address and the offer, linked to the prospect", async () => {
    const t = target();
    const out = await runDesignPartnerLoi({ dryRun: false, targets: [t] });
    expect(out.drafted[0]).toMatchObject({ sent: true, flags: [] });

    const row = introRow(t.email)!;
    const prospect = ledger.findProspectByEmail(t.email)!;
    expect(row).toMatchObject({ status: "sent", source: "manual", prospect_id: prospect.id });
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({ email: t.email, company: "Enterprise Corp" });
    expect(payload["offer"]).toMatchObject({ offer: OFFER.offer, steps: OFFER.steps });
    expect(payload["offerCandidates"]).toHaveLength(1);
    expect(JSON.parse(row.last_draft_json!)).toMatchObject({ sent: true, flags: [] });

    // The sequence starts with the whole offer and links the row.
    const record = sequenceOfferRecord({ prospectId: prospect.id, playName: PLAY });
    expect(record).toMatchObject({ queueRowId: row.id, introCarriedOffer: true });
    expect(record.offer).toMatchObject({ offer: OFFER.offer, level: "researched" });
    expect(record.offerCandidates).toHaveLength(1);
    // The step-0 record keeps the angle, never a second copy of the offer.
    const step0 = ledger.listSequenceEventsForProspectPlay(prospect.id, PLAY)[0]!;
    expect(JSON.parse(step0.metadata_json!)).not.toHaveProperty("offer");
    expect(JSON.parse(step0.metadata_json!)).not.toHaveProperty("offerSteps");
  });

  it("records a machine disposition, never a human review", async () => {
    const t = target();
    await runDesignPartnerLoi({ dryRun: false, targets: [t] });
    const row = introRow(t.email)!;
    expect(row).toMatchObject({ decision: "approve", decided_by: "machine" });
    expect(isHumanDecision(row)).toBe(false);
    expect(ledger.countHumanIcpDecisions()).toBe(0);
  });

  it("takes over an unsent row under the same key, keeping its payload", async () => {
    const t = target();
    const id = ledger.enqueueTarget({
      playName: PLAY,
      payload: { ...t, title: "Head of Sales", offer: { offer: "an older offer", steps: "x" } },
      dedupeKey: introQueueDedupeKey(t.email),
      source: "find:csv-import",
    })!;
    await runDesignPartnerLoi({ dryRun: false, targets: [t] });

    const row = ledger.getQueueRow(id)!;
    expect(row).toMatchObject({ status: "sent", source: "find:csv-import" });
    expect(row.prospect_id).toBe(ledger.findProspectByEmail(t.email)!.id);
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload["title"]).toBe("Head of Sales");
    expect(payload["offer"]).toMatchObject({ offer: OFFER.offer });
  });

  it("records no row for a target drawn from a queue row, or on a dry run", async () => {
    const queued = target();
    await runDesignPartnerLoi({
      dryRun: false,
      targets: [queued],
      queueSource: "find:test",
    } as never);
    expect(introRow(queued.email)).toBeNull();

    const dry = target();
    await runDesignPartnerLoi({ dryRun: true, targets: [dry] });
    expect(introRow(dry.email)).toBeNull();
  });
});

describe("an intro with no offer", () => {
  it("is held no-offer when the workspace has a brief", async () => {
    llm.offers = JSON.stringify({ skip: true, why: "nothing known" });
    const t = target();
    const out = await runDesignPartnerLoi({ dryRun: false, targets: [t] });
    expect(out.drafted[0]!.sent).toBe(false);
    expect(out.drafted[0]!.flags).toContain("no-offer");
    expect(ledger.findProspectByEmail(t.email)).toBeNull();
    expect(introRow(t.email)).toBeNull();
  });

  it("is flagged on a dry run too, so the founder regenerates before sending", async () => {
    llm.offers = JSON.stringify({ skip: true, why: "nothing known" });
    const out = await runDesignPartnerLoi({ dryRun: true, targets: [target()] });
    expect(out.drafted[0]!.flags).toContain("no-offer");
  });

  it("sends as before when the workspace has no brief", async () => {
    delete cfg["productBrief"];
    const t = target();
    const out = await runDesignPartnerLoi({ dryRun: false, targets: [t] });
    expect(out.drafted[0]).toMatchObject({ sent: true, flags: [] });
    expect(llm.drafts[0]).not.toContain("OFFER (what you offer");
    // The row is still kept, and linked: research for an offer written later.
    const row = introRow(t.email)!;
    expect(row.status).toBe("sent");
    expect(JSON.parse(row.payload_json)["offer"]).toBeUndefined();
    const prospect = ledger.findProspectByEmail(t.email)!;
    expect(ledger.getCadence(prospect.id, PLAY)).toMatchObject({
      queue_id: row.id,
      offer_json: null,
    });
  });
});

describe("an intro drawn from a queue row (the drain, a /run batch from the queue)", () => {
  function queuedRow(t: ReturnType<typeof target>, payload: Record<string, unknown> = {}): number {
    return ledger.enqueueTarget({
      playName: PLAY,
      payload: { ...t, ...payload },
      dedupeKey: `q-${t.email}`,
      source: "find:test",
    })!;
  }

  it("starts a sequence that links the row and carries the intro's offer", async () => {
    const t = target();
    const id = queuedRow(t);
    await runDesignPartnerLoi({
      dryRun: false,
      targets: [t],
      queueSource: "find:test",
      queueId: id,
    } as never);
    const prospect = ledger.findProspectByEmail(t.email)!;
    const record = sequenceOfferRecord({ prospectId: prospect.id, playName: PLAY });
    expect(record).toMatchObject({ queueRowId: id, introCarriedOffer: true });
    expect(record.offer).toMatchObject({ offer: OFFER.offer });
  });

  it("links each target of a batch to its own row", async () => {
    const [a, b] = [target(), target()];
    const ids = [queuedRow(a), queuedRow(b)];
    await runDesignPartnerLoi({
      dryRun: false,
      targets: [a, b],
      queueSources: ["find:test", "find:test"],
      queueIds: ids,
    } as never);
    for (const [i, t] of [a, b].entries()) {
      const prospect = ledger.findProspectByEmail(t.email)!;
      expect(ledger.getCadence(prospect.id, PLAY)?.queue_id).toBe(ids[i]);
    }
  });

  it("records the intro's angle as the offer's own when its pool was the offer's angles", async () => {
    const angles = ["renewals slip while quotes wait", "the price list is out of date"];
    const t = { ...target(), yourEdge: angles.join(" // ") };
    const offer = { ...OFFER, angles, version: "", productHash: "", editedBy: "founder" };
    const id = queuedRow(t, { offer });
    const out = await runDesignPartnerLoi({
      dryRun: false,
      targets: [{ ...t, offer }],
      queueSource: "find:test",
      queueId: id,
    } as never);
    expect((out.drafted[0] as { angle?: { origin?: string } }).angle?.origin).toBe("offer");
    const plain = target();
    const configured = await runDesignPartnerLoi({
      dryRun: false,
      targets: [{ ...plain, yourEdge: "quotes the same day // price lists stay current" }],
    });
    expect((configured.drafted[0] as { angle?: { origin?: string } }).angle?.origin).toBe(
      "configured",
    );
  });
});
