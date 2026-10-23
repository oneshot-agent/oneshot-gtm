import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLedger } from "@oneshot-gtm/core";
import type { RunPlayEvent } from "@oneshot-gtm/shared-types";

// Every path an intro of an offer-making play goes out by starts a sequence
// that owns the offer it opened with (`cadence_state.offer_json`) and links
// the queue row it went out from (a sent row linked to the prospect). The
// step-0 send record keeps the angle, never a copy of the offer. /api/run
// with a typed list, /queue Send, Mark sent, and /run loaded from the queue
// (whose page edits every field as text). Real ledger in the per-file temp
// home (vitest.setup.ts), real play, stubbed models and send.

const llm = vi.hoisted(() => ({ names: [] as string[], drafts: [] as string[] }));
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
    loadConfig: () => ({
      founderName: "Founder",
      productOneLiner: "thing",
      productBrief: "Thing drafts quotes, checks price lists and sends them for approval.",
      pilotOffer: "a month on one team",
      cadenceOverrides: null,
    }),
    getCachedNewsfeed: () => null,
    recentTouchElsewhere: () => null,
    enrichProfile: async () => ({ result: { profile: { note: "renewal quotes" } }, receiptId: 0 }),
    sendEmail: async (input: { subject: string }) => {
      const receiptId = actual.getLedger().recordReceipt({
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
      llm.names.push(name);
      if (name === "prospect-offer") return reply(JSON.stringify({ offers: [OFFER] }));
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
          body: `I can ${offer ?? "help"}, start to finish. Worth trying on one team?\n\nFounder`,
        }),
      );
    },
  };
});

vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  verifyAndFilterTargets: async (targets: unknown[]) => ({
    verified: targets,
    dropped: [],
    receiptIds: [],
    costUsd: 0,
  }),
}));
vi.mock("../src/telemetry.ts", () => ({ reportServerExecution: () => {} }));

const { runPlay, restoreQueueObjects } = await import("../src/api/run.ts");
const { sendDraftRoute, markSentRoute } = await import("../src/api/queue.ts");
const { sequenceOfferRecord, introQueueDedupeKey, OFFER_PROMPT_VERSION } =
  await import("@oneshot-gtm/plays");

const PLAY = "design-partner-loi";
let n = 0;
function target(): Record<string, string> {
  return {
    name: "Jamie Buyer",
    email: `jamie${++n}@enterprise-corp.example`,
    company: "Enterprise Corp",
    buyerType: "enterprise",
    yourEdge: "quotes the same day",
  };
}

async function run(body: unknown): Promise<RunPlayEvent[]> {
  const res = await runPlay(
    new Request(`http://127.0.0.1:3030/api/run/${PLAY}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3030" },
      body: JSON.stringify(body),
    }),
    { playName: PLAY },
  );
  const text = await new Response(res.body).text();
  return text
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((d) => JSON.parse(d) as RunPlayEvent);
}

function payloadOf(id: number): Record<string, unknown> {
  return JSON.parse(getLedger().getQueueRow(id)!.payload_json) as Record<string, unknown>;
}

function step0Meta(prospectId: number): Record<string, unknown> {
  const step0 = getLedger()
    .listSequenceEventsForProspectPlay(prospectId, PLAY)
    .find((e) => e.step_index === 0)!;
  return JSON.parse(step0.metadata_json ?? "{}") as Record<string, unknown>;
}

/** An approved queue row with a reviewed draft, the way /queue holds one before Send. */
function approvedRow(
  payload: Record<string, unknown>,
  opts: { channel?: "email" | "x"; draft?: Record<string, unknown> } = {},
): number {
  const ledger = getLedger();
  const id = ledger.enqueueTarget({
    playName: PLAY,
    payload,
    dedupeKey: `k-${++n}`,
    source: "find:test",
    ...(opts.channel ? { channel: opts.channel } : {}),
  })!;
  ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
  ledger.setQueueDraft({
    id,
    draft: {
      subject: "renewal quotes",
      body: `I can ${OFFER.offer}. Worth trying on one team?`,
      flags: [],
      sent: false,
      receiptIds: [],
      dryRun: true,
      ...opts.draft,
    },
  });
  return id;
}

const storedOffer = (over: Record<string, unknown> = {}) => ({
  ...OFFER,
  version: "offer-v4",
  inputHash: "h",
  derivedAt: "2026-10-20T00:00:00Z",
  ...over,
});
const angle = {
  text: "same-day quotes win renewals",
  origin: "configured",
  index: 0,
  count: 2,
  fingerprint: "f",
  history: [],
};

beforeEach(() => {
  llm.names = [];
  llm.drafts = [];
});

describe("/api/run with a typed list", () => {
  it("a live send keeps a sent queue row with the email and the offer, linked to the prospect", async () => {
    const t = target();
    const frames = await run({ dryRun: false, targets: [t] });
    expect(frames.find((f) => f.kind === "done")).toMatchObject({ sent: 1 });

    const row = getLedger().getQueueRowByDedupe(PLAY, introQueueDedupeKey(t.email!))!;
    const prospect = getLedger().findProspectByEmail(t.email!)!;
    expect(row).toMatchObject({ status: "sent", prospect_id: prospect.id });
    expect(payloadOf(row.id)).toMatchObject({ email: t.email, offer: { offer: OFFER.offer } });

    const record = sequenceOfferRecord({ prospectId: prospect.id, playName: PLAY });
    expect(record.queueRowId).toBe(row.id);
    expect(record.offer).toMatchObject({ offer: OFFER.offer, steps: OFFER.steps });
    expect(record.introCarriedOffer).toBe(true);
  });
});

describe("/queue Send", () => {
  it("links the row to the prospect, starts the sequence with the row's offer, and records the angle on step 0", async () => {
    const t = target();
    const second = storedOffer({ offer: "get every price list checked before a quote goes out" });
    const id = approvedRow(
      {
        ...t,
        offer: storedOffer({ editedBy: "founder" }),
        offerCandidates: [storedOffer(), second],
      },
      { draft: { angle, formatKey: "brief" } },
    );
    const res = await sendDraftRoute(new Request("http://localhost/x", { method: "POST" }), {
      id: String(id),
    });
    expect(res.status).toBe(200);

    const prospect = getLedger().findProspectByEmail(t.email!)!;
    expect(getLedger().getQueueRow(id)).toMatchObject({ status: "sent", prospect_id: prospect.id });
    expect(step0Meta(prospect.id)).toMatchObject({
      angleText: angle.text,
      angleIndex: 0,
      angleCount: 2,
      firstTouchFormat: "brief",
    });
    expect(step0Meta(prospect.id)).not.toHaveProperty("offer");
    expect(sequenceOfferRecord({ prospectId: prospect.id, playName: PLAY })).toMatchObject({
      queueRowId: id,
      introCarriedOffer: true,
      offer: { offer: OFFER.offer, editedBy: "founder" },
      offerCandidates: [{ offer: OFFER.offer }, { offer: second.offer }],
    });
  });

  it("a re-send keeps the sequence's offer and link", async () => {
    const t = target();
    const id = approvedRow({ ...t, offer: storedOffer() });
    await sendDraftRoute(new Request("http://localhost/x", { method: "POST" }), {
      id: String(id),
    });
    const prospect = getLedger().findProspectByEmail(t.email!)!;
    const before = getLedger().getCadence(prospect.id, PLAY)!;
    getLedger().setCadenceStatus({ prospectId: prospect.id, playName: PLAY, status: "completed" });
    getLedger().enrollCadence({
      prospectId: prospect.id,
      playName: PLAY,
      nextDueAt: "2026-11-01T00:00:00Z",
      offer: { offer: { offer: "another", steps: "x" }, candidates: [], origin: "intro" },
      queueId: id + 1000,
    });
    const after = getLedger().getCadence(prospect.id, PLAY)!;
    expect(after).toMatchObject({ queue_id: id, offer_json: before.offer_json });
  });
});

describe("Mark sent", () => {
  it("records the angle on the hand-sent step 0, and no copy of the offer", async () => {
    const id = approvedRow(
      { ...target(), handle: "jamiebuyer", offer: storedOffer() },
      { channel: "x", draft: { angle } },
    );
    const res = await markSentRoute(new Request("http://localhost/x", { method: "POST" }), {
      id: String(id),
    });
    expect(res.status).toBe(200);
    const { prospectId } = (await res.json()) as { prospectId: number };
    expect(step0Meta(prospectId)).toMatchObject({ angleText: angle.text });
    expect(step0Meta(prospectId)).not.toHaveProperty("offer");
    expect(step0Meta(prospectId)).not.toHaveProperty("offerSteps");
  });
});

/** What the /run page sends: every field as text, with the row's dedupe key. */
function asTyped(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
}

describe("/run loaded from the queue", () => {
  it("keeps the founder's edited offer: the object survives the page's text fields", async () => {
    const founder = storedOffer({ offer: "the founder's own offer", editedBy: "founder" });
    const payload = { ...target(), offer: founder, offerCandidates: [founder] };
    const id = approvedRow(payload);
    const key = getLedger().getQueueRow(id)!.dedupe_key;

    await run({ dryRun: true, targets: [asTyped(payload)], dedupeKeys: [key] });

    expect(llm.names).not.toContain("prospect-offer");
    expect(llm.drafts[0]).toContain(
      "OFFER (what you offer to do for them; the message opens with it): the founder's own offer",
    );
    expect(payloadOf(id)["offer"]).toMatchObject({
      offer: "the founder's own offer",
      editedBy: "founder",
    });
  });

  it("a live send links the sequence to the row and gives it the offer the run wrote", async () => {
    const payload = target();
    const id = approvedRow(payload);
    const key = getLedger().getQueueRow(id)!.dedupe_key;

    await run({ dryRun: false, targets: [payload], dedupeKeys: [key] });

    expect(llm.names).toContain("prospect-offer");
    const prospect = getLedger().findProspectByEmail(payload.email!)!;
    expect(sequenceOfferRecord({ prospectId: prospect.id, playName: PLAY })).toMatchObject({
      queueRowId: id,
      introCarriedOffer: true,
      offer: { offer: OFFER.offer, version: OFFER_PROMPT_VERSION },
      offerCandidates: [{ offer: OFFER.offer }],
    });
    // No row of its own is recorded: the batch's row is the one it went out from.
    expect(getLedger().getQueueRowByDedupe(PLAY, introQueueDedupeKey(payload.email!))).toBeNull();
  });

  it("parses object fields back from text, and falls back to the row's own when the text is not JSON", () => {
    const research = { version: 1, status: "complete", organizations: [] };
    const payload = { ...target(), personResearch: research, offer: storedOffer() };
    const id = approvedRow(payload);
    const key = getLedger().getQueueRow(id)!.dedupe_key;
    const sent = { ...asTyped(payload), offer: "edited into plain words" };

    const out = restoreQueueObjects(PLAY, { dryRun: true, targets: [sent], dedupeKeys: [key] });
    const restored = out.targets[0] as Record<string, unknown>;
    expect(restored["personResearch"]).toEqual(research);
    expect(restored["offer"]).toEqual(storedOffer());
    expect(restored["name"]).toBe("Jamie Buyer");

    // A typed row (no dedupe key) is left exactly as sent.
    const typed = { dryRun: true, targets: [sent] };
    expect(restoreQueueObjects(PLAY, typed)).toBe(typed);
  });
});
