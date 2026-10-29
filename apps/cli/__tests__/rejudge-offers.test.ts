import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ledger } from "@oneshot-gtm/core";
import type { OfferJudgement, ProspectOffer } from "@oneshot-gtm/plays";

// `find rejudge-offers`: a real ledger on a temp file; the judge is mocked
// (verdicts keyed on the offer text), and the offer writer must never run.

let ledger: Ledger;
const verdictFor = new Map<string, Partial<OfferJudgement>>();
const judgeMock = vi.fn();
const writerMock = vi.fn();
let onJudge: (() => void) | null = null;
let extraCfg: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({
      ...actual.loadConfig(),
      offerJudge: { engine: "decisions", model: "test/decisions-model" },
      ...extraCfg,
    }),
  };
});
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    judgeOffers: judgeMock,
    deriveOffers: writerMock,
    deriveOfferSet: writerMock,
    ensureOfferSet: writerMock,
  };
});
vi.mock("../src/output.ts", async (importOriginal) => {
  // The command's `--limit` cap is the real one; only the printers are stubbed.
  const { resolveCap } = await importOriginal<typeof import("../src/output.ts")>();
  return {
    c: { dim: (s: string) => s },
    header: () => {},
    note: () => {},
    ok: () => {},
    resolveCap,
    warn: () => {},
  };
});

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const { offerHoldsSend } = await import("@oneshot-gtm/plays");
const {
  commandListExcludedOffers,
  commandRejudgeOffers,
  commandRewriteWeakOffers,
  selectAllWeakRows,
  selectAllWeakSequences,
} = await import("../src/commands/rejudge-offers.ts");

function verdict(label: OfferJudgement["label"], score: number, pass: boolean): OfferJudgement {
  return {
    label,
    score,
    why: `${label} ${score.toFixed(2)}`,
    classifier: "decisions:test/decisions-model",
    pass,
  };
}

let dbPath: string;
beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-rejudge-offers-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new RealLedger(dbPath);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  verdictFor.clear();
  onJudge = null;
  extraCfg = {};
  writerMock.mockReset();
  judgeMock.mockReset();
  judgeMock.mockImplementation(async (offers: Array<{ offer: string }>) => {
    onJudge?.();
    return offers.map((o) => (verdictFor.get(o.offer) as OfferJudgement | undefined) ?? null);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

function offer(text: string, extra: Partial<ProspectOffer> = {}): ProspectOffer {
  return {
    offer: text,
    steps: "books jobs into open slots",
    evidence: [],
    stage: "established local business",
    level: "role",
    version: "offer-v4",
    inputHash: `h-${text}`,
    derivedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

const A = "get the second depot's crews booked into same-day slots";
const B = "clear the backlog of unbooked repair calls before the weekend";
const C = "give every caller a confirmed arrival window";

const weakFields = {
  relevance: "weak",
  relevanceScore: 0.45,
  relevanceWhy: "relevant 0.45, weak 0.40",
  relevanceClassifier: "decisions:test/decisions-model",
} as const;

function enqueue(payload: Record<string, unknown>, status?: "approved" | "sent"): number {
  const id = ledger.enqueueTarget({
    playName: "new-business",
    payload: { name: "Dana Lee", company: "Northside Plumbing", title: "Ops", ...payload },
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "find:new-business",
  })!;
  if (status) ledger.setQueueStatus({ id, status: "approved" });
  if (status === "sent") ledger.setQueueStatus({ id, status: "sent" });
  return id;
}
const payloadOf = (id: number) =>
  JSON.parse(ledger.getQueueRow(id)!.payload_json) as {
    offer: ProspectOffer;
    offerCandidates: ProspectOffer[];
  };

const draft = (body: string) => ({
  subject: "s",
  body,
  flags: [],
  sent: false,
  receiptIds: [],
  dryRun: false,
});

describe("commandRejudgeOffers", () => {
  it("lifts a hold when the active offer now passes, and re-labels every candidate", async () => {
    const active = offer(A, { ...weakFields, angles: ["pays back per job"] });
    const id = enqueue({
      offer: active,
      offerCandidates: [offer(A, weakFields), offer(B, { relevance: "weak" })],
    });
    expect(offerHoldsSend(payloadOf(id).offer)).toBe(true);
    verdictFor.set(A, verdict("relevant", 0.66, true));
    verdictFor.set(B, verdict("weak", 0.3, false));

    const s = await commandRejudgeOffers({ dryRun: false });

    expect(s).toMatchObject({ judged: 1, lifted: [id], switched: [], weak: [], errors: 0 });
    const p = payloadOf(id);
    expect(p.offer).toMatchObject({
      offer: A,
      relevance: "relevant",
      relevanceScore: 0.66,
      relevanceWhy: "relevant 0.66",
      relevanceClassifier: "decisions:test/decisions-model",
      angles: ["pays back per job"],
    });
    expect(offerHoldsSend(p.offer)).toBe(false);
    expect(p.offerCandidates.map((o) => [o.offer, o.relevance, o.relevanceScore])).toEqual([
      [A, "relevant", 0.66],
      [B, "weak", 0.3],
    ]);
    // The judge saw the stored candidates and the row's research text.
    const [offers, research] = judgeMock.mock.calls[0] as [ProspectOffer[], string];
    expect(offers.map((o) => o.offer)).toEqual([A, B]);
    expect(research).toContain("Northside Plumbing");
    expect(writerMock).not.toHaveBeenCalled();
  });

  it("switches to the first passing candidate when the active one still fails, and reports it", async () => {
    const id = enqueue(
      {
        offer: offer(A, { ...weakFields, angles: ["old angle"], weakApprovedAt: "" }),
        offerCandidates: [
          offer(A, weakFields),
          offer(B, { relevance: "weak" }),
          offer(C, { relevance: "weak", angles: ["c pays back"] }),
        ],
      },
      "approved",
    );
    verdictFor.set(A, verdict("weak", 0.3, false));
    verdictFor.set(B, verdict("relevant", 0.62, true));
    verdictFor.set(C, verdict("relevant", 0.8, true));

    const s = await commandRejudgeOffers({ dryRun: false });

    expect(s).toMatchObject({ judged: 1, switched: [id], lifted: [], weak: [] });
    const p = payloadOf(id);
    // The first passing one in stored order, not the best scored.
    expect(p.offer.offer).toBe(B);
    expect(p.offer.relevance).toBe("relevant");
    // No angles on it: left unset, none carried over from the old offer.
    expect(p.offer.angles).toBeUndefined();
    expect("weakApprovedAt" in p.offer).toBe(false);
    expect(p.offerCandidates.map((o) => o.offer)).toEqual([A, B, C]);
    expect(p.offerCandidates[2]?.angles).toEqual(["c pays back"]);
    expect(writerMock).not.toHaveBeenCalled();
  });

  it("under prefer-product, a passing product-anchored candidate is taken over an earlier one", async () => {
    extraCfg = { offerAnchor: "prefer-product" };
    const id = enqueue({
      offer: offer(A, weakFields),
      offerCandidates: [
        offer(A, weakFields),
        offer(B, { relevance: "weak", anchor: "firm" }),
        offer(C, { relevance: "weak", anchor: "product" }),
      ],
    });
    verdictFor.set(A, verdict("weak", 0.3, false));
    verdictFor.set(B, verdict("relevant", 0.9, true));
    verdictFor.set(C, verdict("relevant", 0.6, true));
    await commandRejudgeOffers({ dryRun: false });
    // C, although B passes first and scores higher.
    expect(payloadOf(id).offer.offer).toBe(C);
  });

  it("candidates written before the anchor existed still take the first passing one", async () => {
    extraCfg = { offerAnchor: "prefer-product" };
    const id = enqueue({
      offer: offer(A, weakFields),
      offerCandidates: [offer(A, weakFields), offer(B), offer(C)],
    });
    verdictFor.set(A, verdict("weak", 0.3, false));
    verdictFor.set(B, verdict("relevant", 0.62, true));
    verdictFor.set(C, verdict("relevant", 0.8, true));
    await commandRejudgeOffers({ dryRun: false });
    expect(payloadOf(id).offer.offer).toBe(B);
  });

  it("keeps a switched candidate's own angles", async () => {
    const id = enqueue({
      offer: offer(A, weakFields),
      offerCandidates: [offer(A, weakFields), offer(C, { angles: ["c pays back"] })],
    });
    verdictFor.set(A, verdict("weak", 0.3, false));
    verdictFor.set(C, verdict("relevant", 0.8, true));
    await commandRejudgeOffers({ dryRun: false });
    expect(payloadOf(id).offer).toMatchObject({ offer: C, angles: ["c pays back"] });
  });

  it("stays held when nothing passes; a relevant under the bar is stored weak", async () => {
    const id = enqueue({
      offer: offer(A, { relevance: "relevant", relevanceScore: 0.9 }),
      offerCandidates: [offer(A, { relevance: "relevant" }), offer(B)],
    });
    verdictFor.set(A, verdict("relevant", 0.45, false));
    verdictFor.set(B, verdict("weak", 0.2, false));
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ weak: [id], newlyHeld: [id], switched: [] });
    const p = payloadOf(id);
    expect(p.offer).toMatchObject({ offer: A, relevance: "weak", relevanceScore: 0.45 });
    expect(offerHoldsSend(p.offer)).toBe(true);
  });

  it("skips founder-edited and sent rows", async () => {
    const edited = enqueue({
      offer: offer(A, { ...weakFields, editedBy: "founder" }),
      offerCandidates: [offer(A, weakFields)],
    });
    const sent = enqueue(
      { offer: offer(A, weakFields), offerCandidates: [offer(A, weakFields)] },
      "sent",
    );
    verdictFor.set(A, verdict("relevant", 0.9, true));
    const before = [edited, sent].map((id) => ledger.getQueueRow(id)!.payload_json);
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ judged: 0, skipped: 1, lifted: [] });
    expect(judgeMock).not.toHaveBeenCalled();
    expect([edited, sent].map((id) => ledger.getQueueRow(id)!.payload_json)).toEqual(before);
  });

  it("--dry-run judges and reports but writes nothing", async () => {
    const lift = enqueue({
      offer: offer(A, weakFields),
      offerCandidates: [offer(A, weakFields), offer(B)],
    });
    const swap = enqueue({
      offer: offer(C, weakFields),
      offerCandidates: [offer(C, weakFields), offer(B)],
    });
    verdictFor.set(A, verdict("relevant", 0.7, true));
    verdictFor.set(B, verdict("relevant", 0.7, true));
    verdictFor.set(C, verdict("weak", 0.2, false));
    const before = [lift, swap].map((id) => ledger.getQueueRow(id)!.payload_json);
    const s = await commandRejudgeOffers({ dryRun: true });
    expect(s).toMatchObject({ judged: 2, lifted: [lift], switched: [swap] });
    expect([lift, swap].map((id) => ledger.getQueueRow(id)!.payload_json)).toEqual(before);
  });

  it("skips a row whose active offer changed while it was judged", async () => {
    const id = enqueue({
      offer: offer(A, weakFields),
      offerCandidates: [offer(A, weakFields), offer(B)],
    });
    verdictFor.set(A, verdict("relevant", 0.7, true));
    verdictFor.set(B, verdict("relevant", 0.7, true));
    // The founder picks another offer mid-run.
    onJudge = () => {
      ledger.patchLiveQueuePayload({ id, patch: { offer: offer(C, { inputHash: "picked" }) } });
    };
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ judged: 0, skipped: 1, lifted: [] });
    const p = payloadOf(id);
    expect(p.offer.offer).toBe(C);
    expect(p.offerCandidates.map((o) => o.relevance)).toEqual(["weak", undefined]);
  });

  it("drops the stored draft when the active offer switches, and keeps it when it stays", async () => {
    const switched = enqueue(
      { offer: offer(A, weakFields), offerCandidates: [offer(A, weakFields), offer(B)] },
      "approved",
    );
    const kept = enqueue(
      { offer: offer(C, weakFields), offerCandidates: [offer(C, weakFields)] },
      "approved",
    );
    ledger.setQueueDraft({ id: switched, draft: draft("written for A") });
    ledger.setQueueDraft({ id: kept, draft: draft("written for C") });
    verdictFor.set(A, verdict("weak", 0.3, false));
    verdictFor.set(B, verdict("relevant", 0.7, true));
    verdictFor.set(C, verdict("relevant", 0.7, true));

    const s = await commandRejudgeOffers({ dryRun: false });

    expect(s).toMatchObject({ switched: [switched], lifted: [kept] });
    expect(payloadOf(switched).offer.offer).toBe(B);
    expect(ledger.getQueueRow(switched)!.last_draft_json).toBeNull();
    expect(ledger.getQueueRow(kept)!.last_draft_json).toContain("written for C");
  });

  it("skips a row whose payload changed anywhere while it was judged", async () => {
    const id = enqueue({
      offer: offer(A, weakFields),
      offerCandidates: [offer(A, weakFields), offer(B)],
    });
    verdictFor.set(A, verdict("relevant", 0.7, true));
    // New angles land on a candidate mid-run; the active offer is untouched.
    onJudge = () => {
      ledger.patchLiveQueuePayload({
        id,
        patch: { offerCandidates: [offer(A, weakFields), offer(B, { angles: ["fresh"] })] },
      });
    };
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ judged: 0, skipped: 1, lifted: [] });
    const p = payloadOf(id);
    expect(p.offer.relevance).toBe("weak");
    expect(p.offerCandidates[1]?.angles).toEqual(["fresh"]);
  });

  it("skips a row a live drain has claimed", async () => {
    const id = enqueue(
      { offer: offer(A, weakFields), offerCandidates: [offer(A, weakFields), offer(B)] },
      "approved",
    );
    verdictFor.set(A, verdict("relevant", 0.7, true));
    onJudge = () => {
      ledger.dequeueApproved({ playName: "new-business" });
    };
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ judged: 0, skipped: 1, lifted: [] });
    expect(payloadOf(id).offer.relevance).toBe("weak");
  });

  it("--limit caps the rows judged", async () => {
    for (let i = 0; i < 3; i++) {
      enqueue({ offer: offer(A, weakFields), offerCandidates: [offer(A, weakFields)] });
    }
    verdictFor.set(A, verdict("relevant", 0.7, true));
    const s = await commandRejudgeOffers({ dryRun: true, limit: 2 });
    expect(s.judged).toBe(2);
    expect(judgeMock).toHaveBeenCalledTimes(2);
  });
});

// `--rewrite-all-weak`: new offers for the sets the judge passed none of.

/** An active cadence row carrying this offer record. */
function cadence(offerJson: Record<string, unknown>, prospectId: number) {
  return {
    prospect_id: prospectId,
    play_name: "new-business",
    offer_json: JSON.stringify(offerJson),
    queue_id: null,
    status: "active",
  };
}

describe("commandRewriteWeakOffers", () => {
  const weak = (text: string, extra: Partial<ProspectOffer> = {}) =>
    offer(text, { ...weakFields, ...extra });

  it("rewrites only live sets whose every offer is weak, never the founder's or an approved one", async () => {
    const held = enqueue(
      {
        offer: weak(A),
        offerCandidates: [weak(A), weak(B)],
        productResearch: { status: "partial" },
      },
      "approved",
    );
    const mixed = enqueue({ offer: weak(A), offerCandidates: [weak(A), offer(B)] });
    const edited = enqueue({
      offer: weak(A, { editedBy: "founder" }),
      offerCandidates: [weak(A), weak(B)],
    });
    const approved = enqueue({
      offer: weak(A, { weakApprovedAt: "2026-10-20T00:00:00.000Z" }),
      offerCandidates: [weak(A), weak(B)],
    });
    const sent = enqueue({ offer: weak(A), offerCandidates: [weak(A), weak(B)] }, "sent");
    ledger.setQueueDraft({ id: held, draft: draft("written for A") });
    const fresh = offer(C, { relevance: "relevant", relevanceScore: 0.7 });
    writerMock.mockResolvedValue({ offer: fresh, candidates: [fresh, weak(B)] });
    const untouched = [mixed, edited, approved, sent].map(
      (id) => ledger.getQueueRow(id)!.payload_json,
    );

    const s = await commandRewriteWeakOffers({ dryRun: false });

    expect(s).toMatchObject({
      eligible: 1,
      unresearched: 1,
      passing: [`#${held}`],
      weak: [],
      errors: 0,
    });
    expect(writerMock).toHaveBeenCalledTimes(1);
    // Written around the old offers, with the row for the research it reads.
    expect(writerMock.mock.calls[0]![0]).toMatchObject({
      playName: "new-business",
      avoid: [A, B],
      research: { queueRowId: held, source: "find:new-business" },
    });
    const p = payloadOf(held);
    expect(p.offer).toMatchObject({ offer: C, relevance: "relevant" });
    expect(offerHoldsSend(p.offer)).toBe(false);
    expect(p.offerCandidates.map((o) => o.offer)).toEqual([C, B]);
    // The letter written around the old offer is dropped.
    expect(ledger.getQueueRow(held)!.last_draft_json).toBeNull();
    expect(
      [mixed, edited, approved, sent].map((id) => ledger.getQueueRow(id)!.payload_json),
    ).toEqual(untouched);
  });

  it("--dry-run lists what it would rewrite, calls no model and writes nothing", async () => {
    const id = enqueue({ offer: weak(A), offerCandidates: [weak(A)] });
    const before = ledger.getQueueRow(id)!.payload_json;
    const s = await commandRewriteWeakOffers({ dryRun: true });
    expect(s).toMatchObject({ eligible: 1, passing: [], weak: [], unchanged: [], costUsd: 0 });
    expect(writerMock).not.toHaveBeenCalled();
    expect(ledger.getQueueRow(id)!.payload_json).toBe(before);
  });

  it("leaves a row the writer gave nothing for, and one whose offer changed meanwhile", async () => {
    const nothing = enqueue({ offer: weak(A), offerCandidates: [weak(A)] });
    const moved = enqueue({ offer: weak(B), offerCandidates: [weak(B)] });
    const fresh = offer(C, { relevance: "relevant" });
    writerMock.mockImplementation(async (input: { target: { offer?: { offer?: string } } }) => {
      if (input.target.offer?.offer === A) return null;
      // The founder picked another offer while this one was written.
      ledger.patchLiveQueuePayload({ id: moved, patch: { offer: { offer: "picked" } } });
      return { offer: fresh, candidates: [fresh] };
    });
    const s = await commandRewriteWeakOffers({ dryRun: false, concurrency: 1 });
    expect(s.unchanged.toSorted()).toEqual([`#${moved}`, `#${nothing}`].toSorted());
    expect(payloadOf(moved).offer.offer).toBe("picked");
  });

  it("replaces a weak set no new offer passes for with the skip: held no-offer, its letter dropped", async () => {
    const id = enqueue({ offer: weak(A), offerCandidates: [weak(A), weak(B)] });
    ledger.setQueueDraft({ id, draft: draft("written for A") });
    const skip = {
      why: "no offer passed the relevance check after 3 rewrites",
      version: "offer-v8",
      inputHash: "h",
      productHash: "p",
      skippedAt: "2026-10-29T00:00:00.000Z",
    };
    writerMock.mockResolvedValue({ skipped: skip });
    const s = await commandRewriteWeakOffers({ dryRun: false });
    expect(s).toMatchObject({ noOffer: [`#${id}`], passing: [], weak: [], unchanged: [] });
    const p = JSON.parse(ledger.getQueueRow(id)!.payload_json) as Record<string, unknown>;
    expect(p).not.toHaveProperty("offer");
    expect(p).not.toHaveProperty("offerCandidates");
    expect(p["offerSkip"]).toEqual(skip);
    expect(ledger.getQueueRow(id)!.last_draft_json).toBeNull();
  });

  it("selects active sequences whose every offer is weak, never one the first email carried", () => {
    const items = selectAllWeakSequences(
      [
        cadence({ offer: weak(A), candidates: [weak(A), weak(B)], origin: "derived" }, 1),
        cadence({ offer: weak(A), candidates: [weak(A)], origin: "intro" }, 2),
        cadence({ offer: weak(A), candidates: [weak(A), offer(B)], origin: "derived" }, 3),
        cadence({ offer: weak(A, { editedBy: "founder" }), candidates: [weak(A)] }, 4),
      ],
      () => null,
    );
    expect(items.map((i) => i.key)).toEqual(["sequence 1/new-business"]);
  });
});

// `offerExclusions`: the judge rates an offer of an excluded kind
// irrelevant (`excluded: true`). The sweep replaces it on unsent rows, an
// approval never keeps it, and sequences are only listed.

describe("offer exclusions", () => {
  const excluded = (): OfferJudgement => ({
    ...verdict("irrelevant", 0.9, false),
    why: "excluded 0.92",
    excluded: true,
  });
  const approvedAt = "2026-10-20T00:00:00.000Z";

  it("switches an approved offer judged excluded to the first passing candidate", async () => {
    const id = enqueue({
      offer: offer(A, { ...weakFields, weakApprovedAt: approvedAt }),
      offerCandidates: [offer(A, weakFields), offer(B, weakFields)],
    });
    verdictFor.set(A, excluded());
    verdictFor.set(B, verdict("relevant", 0.7, true));
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ switched: [id], excluded: [id], weak: [] });
    const p = payloadOf(id);
    expect(p.offer.offer).toBe(B);
    expect("weakApprovedAt" in p.offer).toBe(false);
    // The excluded candidate is stored weak, so it can never go out unreviewed.
    expect(p.offerCandidates[0]).toMatchObject({
      offer: A,
      relevance: "weak",
      relevanceWhy: "irrelevant: excluded 0.92",
    });
  });

  it("drops the approval when nothing else passes: held, and then rewritten by --rewrite-all-weak", async () => {
    const id = enqueue({
      offer: offer(A, { ...weakFields, weakApprovedAt: approvedAt }),
      offerCandidates: [offer(A, weakFields), offer(B, weakFields)],
    });
    expect(offerHoldsSend(payloadOf(id).offer)).toBe(false);
    verdictFor.set(A, excluded());
    verdictFor.set(B, verdict("weak", 0.3, false));
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ weak: [id], newlyHeld: [id], excluded: [id], switched: [] });
    const held = payloadOf(id).offer;
    expect(held).toMatchObject({ offer: A, relevance: "weak" });
    expect("weakApprovedAt" in held).toBe(false);
    expect(offerHoldsSend(held)).toBe(true);

    const fresh = offer(C, { relevance: "relevant", relevanceScore: 0.7 });
    writerMock.mockResolvedValue({ offer: fresh, candidates: [fresh] });
    const r = await commandRewriteWeakOffers({ dryRun: false });
    expect(r).toMatchObject({ eligible: 1, passing: [`#${id}`] });
    expect(payloadOf(id).offer.offer).toBe(C);
  });

  it("keeps an approved offer the judge rates weak but not excluded", async () => {
    const id = enqueue({
      offer: offer(A, { ...weakFields, weakApprovedAt: approvedAt }),
      offerCandidates: [offer(A, weakFields), offer(B, weakFields)],
    });
    verdictFor.set(A, verdict("weak", 0.3, false));
    verdictFor.set(B, verdict("relevant", 0.7, true));
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ weak: [id], excluded: [], switched: [] });
    expect(payloadOf(id).offer).toMatchObject({ offer: A, weakApprovedAt: approvedAt });
  });

  it("a founder-edited offer is never judged, whatever the exclusions", async () => {
    const id = enqueue({
      offer: offer(A, { editedBy: "founder" }),
      offerCandidates: [offer(A), offer(B)],
    });
    verdictFor.set(A, excluded());
    const before = ledger.getQueueRow(id)!.payload_json;
    const s = await commandRejudgeOffers({ dryRun: false });
    expect(s).toMatchObject({ judged: 0, skipped: 1, excluded: [] });
    expect(ledger.getQueueRow(id)!.payload_json).toBe(before);
  });

  it("--rewrite-all-weak counts a set of weak and irrelevant offers", () => {
    const id = enqueue({
      offer: offer(A, { relevance: "irrelevant" }),
      offerCandidates: [offer(A, { relevance: "irrelevant" }), offer(B, weakFields)],
    });
    const rows = (["pending", "approved"] as const).flatMap((status) =>
      ledger.listQueue({ status, limit: 100 }),
    );
    expect(selectAllWeakRows(rows).map((i) => i.key)).toEqual([`#${id}`]);
  });

  it("--list-excluded lists active sequences whose offer is excluded and writes nothing", async () => {
    extraCfg = { offerExclusions: ["recruiting: hiring people for their open roles"] };
    const cadences = [
      cadence({ offer: offer(A), candidates: [offer(A)], origin: "intro" }, 1),
      cadence({ offer: offer(B), candidates: [offer(B)], origin: "derived" }, 2),
      cadence({ skip: null }, 3),
    ];
    vi.spyOn(ledger, "listActiveCadences").mockReturnValue(cadences as never);
    vi.spyOn(ledger, "cadenceQueueRow").mockImplementation((prospectId: number) =>
      prospectId === 1
        ? { id: 9, payload: { name: "Dana Lee", company: "Northside Plumbing" }, source: "s" }
        : null,
    );
    const getProspect = vi.spyOn(ledger, "getProspectById").mockReturnValue(null);
    verdictFor.set(A, excluded());
    verdictFor.set(B, verdict("relevant", 0.7, true));
    const s = await commandListExcludedOffers({});
    expect(s).toEqual({
      eligible: 2,
      judged: 2,
      excluded: ["sequence 1/new-business"],
      errors: 0,
    });
    // Judged from the row the sequence started from, else the prospect.
    const research = judgeMock.mock.calls.map((call) => call[1] as string);
    expect(research.some((r) => r.includes("Northside Plumbing"))).toBe(true);
    expect(getProspect).toHaveBeenCalledWith(2);
    expect(writerMock).not.toHaveBeenCalled();
  });

  it("--list-excluded makes no judge call without offerExclusions", async () => {
    vi.spyOn(ledger, "listActiveCadences").mockReturnValue([
      cadence({ offer: offer(A), candidates: [offer(A)] }, 1),
    ] as never);
    const s = await commandListExcludedOffers({});
    expect(s).toEqual({ eligible: 0, judged: 0, excluded: [], errors: 0 });
    expect(judgeMock).not.toHaveBeenCalled();
  });
});
