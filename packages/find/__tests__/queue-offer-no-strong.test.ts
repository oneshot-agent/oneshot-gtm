import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";

// A row the judge passes no offer for, after every rewrite round, keeps the
// skip and nothing else: a weak set it had before is deleted, the row is
// held `no-offer`, and it is not written again while its research stands.
// Real ledger, stubbed writer and judge.

let ledger: Ledger;
const calls = { writer: 0, judge: 0 };

const cfg = {
  founderName: "Founder",
  productOneLiner: "Acme schedules field crews",
  productBrief:
    "Acme plans crew routes, books jobs into open slots and texts customers the arrival time.",
  pilotOffer: "a free month on one depot",
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => cfg,
    logEvent: () => {},
    getCachedNewsfeed: () => null,
  };
});

const offer = {
  offer: "get the harbour depot's crews booked into same-day slots without a dispatcher",
  steps: "plans crew routes, books jobs into open slots and texts customers the arrival time",
  evidence: ["opened a harbour depot"],
  stage: "established local business",
  level: "researched",
  return: "same-day jobs the harbour depot would otherwise turn away, counted per booked job",
};

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => name,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const system = input.messages[0]?.content ?? "";
      const user = input.messages.at(-1)?.content ?? "";
      if (system === "prospect-offer-judge") {
        calls.judge++;
        const count = (user.match(/^\d+\.$/gm) ?? []).length;
        return {
          content: JSON.stringify({
            judgements: Array.from({ length: count }, (_, i) => ({
              offer: i + 1,
              label: "weak",
              why: "would fit any trade business",
            })),
          }),
          provider: "t",
          model: "t",
        };
      }
      calls.writer++;
      return { content: JSON.stringify({ offers: [offer] }), provider: "t", model: "t" };
    },
  };
});

const { ensureQueueRowOffer } = await import("../src/queue-offer.ts");
const { offerMissingHoldsSend, offerOf, offerSetForDraft, isOfferSkipped } =
  await import("@oneshot-gtm/plays");

const PLAY = "harbour-crews";
const legacyWeak = {
  ...offer,
  offer: "get every depot's vans washed before the morning run",
  relevance: "weak",
  version: "offer-v6",
  inputHash: "h",
  derivedAt: "",
};

beforeEach(() => {
  ledger = new Ledger(":memory:");
  calls.writer = 0;
  calls.judge = 0;
});
afterEach(() => ledger.close());

describe("a row no offer passes for", () => {
  it("keeps only the skip: the weak set is deleted and the row held no-offer", async () => {
    const id = ledger.enqueueTarget({
      playName: PLAY,
      payload: {
        name: "Rowan Pike",
        email: "rowan@harbourcrews.example",
        company: "Harbour Crews",
        title: "Operations Lead",
        signal: "opened a harbour depot",
        offer: legacyWeak,
        offerCandidates: [legacyWeak],
      },
      dedupeKey: "rowan",
      source: "find:test",
    })!;
    await ensureQueueRowOffer(ledger.getQueueRow(id)!);
    // The first write, the replacement round and both rescues.
    expect(calls.writer).toBe(4);

    const payload = JSON.parse(ledger.getQueueRow(id)!.payload_json) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("offer");
    expect(payload).not.toHaveProperty("offerCandidates");
    expect(payload["offerSkip"]).toMatchObject({
      why: "no offer passed the relevance check after 3 rewrites",
      version: "offer-v7",
    });
    // Held: the draft reads the skip, not an offer, and is not written again.
    expect(offerMissingHoldsSend(PLAY, offerOf(payload), cfg)).toBe(true);
    const draft = await offerSetForDraft({ target: payload, playName: PLAY, cfg: cfg as never });
    expect(isOfferSkipped(draft)).toBe(true);
    const before = ledger.getQueueRow(id)!.payload_json;
    await ensureQueueRowOffer(ledger.getQueueRow(id)!);
    expect(calls.writer).toBe(4);
    expect(ledger.getQueueRow(id)!.payload_json).toBe(before);
  });
});
