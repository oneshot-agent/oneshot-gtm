import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductResearchDossier } from "@oneshot-gtm/core";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// A regenerate on a row with no company research reads it first, but waits
// only so long: a read past the wait goes on and writes the row when it
// lands, usually while the draft is being written. That write is the route's
// own enrichment, so the save must not read it as a concurrent change and
// answer 409 after minutes of paid work. Any other writer still gets one.
// Real ledger, so the save's compare-and-set is the real one.

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  logEvent: () => {},
}));

// The research wait, short enough for a test to outlast.
vi.mock("@oneshot-gtm/find", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find")),
  CLICK_RESEARCH_WAIT_MS: 10,
}));

// The company read itself: held until the test lets it land.
let landResearch: ((dossier: ProductResearchDossier) => void) | null = null;
vi.mock("../../../packages/find/src/_product-research.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/find/src/_product-research.ts")
  >("../../../packages/find/src/_product-research.ts");
  return {
    ...actual,
    researchQueueRowProduct: () =>
      new Promise((resolve) => {
        landResearch = (dossier) => resolve({ dossier, costUsd: 0.2, cached: false });
      }),
  };
});

// What happens while the draft is written.
let duringGeneration: (() => Promise<void> | void) | null = null;
vi.mock("../src/api/_play-dispatch.ts", () => ({
  dispatchPlay: async () => {
    await duringGeneration?.();
    return [{ subject: "subj", body: "a fresh draft", flags: [], receiptIds: [], sent: false }];
  },
}));

const { regenerateQueueDraft } = await import("../src/api/queue.ts");
const { _resetResearchWrites } = await import("../../../packages/find/src/_product-research.ts");

const pages: ProductResearchDossier = {
  version: 1,
  status: "complete",
  researchedAt: "2026-11-01T09:00:00.000Z",
  subject: { name: "Mara Quill", company: "Lanternworks" },
  sources: [{ url: "https://lanternworks.example", kind: "website", excerpt: "Tide tables." }],
};

let rowId: number;

beforeEach(() => {
  ledger = new Ledger(":memory:");
  _resetResearchWrites();
  landResearch = null;
  duringGeneration = null;
  rowId = ledger.enqueueTarget({
    playName: "show-hn",
    payload: { name: "Mara Quill", email: "mara@lanternworks.example", company: "Lanternworks" },
    dedupeKey: "mara@lanternworks.example",
    source: "find:test",
  })!;
  ledger.setQueueStatus({ id: rowId, status: "approved" });
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
});

/** Let the held read land and wait until it is on the row. */
async function researchLands(): Promise<void> {
  await vi.waitFor(() => expect(landResearch).not.toBeNull());
  landResearch!(pages);
  await vi.waitFor(() =>
    expect(JSON.parse(ledger.getQueueRow(rowId)!.payload_json).productResearch).toEqual(pages),
  );
}

function savedDraft(): { body?: string } | null {
  const json = ledger.getQueueRow(rowId)?.last_draft_json;
  return json ? (JSON.parse(json) as { body?: string }) : null;
}

describe("regenerate while its own company research lands", () => {
  it("saves the draft: the route's own research write is no concurrent change", async () => {
    duringGeneration = researchLands;
    const out = await regenerateQueueDraft(rowId);
    expect(out.status).toBe(200);
    expect(savedDraft()?.body).toBe("a fresh draft");
    // The research stays on the row for the next draft.
    expect(JSON.parse(ledger.getQueueRow(rowId)!.payload_json).productResearch).toEqual(pages);
  });

  it("still refuses the save when another writer changed the payload", async () => {
    duringGeneration = () => {
      ledger.patchLiveQueuePayload({ id: rowId, patch: { title: "Head of Tides" } });
    };
    const out = await regenerateQueueDraft(rowId);
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: "Draft changed during generation; refresh and try again.",
    });
    expect(savedDraft()).toBeNull();
  });

  it("still refuses it when another write lands beside the research", async () => {
    for (const order of ["before", "after"] as const) {
      ledger.setQueueDraft({
        id: rowId,
        draft: { subject: "s", body: "old", flags: [], sent: false, receiptIds: [], dryRun: true },
      });
      _resetResearchWrites();
      ledger.patchLiveQueuePayload({ id: rowId, patch: { productResearch: null } });
      const edit = () =>
        ledger.patchLiveQueuePayload({ id: rowId, patch: { title: `edited ${order}` } });
      duringGeneration = async () => {
        if (order === "before") edit();
        await researchLands();
        if (order === "after") edit();
      };
      const out = await regenerateQueueDraft(rowId);
      expect(out.status, order).toBe(409);
      expect(savedDraft()?.body, order).toBe("old");
    }
  });

  it("still refuses it when a send claims the row mid-generation", async () => {
    duringGeneration = async () => {
      await researchLands();
      ledger.claimQueueSendingMarker({ id: rowId, startedAtIso: new Date().toISOString() });
    };
    const out = await regenerateQueueDraft(rowId);
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: "send completed (or started) during regenerate" });
    expect(savedDraft()).toBeNull();
  });
});
