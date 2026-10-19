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

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({
      ...actual.loadConfig(),
      offerJudge: { engine: "decisions", model: "test/decisions-model" },
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
vi.mock("../src/output.ts", () => ({
  c: { dim: (s: string) => s },
  header: () => {},
  note: () => {},
  ok: () => {},
  warn: () => {},
}));

const { Ledger: RealLedger } = await import("@oneshot-gtm/core");
const { offerHoldsSend } = await import("@oneshot-gtm/plays");
const { commandRejudgeOffers } = await import("../src/commands/rejudge-offers.ts");

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
