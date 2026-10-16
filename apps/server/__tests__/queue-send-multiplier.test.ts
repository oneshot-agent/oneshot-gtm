import { beforeEach, describe, expect, it, vi } from "vitest";
import { automaticMailEligible } from "@oneshot-gtm/core";

// A reviewed /queue send of a multiplier row (#883) records the prospect the
// play's own run does: the organization as its company and
// `multiplier-<orgType>` as its source, so the letter's address eligibility
// (which needs a company) holds for a row imported with no `company` field.

const state = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>,
  prospectMeta: null as Record<string, unknown> | null,
  statuses: [] as string[],
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  isDraining: () => false,
  getLedger: () => ({
    getQueueRow: () => row(),
    findProspectByEmail: () => null,
    getProspectById: () => null,
    claimQueueSendingMarker: () => true,
    clearQueueSendingMarker: () => {},
    setQueueStatus: (input: { status: string }) => state.statuses.push(input.status),
    setQueueDraft: () => {},
  }),
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  sendDraftedEmail: async (opts: { prospectMeta: Record<string, unknown> }) => {
    state.prospectMeta = opts.prospectMeta;
    return { sent: true, receiptIds: [11] };
  },
}));
vi.mock("../src/telemetry.ts", () => ({ reportServerExecution: () => {} }));
const { sendDraftRoute } = await import("../src/api/queue.ts");

function row() {
  return {
    id: 1,
    play_name: "multiplier",
    channel: "email",
    status: "approved",
    source: "find:orgs:1",
    payload_json: JSON.stringify(state.payload),
    last_draft_json: JSON.stringify({
      subject: "for your members",
      body: "A reviewed draft",
      flags: [],
      sent: false,
      receiptIds: [],
      dryRun: true,
    }),
    found_at: "2026-10-01 00:00:00",
  };
}

beforeEach(() => {
  state.payload = {
    organization: "Harbor Founders Program",
    orgType: "association",
    name: "Jordan Lee",
    email: "jordan@harbor.example",
    role: "Head of Partnerships",
    memberDescription: "Forty pre-seed B2B software companies a year.",
    whyFit: "Each cohort company has to find its first twenty customers.",
    businessAddress: {
      name: "Jordan Lee",
      address_line1: "1 Harbor St",
      address_city: "Boston",
      address_state: "MA",
      address_zip: "02110",
      address_country: "US",
    },
  };
  state.prospectMeta = null;
  state.statuses = [];
});

describe("reviewed send of a multiplier row", () => {
  it("records the organization as the company and multiplier-<orgType> as the source", async () => {
    const res = await sendDraftRoute(
      new Request("http://localhost/api/queue/1/send-draft", { method: "POST" }),
      { id: "1" },
    );
    expect(res.status).toBe(200);
    expect(state.statuses).toEqual(["sent"]);
    expect(state.prospectMeta).toMatchObject({
      email: "jordan@harbor.example",
      company: "Harbor Founders Program",
      source: "multiplier-association",
      businessAddress: { address_line1: "1 Harbor St" },
    });
    // The letter step's eligibility reads that company and address.
    expect(automaticMailEligible("multiplier", state.prospectMeta!)).toBe(true);
  });
});
