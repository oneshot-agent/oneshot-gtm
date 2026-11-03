import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `linkedin reconcile`: a message recorded as failed when the worker stopped
// waiting, and an invite claim that never settled. Dry run prints what it
// would record; --write records it. Neither sends.

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    currentWorkspaceName: () => "acme",
    linkedInOutreachAccount: () => ({ workspace: "acme", accountId: "acct-1" }),
    logEvent: () => {},
  };
});

const { getLedger, getSharedDb, claimLinkedInProfile, normalizeLinkedInProfile } =
  await import("@oneshot-gtm/core");
const { enrollInCadence } = await import("@oneshot-gtm/plays");
const { commandLinkedInReconcile } = await import("../src/commands/linkedin.ts");

const PLAY = "luma-events";
const WORKER_STOPPED = "LinkedIn workspace worker stopped before returning a result";
let out = "";
let calls: Array<Record<string, unknown>> = [];
let prospectId = 0;

const later = () => new Date(Date.now() + 60_000).toISOString();
type Invitation = { invitation_id: string; status: string; profile: string; updated_at: string };
/** What the account's invitation lists hold, by status. */
let lists: Record<string, Invitation[]> = {};
/** Recover answers for invite keys (queue rows); any other key reads as a completed message. */
let invites: Record<string, Record<string, unknown>> = {};
/** Single invitation reads, by id. */
let invitationById: Record<string, Invitation> = {};

const linkedIn = async (_workspace: string, op: unknown) => {
  const o = op as Record<string, unknown>;
  calls.push(o);
  switch (o["kind"]) {
    case "recover": {
      const key = String(o["idempotencyKey"]);
      if (o["endpoint"] === "linkedin/invite")
        return invites[key] ?? { status: "unknown", acceptance: "unknown" };
      return {
        tool: "linkedin",
        status: "completed",
        linkedin: { action: "message", scheduled_for: null },
        receipt_id: "rcpt_1",
        request_id: "job-9",
      };
    }
    case "wait":
      if (o["requestId"] === "job-inv")
        throw Object.assign(new Error("Job failed: content_rejected"), {
          name: "JobError",
          code: "content_rejected",
        });
      return { status: "sent", conversation_id: "conv-9", message_id: "m-9" };
    case "invitations": {
      const status = String(o["status"]);
      const since = typeof o["changedSince"] === "string" ? Date.parse(o["changedSince"]) : 0;
      return {
        invitations: (lists[status] ?? []).filter((i) => Date.parse(i.updated_at) > since),
      };
    }
    case "invitation":
      return invitationById[String(o["invitationId"])] ?? null;
    default:
      throw new Error(`unexpected ${String(o["kind"])}`);
  }
};

/** An invite claim whose outcome never came back. */
function dispatchedClaim(slug: string): void {
  const claimed = claimLinkedInProfile({
    profile: normalizeLinkedInProfile(`https://www.linkedin.com/in/${slug}`)!,
    workspace: "acme",
  });
  if (claimed.ok) claimed.claim.dispatch();
}
const claimLine = (slug: string) => out.split("\n").find((l) => l.includes(`${slug} · claim`));

beforeEach(() => {
  out = "";
  calls = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
  const ledger = getLedger();
  prospectId = ledger.upsertProspect({
    name: "Dana Lee",
    email: null,
    linkedin_url: `https://www.linkedin.com/in/dana-${Math.random().toString(36).slice(2)}`,
    source: PLAY,
  });
  ledger.recordLinkedInInviteEvent({
    prospectId,
    playName: PLAY,
    stepIndex: 0,
    status: "sent",
    metadata: {
      note: "hello",
      body: "hello",
      invitationId: "inv-0",
      accountId: "acct-1",
      accountWorkspace: "acme",
      acceptedAt: "2026-11-01T09:00:00Z",
    },
  });
  enrollInCadence({ prospectId, playName: PLAY, channel: "linkedin" });
  ledger.setCadenceDraft({
    prospectId,
    playName: PLAY,
    draft: {
      subject: "LinkedIn message",
      body: "reviewed message",
      flags: [],
      payload: { kind: "linkedin_message", text: "reviewed message" },
    },
  });
  ledger.recordCadenceSendError({ prospectId, playName: PLAY, error: WORKER_STOPPED });
  // To a profile OneShot lists as not sent since the claim.
  dispatchedClaim("erin-park");
  lists = {
    not_sent: [
      { invitation_id: "inv-e", status: "not_sent", profile: "erin-park", updated_at: later() },
    ],
  };
  invites = {};
  invitationById = {};
});

afterEach(() => vi.restoreAllMocks());

const sent = () =>
  getLedger()
    .listSequenceEventsForProspectPlay(prospectId, PLAY)
    .filter((e) => e.step_index === 1 && e.status === "sent");

describe("linkedin reconcile", () => {
  it("dry run asks OneShot by the dispatch's key and records nothing", async () => {
    await commandLinkedInReconcile({}, linkedIn);
    expect(calls.find((c) => c["kind"] === "recover")).toMatchObject({
      endpoint: "linkedin/message",
      idempotencyKey: `gtm:acme:cadence:${prospectId}:${PLAY}:1`,
    });
    expect(out).toContain(`#${prospectId} ${PLAY} · message · completed · would record the send`);
    expect(claimLine("erin-park")).toContain(
      "erin-park · claim · not_sent · would free the profile",
    );
    expect(out).toContain("Dry run");
    expect(sent()).toEqual([]);
    expect(getLedger().getCadence(prospectId, PLAY)!.last_send_error).toBe(WORKER_STOPPED);
    expect(getSharedDb().linkedInTouch("erin-park")?.status).toBe("dispatched");
    expect(calls.map((c) => c["kind"])).not.toContain("wait");
  });

  it("asks by the key the latest send went under, after a failed job moved it on", async () => {
    const base = `gtm:acme:cadence:${prospectId}:${PLAY}:1`;
    getLedger().linkedInSendAttempts.noteFailed(
      base,
      Object.assign(new Error("Job failed: rate_limited"), {
        name: "JobError",
        code: "rate_limited",
      }),
    );
    await commandLinkedInReconcile({ write: true }, linkedIn);
    const asked = calls.filter(
      (c) => c["kind"] === "recover" && String(c["idempotencyKey"]).startsWith(base),
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => c["idempotencyKey"] === `${base}:r1`)).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(getLedger().linkedInPending.list()).toEqual([]);
  });

  it("--write records the message as sent, moves the cadence on and frees the profile, sending nothing", async () => {
    await commandLinkedInReconcile({ write: true }, linkedIn);
    expect(sent()).toHaveLength(1);
    expect(JSON.parse(sent()[0]!.metadata_json!)).toMatchObject({
      body: "reviewed message",
      conversationId: "conv-9",
      accountWorkspace: "acme",
    });
    expect(getLedger().getCadence(prospectId, PLAY)).toMatchObject({
      current_step: 1,
      last_send_error: null,
    });
    expect(getLedger().linkedInPending.list()).toEqual([]);
    expect(getSharedDb().linkedInTouch("erin-park")).toBeNull();
    // Reads only: the three invitation lists, never a send.
    expect(calls.map((c) => c["kind"]).filter((k) => k !== "recover" && k !== "wait")).toEqual([
      "invitations",
      "invitations",
      "invitations",
    ]);
    expect(calls.filter((c) => c["kind"] === "invitations").map((c) => c["status"])).toEqual([
      "not_sent",
      "pending",
      "accepted",
    ]);
    expect(out).toContain("sent: record the send and move the cadence on");
    // Run again: nothing left to do.
    calls = [];
    out = "";
    await commandLinkedInReconcile({ write: true }, linkedIn);
    expect(
      calls.filter(
        (c) =>
          c["kind"] === "recover" &&
          c["idempotencyKey"] === `gtm:acme:cadence:${prospectId}:${PLAY}:1`,
      ),
    ).toEqual([]);
  });

  it("keeps a claim whose not_sent invitation is older than the claim", async () => {
    dispatchedClaim("old-refusal");
    lists["not_sent"]!.push({
      invitation_id: "inv-o",
      status: "not_sent",
      profile: "old-refusal",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await commandLinkedInReconcile({ write: true }, linkedIn);
    expect(claimLine("old-refusal")).toContain("kept: no not_sent invitation");
    expect(getSharedDb().linkedInTouch("old-refusal")?.status).toBe("dispatched");
  });

  it("keeps a claim when the account has a live invitation to the profile, or the list can't be read whole", async () => {
    dispatchedClaim("live-one");
    lists["not_sent"]!.push({
      invitation_id: "inv-l1",
      status: "not_sent",
      profile: "live-one",
      updated_at: later(),
    });
    lists["pending"] = [
      {
        invitation_id: "inv-l2",
        status: "pending",
        profile: "https://www.linkedin.com/in/live-one",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    await commandLinkedInReconcile({ write: true }, linkedIn);
    expect(claimLine("live-one")).toContain(
      "kept: the account has a pending or accepted invitation",
    );
    expect(getSharedDb().linkedInTouch("live-one")?.status).toBe("dispatched");
    // A full page of accepted invitations may hide one to this profile.
    lists["pending"] = [];
    lists["accepted"] = Array.from({ length: 100 }, (_, i) => ({
      invitation_id: `a-${i}`,
      status: "accepted",
      profile: `someone-${i}`,
      updated_at: "2026-01-01T00:00:00.000Z",
    }));
    out = "";
    await commandLinkedInReconcile({ write: true }, linkedIn);
    expect(claimLine("live-one")).toContain(
      "kept: the account's live invitations could not all be read",
    );
    expect(getSharedDb().linkedInTouch("live-one")?.status).toBe("dispatched");
  });

  it("frees a claim its own invite proves was never sent, and puts the row back with the refusal", async () => {
    const ledger = getLedger();
    const id = ledger.enqueueTarget({
      playName: PLAY,
      payload: { name: "Sam Lee", linkedinUrl: "https://www.linkedin.com/in/sam-lee" },
      dedupeKey: "sam-lee",
      source: "test",
      channel: "linkedin",
    })!;
    ledger.setQueueDraft({
      id,
      draft: {
        subject: "LinkedIn invite",
        body: "hi Sam",
        flags: [],
        sent: false,
        receiptIds: [],
        dryRun: false,
      },
    });
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
    dispatchedClaim("sam-lee");
    // Not in the not_sent list: only the row's own invite proves it.
    invites[`gtm:acme:queue:${id}:invite`] = {
      tool: "linkedin",
      status: "failed",
      linkedin: { action: "invite", invitation_id: "inv-s" },
      request_id: "job-inv",
    };
    invitationById["inv-s"] = {
      invitation_id: "inv-s",
      status: "not_sent",
      profile: "sam-lee",
      updated_at: later(),
    };
    await commandLinkedInReconcile({}, linkedIn);
    expect(claimLine("sam-lee")).toContain("not_sent (its own invite) · would free the profile");
    expect(getSharedDb().linkedInTouch("sam-lee")?.status).toBe("dispatched");
    out = "";
    await commandLinkedInReconcile({ write: true }, linkedIn);
    expect(claimLine("sam-lee")).toContain("freed the profile");
    expect(getSharedDb().linkedInTouch("sam-lee")).toBeNull();
    const row = ledger.getQueueRow(id)!;
    expect(row.status).toBe("pending");
    expect(JSON.parse(row.last_draft_json!)).toMatchObject({
      body: "hi Sam",
      flags: ["linkedin-invite-refused: LinkedIn refused this invite (content_rejected)"],
    });
  });
  it("--write keeps a claim whose release does not land, and says so", async () => {
    dispatchedClaim("lee-park");
    lists["not_sent"] = [
      { invitation_id: "inv-l", status: "not_sent", profile: "lee-park", updated_at: later() },
    ];
    const settle = vi.spyOn(getSharedDb(), "settleLinkedInTouch").mockImplementation(() => {
      throw new Error("database is locked");
    });
    await commandLinkedInReconcile({ write: true }, linkedIn);
    settle.mockRestore();
    expect(claimLine("lee-park")).toContain("could not be released");
    expect(claimLine("lee-park")).not.toContain("freed the profile");
    expect(getSharedDb().linkedInTouch("lee-park")?.status).toBe("dispatched");
  });
});
