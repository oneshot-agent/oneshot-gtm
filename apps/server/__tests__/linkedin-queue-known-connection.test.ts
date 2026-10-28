import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetInviteLimitsCacheForTests,
  _resetPaidCache,
  getSharedDb,
  loadConfig,
  paidCacheKey,
  saveConfig,
} from "@oneshot-gtm/core";

// send-draft on a LinkedIn row for someone a recent profile read shows as
// already connected: no invite goes out, the connection is recorded and the
// row is sent. A row drafted that way whose read no longer says so gets its
// connection request drafted for review instead.

const PROFILE = "https://www.linkedin.com/in/dana-lee";

interface FakeRow {
  id: number;
  play_name: string;
  channel: string;
  payload_json: string;
  status: string;
  prospect_id: number | null;
  notes: string | null;
  last_draft_json: string | null;
}

let row: FakeRow;
const recorded: Array<Record<string, unknown>> = [];
const statusCalls: Array<Record<string, unknown>> = [];
const drafts: Array<Record<string, unknown>> = [];
const versionCloses: Array<[number, string]> = [];
const enrolled: Array<Record<string, unknown>> = [];
const linkedInCalls: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    currentWorkspaceName: () => "alpha",
    isDraining: () => false,
    linkedInOutreachAccount: () => ({ workspace: "alpha", accountId: "acct-1" }),
    getLedger: () => ({
      getQueueRow: () => ({ ...row }),
      claimQueueSendingMarker: () => true,
      clearQueueSendingMarker: () => {},
      upsertProspect: () => 42,
      inTransaction: <T>(fn: () => T): T => fn(),
      recordLinkedInInviteEvent: (input: Record<string, unknown>) => {
        recorded.push(input);
        return 1;
      },
      setQueueProspectId: () => {},
      setQueueStatus: (input: Record<string, unknown>) => {
        statusCalls.push(input);
      },
      setQueueDraft: (input: Record<string, unknown>) => {
        drafts.push(input);
      },
      closeQueueDraftVersion: (id: number, outcome: string) => {
        versionCloses.push([id, outcome]);
        return true;
      },
      enrollCadence: (input: Record<string, unknown>) => {
        enrolled.push(input);
      },
      getCadence: () => ({ enrolled_at: "2026-09-27 00:00:00", channel: "linkedin" }),
      getCadencePlan: () => null,
      saveCadencePlan: () => {},
    }),
  };
});
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: async (_workspace: string, op: Record<string, unknown>) => {
    linkedInCalls.push(op);
    return { invitation_id: "inv-1", status: "sent" };
  },
}));

const { sendDraftRoute } = await import("../src/api/queue.ts");

const post = () => new Request("http://localhost/api/queue/1/send-draft", { method: "POST" });

function profileRead(networkDistance: string, ageDays = 2): void {
  const at = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  getSharedDb().setPaidCache({
    key: paidCacheKey("linkedin.profile_read", { url: PROFILE }),
    callType: "linkedin.profile_read",
    status: "ok",
    resultJson: JSON.stringify({ url: PROFILE, readAt: at, experience: [], networkDistance }),
    costUsd: 0.01,
    fetchedAt: at,
  });
}

const connectionDraft = JSON.stringify({
  subject: "LinkedIn: already connected",
  body: "Already connected (profile read 2026-10-20): no connection request. The first message comes up on /cadences.",
  flags: [],
  knownConnection: { readAt: "2026-10-20T09:00:00.000Z" },
});

beforeEach(() => {
  process.env["ONESHOT_GTM_SHARED"] = mkdtempSync(join(tmpdir(), "linkedin-queue-known-"));
  _resetPaidCache();
  _resetInviteLimitsCacheForTests();
  // The shipped templates write the note: no model call.
  saveConfig({ ...loadConfig(), linkedin: undefined });
  row = {
    id: 1,
    play_name: "luma-events",
    channel: "linkedin",
    payload_json: JSON.stringify({ name: "Dana Lee", linkedinUrl: PROFILE }),
    status: "approved",
    prospect_id: null,
    notes: null,
    last_draft_json: connectionDraft,
  };
  for (const list of [recorded, statusCalls, drafts, versionCloses, enrolled, linkedInCalls])
    list.length = 0;
});

describe("send-draft for a known connection", () => {
  it("records the connection, calls LinkedIn for nothing, and marks the row sent", async () => {
    profileRead("FIRST_DEGREE");
    const res = await sendDraftRoute(post(), { id: "1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, prospectId: 42, status: "already_connected" });
    expect(linkedInCalls).toEqual([]);
    expect(recorded[0]).toMatchObject({
      stepIndex: 0,
      status: "sent",
      metadata: { via: "profile-read", inviteStatus: "already_connected", accountId: "acct-1" },
    });
    expect(statusCalls).toEqual([{ id: 1, status: "sent", decidedBy: "human" }]);
    // The row keeps the connection as what shipped, stored as unattended: no
    // text went out, so it is never a reviewed send.
    expect(drafts.at(-1)).toMatchObject({
      id: 1,
      sentBy: "machine",
      draft: { subject: "LinkedIn: already connected", sent: true, knownConnection: {} },
    });
    expect(versionCloses).toEqual([]);
    expect(enrolled[0]).toMatchObject({ channel: "linkedin", queueId: 1 });
    expect(Date.parse(String(enrolled[0]!["nextDueAt"]))).toBeLessThanOrEqual(Date.now());
  });

  it("a reviewed note for someone now shown as connected sends no invite either", async () => {
    profileRead("FIRST_DEGREE");
    row.last_draft_json = JSON.stringify({
      subject: "LinkedIn invite → Dana Lee",
      body: "reviewed",
      flags: [],
    });
    const res = await sendDraftRoute(post(), { id: "1" });
    expect(res.status).toBe(200);
    expect(linkedInCalls).toEqual([]);
    expect(recorded[0]).toMatchObject({ metadata: { via: "profile-read" } });
    expect(await res.json()).toMatchObject({ status: "already_connected" });
    // The note never went out: the row now says so, and offers no withdraw.
    expect(drafts.at(-1)).toMatchObject({
      draft: { subject: "LinkedIn: already connected", knownConnection: {} },
    });
  });

  it("a connection draft whose read no longer says so gets a note drafted for review, unsent", async () => {
    profileRead("SECOND_DEGREE", 0);
    const res = await sendDraftRoute(post(), { id: "1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/a connection request was drafted for review/),
    });
    expect(linkedInCalls).toEqual([]);
    expect(recorded).toEqual([]);
    expect(drafts[0]).toMatchObject({
      id: 1,
      draft: { subject: "LinkedIn invite → Dana Lee", sent: false },
      discardReason: "redraft",
    });
    expect(String((drafts[0]!["draft"] as { body: string }).body)).toMatch(/^Hi Dana/);
    expect(statusCalls).toEqual([{ id: 1, status: "pending", decidedBy: "machine" }]);
  });

  it("the invite guard still refuses: the reason goes on the draft and the row back to pending", async () => {
    profileRead("FIRST_DEGREE");
    row.payload_json = JSON.stringify({ name: "SWE-agent", linkedinUrl: PROFILE });
    const res = await sendDraftRoute(post(), { id: "1" });
    expect(res.status).toBe(409);
    expect(recorded).toEqual([]);
    expect((drafts[0]!["draft"] as { flags: string[] }).flags[0]).toMatch(/^not-a-person:/);
    expect(statusCalls).toEqual([{ id: 1, status: "pending", decidedBy: "human" }]);
  });
});
