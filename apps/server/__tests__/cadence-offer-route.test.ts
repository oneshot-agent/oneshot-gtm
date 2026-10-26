import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// POST /api/cadences/:id/offer: the founder changes the offer a cadence's
// follow-ups restate, on the cadence itself (never a queue row), with the
// queue route's body. An offer the first email carried is fixed; nothing
// changes mid-send; every change drops the stored preview so it is
// redrafted. Real ledger, stubbed offer writer.

let ledger: Ledger;
const cfg = { productBrief: "Acme books crews into open slots.", cadenceOverrides: null };
const derived = vi.hoisted(() => ({
  offers: null as null | Array<Record<string, unknown>>,
  /** The writer declines with this why (wins over `offers`). */
  skip: null as null | string,
  /** Runs while the models would be writing: a send claiming the cadence meanwhile. */
  meanwhile: null as null | (() => void),
  /** What the last angles were written from. */
  angleInput: null as null | { target: Record<string, unknown>; dossier?: string | null },
  /** What the last forced re-derivation was asked for. */
  deriveInput: null as null | Record<string, unknown>,
}));

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  loadConfig: () => cfg,
  logEvent: () => {},
  recentTouchElsewhere: () => null,
}));

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    // Angles are written for whichever offer becomes active.
    withOfferAngles: async (
      offer: Record<string, unknown>,
      input: { target: Record<string, unknown>; dossier?: string | null },
    ) => {
      derived.angleInput = input;
      derived.meanwhile?.();
      return { ...offer, angles: ["why"] };
    },
    // The forced re-derivation, without the models: stores `derived.offers`
    // the way the real one does, through the same guarded write.
    deriveSequenceOffer: async (input: { prospectId: number; playName: string }) => {
      derived.deriveInput = input;
      const record = actual.sequenceOfferRecord(input);
      if (derived.skip !== null) {
        const skip = {
          why: derived.skip,
          version: actual.OFFER_PROMPT_VERSION,
          inputHash: "h",
          productHash: "p",
          skippedAt: "2026-10-22T00:00:00.000Z",
        };
        const kept = !record.offer && actual.writeSequenceOfferSkip(record, skip);
        return {
          status: "none",
          record: kept ? { ...record, skip } : record,
          reason: "skipped",
          skip,
        };
      }
      if (!derived.offers) return { status: "none", record, reason: "nothing-derived" };
      derived.meanwhile?.();
      const [offer, ...rest] =
        derived.offers as unknown as import("@oneshot-gtm/plays").ProspectOffer[];
      const stored = actual.writeSequenceOffer({
        record,
        offer: offer!,
        offerCandidates: [offer!, ...rest],
      });
      if (!stored) return { status: "none", record, reason: "not-stored" };
      return { status: "stored", record, offer };
    },
  };
});

const { registerSequence, buildFollowUpEmail } = await import("@oneshot-gtm/plays");
const { cadenceOfferRoute } = await import("../src/api/cadence-offer.ts");
const { getCadence } = await import("../src/api/cadences.ts");

const PLAY = "cadence-offer-route-play";
const step = (label: string) => ({
  dayOffset: 3,
  channel: "email" as const,
  breakOnReply: true,
  label,
  builder: buildFollowUpEmail({ playName: PLAY, promptName: "x", contextLines: [] }),
});
registerSequence({ playName: PLAY, steps: [step("value follow-up"), step("breakup")] });

const offer = (text: string, extra: Record<string, unknown> = {}) => ({
  offer: text,
  steps: "plans routes, books jobs",
  evidence: ["opened a second depot"],
  stage: "established",
  level: "researched",
  return: `${text} · counted per job`,
  version: "v",
  inputHash: "h",
  derivedAt: "2026-10-01T00:00:00Z",
  ...extra,
});
const first = offer("book the leeds crews into same-day slots", {
  angles: ["one"],
  relevance: "relevant",
});
const second = offer("text every customer the crew's arrival time");

let n = 0;
/**
 * An active cadence linked to the sent row its intro went out from, carrying
 * `offer` (with `candidates`; `intro`: the first email carried it), with a
 * stored preview.
 */
function cadence(
  opts: {
    offer?: Record<string, unknown>;
    candidates?: unknown[];
    intro?: boolean;
    /** The intro went out from no queue row (a LinkedIn first touch, a typed list). */
    noRow?: boolean;
    /** Extra fields on the queue row's payload. */
    rowPayload?: Record<string, unknown>;
  } = {},
): { id: number; rowId: number | null } {
  const email = `dana${++n}@northside.example`;
  const id = ledger.upsertProspect({ name: "Dana Lee", email, company: "Northside Plumbing" });
  const rowId = opts.noRow
    ? null
    : ledger.enqueueTarget({
        playName: PLAY,
        payload: {
          name: "Dana Lee",
          email,
          company: "Northside Plumbing",
          signal: "opened a second depot",
          ...opts.rowPayload,
        },
        dedupeKey: `k-${email}`,
        source: "find:test",
      })!;
  if (rowId != null) ledger.setQueueStatus({ id: rowId, status: "sent" });
  ledger.recordSequenceEvent({
    prospectId: id,
    playName: PLAY,
    stepIndex: 0,
    channel: "email",
    status: "sent",
    metadata: { subject: "leeds crews", body: "Your Leeds crews could take same-day jobs." },
  });
  ledger.enrollCadence({
    prospectId: id,
    playName: PLAY,
    nextDueAt: "2026-10-25T00:00:00Z",
    queueId: rowId,
    ...(opts.offer
      ? {
          offer: {
            offer: opts.offer,
            candidates: opts.candidates ?? [],
            origin: opts.intro ? "intro" : "derived",
          },
        }
      : {}),
  });
  ledger.setCadenceDraft({
    prospectId: id,
    playName: PLAY,
    draft: {
      subject: "Re: leeds crews",
      body: "old preview",
      flags: [],
      payload: { kind: "email" },
    },
  });
  return { id, rowId };
}

async function post(id: number, body: unknown) {
  const res = await cadenceOfferRoute(
    new Request(`http://localhost/api/cadences/${id}/offer?play=${PLAY}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { id: String(id) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** The cadence's stored offer (`offer_json.offer`). */
function seqOffer(id: number): Record<string, unknown> {
  return (JSON.parse(ledger.getCadence(id, PLAY)!.offer_json ?? "{}") as Record<string, any>)[
    "offer"
  ];
}

/** The row the intro went out from never changes: the cadence owns the offer. */
function rowOffer(rowId: number | null): unknown {
  if (rowId == null) return undefined;
  return (JSON.parse(ledger.getQueueRow(rowId)!.payload_json) as Record<string, unknown>)["offer"];
}

function preview(id: number) {
  return ledger.getCadenceDraft({ prospectId: id, playName: PLAY });
}

/** The cadence as GET /api/cadences/:id shows it. */
async function viewOf(id: number): Promise<Record<string, any>> {
  const res = getCadence(new Request(`http://localhost/api/cadences/${id}`), { id: String(id) });
  return ((await res.json()) as { cadences: Array<Record<string, any>> }).cadences[0]!;
}

/** Draft versions of the next step, newest first. */
function versions(id: number) {
  return ledger.draftVersionsFor({ prospectId: id, playName: PLAY, stepIndex: 1 });
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  derived.offers = null;
  derived.skip = null;
  derived.meanwhile = null;
  derived.angleInput = null;
  derived.deriveInput = null;
  cfg.productBrief = "Acme books crews into open slots.";
});
afterEach(() => ledger.close());

describe("cadenceOfferRoute", () => {
  it("makes another of the sequence's offers active, with its angles, and drops the preview", async () => {
    const { id, rowId } = cadence({ offer: first, candidates: [first, second] });
    const out = await post(id, { select: 1 });
    expect(out.status).toBe(200);
    expect(seqOffer(id)).toMatchObject({ offer: second.offer, angles: ["why"] });
    // The old offer's judge label does not survive the swap.
    expect(seqOffer(id)["relevance"]).toBeUndefined();
    expect(rowOffer(rowId)).toBeUndefined();
    expect(out.body["offer"]).toMatchObject({
      text: second.offer,
      activeIndex: 1,
      candidates: [{ text: first.offer }, { text: second.offer, angles: ["why"] }],
    });
    expect(out.body["previewDiscarded"]).toBe(true);
    expect(preview(id)).toBeNull();
    expect(versions(id)[0]).toMatchObject({ outcome: "discarded", discard_reason: "regenerate" });
  });

  it("refuses an offer index the sequence does not have", async () => {
    const { id } = cadence({ offer: first, candidates: [first] });
    expect((await post(id, { select: 4 })).status).toBe(400);
    expect(preview(id)).not.toBeNull();
  });

  it("writes new offers on regenerate, replacing a sequence with none", async () => {
    const { id, rowId } = cadence();
    derived.offers = [first, second];
    const out = await post(id, { regenerate: true });
    expect(out.status).toBe(200);
    expect(seqOffer(id)).toMatchObject({ offer: first.offer });
    expect(rowOffer(rowId)).toBeUndefined();
    expect(out.body["offer"]).toMatchObject({ text: first.offer, activeIndex: 0 });
    expect(preview(id)).toBeNull();
  });

  it("asks for offers other than the sequence's own, waiting for research only so long", async () => {
    const { CLICK_RESEARCH_WAIT_MS } = await import("@oneshot-gtm/find");
    const { id } = cadence({ offer: second, candidates: [first, second] });
    derived.offers = [first];
    expect((await post(id, { regenerate: true })).status).toBe(200);
    expect(derived.deriveInput).toMatchObject({
      force: true,
      avoid: [first.offer, second.offer],
      researchWaitMs: CLICK_RESEARCH_WAIT_MS,
    });
  });

  it("answers 422 when no offer could be written, and keeps the preview", async () => {
    const { id } = cadence();
    const out = await post(id, { regenerate: true });
    expect(out.status).toBe(422);
    expect(preview(id)).not.toBeNull();
  });

  it("answers a writer skip with its why, keeps it on the cadence and the preview stands", async () => {
    const { id } = cadence();
    derived.skip = "Dana left Northside Plumbing in October and no longer holds the role.";
    const out = await post(id, { regenerate: true });
    expect(out.status).toBe(422);
    expect(out.body["error"]).toBe(
      "No offer: Dana left Northside Plumbing in October and no longer holds the role.",
    );
    expect(out.body["offer"]).toMatchObject({
      text: null,
      skip: { why: derived.skip, at: "2026-10-22T00:00:00.000Z" },
    });
    expect(preview(id)).not.toBeNull();
    expect((await viewOf(id))["offer"]).toMatchObject({ skip: { why: derived.skip } });
  });

  it("the founder's own text clears a stored skip", async () => {
    const { id } = cadence();
    derived.skip = "No longer at the firm.";
    await post(id, { regenerate: true });
    const out = await post(id, { offer: "quote every job the day it's asked for" });
    expect(out.status).toBe(200);
    expect(out.body["offer"]).not.toHaveProperty("skip");
    expect((await viewOf(id))["offer"]).not.toHaveProperty("skip");
    expect(JSON.parse(ledger.getCadence(id, PLAY)!.offer_json!)).not.toHaveProperty("skip");
  });

  it("saves the founder's own text as theirs, keeping the ranked list", async () => {
    const { id, rowId } = cadence({ offer: first, candidates: [first, second] });
    const out = await post(id, {
      offer: "  quote every job the day it's asked for ",
      return: "quotes sent",
    });
    expect(out.status).toBe(200);
    expect(seqOffer(id)).toMatchObject({
      offer: "quote every job the day it's asked for",
      return: "quotes sent",
      editedBy: "founder",
      evidence: [],
      angles: ["why"],
    });
    expect(out.body["offer"]).toMatchObject({ founderEdited: true, activeIndex: -1 });
    expect(out.body["offer"]["candidates"]).toHaveLength(2);
    expect(rowOffer(rowId)).toBeUndefined();
    expect(preview(id)).toBeNull();
  });

  it("refuses the founder's text without a product brief", async () => {
    cfg.productBrief = "";
    const { id } = cadence({ offer: first });
    expect((await post(id, { offer: "x" })).status).toBe(422);
    expect(preview(id)).not.toBeNull();
  });

  it("approves a weak offer bound to the one read, releasing its hold", async () => {
    const weak = { ...first, relevance: "weak" };
    const { id, rowId } = cadence({ offer: weak, candidates: [weak, second] });
    expect((await viewOf(id))["offer"]).toMatchObject({ weak: true, weakApproved: false });

    const out = await post(id, { approveWeak: true });
    expect(out.status).toBe(200);
    expect(typeof seqOffer(id)["weakApprovedAt"]).toBe("string");
    expect(rowOffer(rowId)).toBeUndefined();
    expect(out.body["offer"]).toMatchObject({ weak: false, weakApproved: true });
    expect(preview(id)).toBeNull();
  });

  it("refuses to approve an offer that is not held as weak", async () => {
    const { id } = cadence({ offer: first });
    expect((await post(id, { approveWeak: true })).status).toBe(400);
  });

  it("refuses any change to an offer the first email carried", async () => {
    const { id } = cadence({ offer: first, candidates: [first, second], intro: true });
    for (const body of [
      { select: 1 },
      { regenerate: true },
      { offer: "x" },
      { approveWeak: true },
    ]) {
      const out = await post(id, body);
      expect(out.status).toBe(409);
      expect(out.body["error"]).toContain("first email");
    }
    expect(seqOffer(id)).toMatchObject({ offer: first.offer });
    expect(preview(id)).not.toBeNull();
  });

  it("refuses while a send holds the cadence", async () => {
    const { id } = cadence({ offer: first, candidates: [first, second] });
    ledger.claimCadenceSendingMarker({
      prospectId: id,
      playName: PLAY,
      startedAtIso: new Date().toISOString(),
    });
    const out = await post(id, { select: 1 });
    expect(out.status).toBe(409);
    expect(out.body["error"]).toContain("in flight");
    expect(seqOffer(id)).toMatchObject({ offer: first.offer });
    expect(preview(id)).not.toBeNull();
  });

  it("stores nothing when a send claims the cadence while the offer is being written", async () => {
    const claim = (id: number) => () =>
      ledger.claimCadenceSendingMarker({
        prospectId: id,
        playName: PLAY,
        startedAtIso: new Date().toISOString(),
      });
    // Regenerate: the new offers are written, then refused at the store.
    const a = cadence({ offer: first, candidates: [first, second] });
    derived.offers = [second];
    derived.meanwhile = claim(a.id);
    const regen = await post(a.id, { regenerate: true });
    expect(regen.status).toBe(409);
    expect(regen.body["error"]).toContain("in flight");
    expect(seqOffer(a.id)).toMatchObject({ offer: first.offer });
    expect(preview(a.id)).not.toBeNull();

    // Select: the angles are written, then the swap is refused.
    const b = cadence({ offer: first, candidates: [first, second] });
    derived.meanwhile = claim(b.id);
    expect((await post(b.id, { select: 1 })).status).toBe(409);
    expect(seqOffer(b.id)).toMatchObject({ offer: first.offer });
    expect(preview(b.id)).not.toBeNull();
  });

  it("takes the angles' research from the queue row the sequence started from", async () => {
    const { id } = cadence({ offer: first, candidates: [first, second] });
    expect((await post(id, { select: 1 })).status).toBe(200);
    expect(derived.angleInput?.target).toMatchObject({ signal: "opened a second depot" });
    // The old offer is never material for the new one's angles.
    expect(derived.angleInput?.target["offer"]).toBeUndefined();
  });

  it("drops the row's intro offer and adds the prospect's dossier to the queue row's research", async () => {
    const { id } = cadence({
      offer: first,
      candidates: [first, second],
      rowPayload: { offer: { offer: "the intro's old offer" }, offerCandidates: [first] },
    });
    ledger.setProspectDossier(id, JSON.stringify({ person: "runs two depots in Leeds" }));
    expect((await post(id, { select: 1 })).status).toBe(200);
    expect(derived.angleInput?.target).toMatchObject({ signal: "opened a second depot" });
    expect(derived.angleInput?.target["offer"]).toBeUndefined();
    expect(derived.angleInput?.target["offerCandidates"]).toBeUndefined();
    expect(derived.angleInput?.dossier).toContain("runs two depots in Leeds");
  });

  it("changes the offer of a sequence with no queue row, from the prospect and their dossier", async () => {
    const { id } = cadence({ offer: first, candidates: [first, second], noRow: true });
    ledger.setProspectDossier(id, JSON.stringify({ person: "runs two depots in Leeds" }));

    const picked = await post(id, { select: 1 });
    expect(picked.status).toBe(200);
    expect(seqOffer(id)).toMatchObject({ offer: second.offer });
    expect(derived.angleInput?.target).toMatchObject({
      name: "Dana Lee",
      company: "Northside Plumbing",
    });
    expect(derived.angleInput?.dossier).toContain("runs two depots in Leeds");

    const typed = await post(id, { offer: "quote every job the day it's asked for" });
    expect(typed.status).toBe(200);
    expect(seqOffer(id)).toMatchObject({ editedBy: "founder" });

    const weak = cadence({ offer: { ...first, relevance: "weak" }, noRow: true });
    expect((await post(weak.id, { approveWeak: true })).status).toBe(200);
    expect(typeof seqOffer(weak.id)["weakApprovedAt"]).toBe("string");

    const none = cadence({ noRow: true });
    derived.offers = [first, second];
    expect((await post(none.id, { regenerate: true })).status).toBe(200);
    expect(seqOffer(none.id)).toMatchObject({ offer: first.offer });
  });

  it("refuses a cadence that is not active, and one that does not exist", async () => {
    const { id } = cadence({ offer: first });
    ledger.stopCadence({ prospectId: id, playName: PLAY, reason: "not_a_fit" });
    expect((await post(id, { select: 0 })).status).toBe(409);
    const missing = await cadenceOfferRoute(
      new Request(`http://localhost/api/cadences/${id}/offer?play=another-play`, {
        method: "POST",
        body: "{}",
      }),
      { id: String(id) },
    );
    expect(missing.status).toBe(404);
  });
});

describe("the cadence view", () => {
  it("carries the sequence's offer, its list and whether it can change", async () => {
    const { id } = cadence({ offer: first, candidates: [first, second] });
    expect((await viewOf(id))["offer"]).toEqual({
      text: first.offer,
      return: first.return,
      steps: first.steps,
      angles: ["one"],
      evidence: first.evidence,
      stage: first.stage,
      level: "researched",
      relevance: "relevant",
      weak: false,
      weakApproved: false,
      founderEdited: false,
      candidates: [
        expect.objectContaining({ text: first.offer }),
        expect.objectContaining({ text: second.offer }),
      ],
      activeIndex: 0,
      introCarriedOffer: false,
    });
  });

  it("marks an offer the first email carried, and a sequence with none", async () => {
    const carried = cadence({ offer: first, intro: true });
    const none = cadence();
    expect((await viewOf(carried.id))["offer"]).toMatchObject({
      text: first.offer,
      introCarriedOffer: true,
    });
    expect((await viewOf(none.id))["offer"]).toEqual(
      expect.objectContaining({ text: null, candidates: [] }),
    );
    expect((await viewOf(none.id))["offer"]).not.toHaveProperty("queueRowId");
  });
});
