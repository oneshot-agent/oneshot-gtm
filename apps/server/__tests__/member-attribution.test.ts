import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { describeDecision } from "@oneshot-gtm/shared-types";
import { buildProspectTimeline } from "../src/api/_prospect-timeline.ts";
import { memberDecision } from "../../web/src/lib/queueCase.ts";
import {
  configDir,
  getLedger,
  getSharedDb,
  loadConfig,
  saveConfig,
  type QueueRow,
} from "@oneshot-gtm/core";

// Real request identity and workspace stores; only providers/background work are stubbed.
vi.mock("@oneshot-gtm/find", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find")),
  scheduleNewsfeedOnApproval: () => {},
  ensureQueueRowOffer: async (row: QueueRow) => row,
}));
vi.mock("../src/api/queue-phone.ts", async () => ({
  ...(await vi.importActual<typeof import("../src/api/queue-phone.ts")>(
    "../src/api/queue-phone.ts",
  )),
  schedulePhoneOnApproval: () => {},
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  sendDraftedEmail: async () => ({ sent: true, receiptIds: [] }),
  withOfferAngles: async (offer: unknown) => offer,
}));
vi.mock("../src/api/_play-dispatch.ts", () => ({
  dispatchPlay: async () => [
    { subject: "Reply", body: "Useful reply", flags: [], sent: false, receiptIds: [] },
  ],
}));
vi.mock("../src/api/workspace.ts", async () => ({
  ...(await vi.importActual<typeof import("../src/api/workspace.ts")>("../src/api/workspace.ts")),
  resolveOtherWorkspace: () => ({ ok: true }),
  ensureWorkspaceRunning: async () => ({ ok: true, port: 3999 }),
}));
const queue = await import("../src/api/queue.ts");
const { setup } = await import("../src/api/setup.ts");
const { setCadenceRoute } = await import("../src/api/plays.ts");
const { saveDraftRoute } = await import("../src/api/inbox.ts");
const answers = await import("../src/api/code-answers.ts");
const { queueOfferRoute } = await import("../src/api/queue-offer.ts");
const { cadenceOfferRoute } = await import("../src/api/cadence-offer.ts");
const { defaultSequence, offerIsCurrent, offerHoldsSend } = await import("@oneshot-gtm/plays");
const member = "mia@example.com";
const owner = "owner@example.com";
const host = "gtm.example.ts.net";
let serial = 0;
const req = (body: unknown = {}, path = "/api/queue", who = member) =>
  new Request(`https://${host}${path}`, {
    method: "POST",
    headers: { host, "tailscale-user-login": who, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id: number) => ({ id: String(id) });
const ledger = getLedger();
function read(sql: string, ...args: Array<string | number>) {
  const db = new Database(join(configDir(), "ledger.sqlite"), { readonly: true });
  try {
    return db.query(sql).all(...args) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}
function row(community = false) {
  return ledger.enqueueTarget({
    playName: community ? "community-reply" : "show-hn",
    channel: community ? "hacker-news" : "email",
    dedupeKey: `member-${++serial}`,
    source: "manual",
    payload: community
      ? {
          platform: "hacker-news",
          threadId: String(serial),
          postUrl: `https://news.ycombinator.com/item?id=${serial}`,
          postTitle: "Which CRM?",
          handle: "buyer",
          publishedAt: "2026-11-18",
          supportingText: "Which CRM supports CSV?",
          retrievedAt: "2026-11-18",
        }
      : { name: "Ada", email: `ada${serial}@example.com` },
  })!;
}
function draft(id: number) {
  ledger.setQueueDraft({
    id,
    draft: {
      subject: "Reply",
      body: "Useful reply",
      flags: [],
      sent: false,
      receiptIds: [],
      dryRun: true,
    },
  });
}
beforeEach(() => {
  getSharedDb().addMember({ email: owner, role: "owner" });
  getSharedDb().addMember({ email: member, role: "member" });
  getSharedDb().allowHost(host);
  saveConfig({ ...loadConfig(), productBrief: "Tools for planning work." });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("approve and reject store the requester, ignoring a body-supplied member", async () => {
  const id = row();
  expect((await queue.approveQueueRoute(req({ member: owner }), params(id))).status).toBe(200);
  expect(ledger.getQueueRow(id)).toMatchObject({ decided_by: "human", decided_by_member: member });
  expect((await queue.rejectQueueRoute(req({}, "/api/queue", owner), params(id))).status).toBe(200);
  expect(ledger.getQueueRow(id)).toMatchObject({ decision: "reject", decided_by_member: owner });
  expect(queue.toView(ledger.getQueueRow(id)!)).toMatchObject({ decidedByMember: owner });
});
it("approve all stamps only the matching pending rows", async () => {
  const id = row();
  const other = row(true);
  expect((await queue.approveAllRoute(req({ play: "show-hn" }))).status).toBe(200);
  expect(ledger.getQueueRow(id)).toMatchObject({
    decided_by: "human_bulk",
    decided_by_member: member,
  });
  expect(ledger.getQueueRow(other)?.decided_by_member).toBeNull();
});
it("move records the requester", async () => {
  const id = row();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ queueId: 7 })),
  );
  expect((await queue.moveQueueRowRoute(req({ workspace: "other" }), params(id))).status).toBe(200);
  expect(ledger.getQueueRow(id)).toMatchObject({ status: "rejected", decided_by_member: member });
});
it("failed moves restore the prior member, including pending and legacy rows", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "refused" }, { status: 409 })),
  );
  for (const status of ["approved", "rejected", "pending"] as const) {
    for (const priorMember of [owner, null]) {
      const id = row();
      ledger.setQueueStatus({ id, status: "approved", member: priorMember });
      ledger.setQueueStatus({ id, status, decidedBy: "human", member: priorMember });
      const before = ledger.getQueueRow(id)!;
      expect((await queue.moveQueueRowRoute(req({ workspace: "other" }), params(id))).status).toBe(
        409,
      );
      const restored = ledger.getQueueRow(id)!;
      expect(restored).toMatchObject({
        status,
        decision: before.decision,
        decided_by: before.decided_by,
        decided_by_member: priorMember,
      });
      expect(memberDecision(queue.toView(restored))).toBe(memberDecision(queue.toView(before)));
      expect(describeDecision(queue.toView(restored))).toBe(describeDecision(queue.toView(before)));
    }
  }
});

it("failed pending moves restore the decision history, including undecided, bulk and machine rows", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "refused" }, { status: 409 })),
  );
  for (const history of ["undecided", "human", "human_bulk", "machine"] as const) {
    const id = row();
    if (history === "human_bulk") {
      ledger.approveAllPending({ ids: [id], member: owner });
    } else if (history !== "undecided") {
      ledger.setQueueStatus({
        id,
        status: "rejected",
        decidedBy: history,
        member: owner,
        decisionReason: "wrong_person",
      });
    }
    ledger.setQueueStatus({ id, status: "pending" });
    const before = ledger.getQueueRow(id)!;
    expect((await queue.moveQueueRowRoute(req({ workspace: "other" }), params(id))).status).toBe(
      409,
    );
    const restored = ledger.getQueueRow(id)!;
    expect(restored).toMatchObject({
      status: "pending",
      reviewed_at: null,
      decision: before.decision,
      decided_at: before.decided_at,
      decided_by: before.decided_by,
      decided_by_member: before.decided_by_member,
      decision_reason: before.decision_reason,
    });
    expect(memberDecision(queue.toView(restored))).toBe(memberDecision(queue.toView(before)));
    expect(describeDecision(queue.toView(restored))).toBe(describeDecision(queue.toView(before)));
  }
});

it("failed expired moves restore the decision history, including undecided, bulk and machine rows", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "refused" }, { status: 409 })),
  );
  for (const history of ["undecided", "human", "human_bulk", "machine"] as const) {
    const id = row();
    if (history === "human") {
      ledger.setQueueStatus({
        id,
        status: "approved",
        decidedBy: "human",
        member: owner,
        decisionReason: "fit",
      });
    } else if (history === "human_bulk") {
      ledger.approveAllPending({ ids: [id], member: owner });
    } else if (history === "machine") {
      ledger.setQueueStatus({
        id,
        status: "rejected",
        decidedBy: "machine",
        decisionReason: "wrong_person",
      });
    }
    ledger.setQueueStatus({ id, status: "expired" });
    const before = ledger.getQueueRow(id)!;
    expect((await queue.moveQueueRowRoute(req({ workspace: "other" }), params(id))).status).toBe(
      409,
    );
    const restored = ledger.getQueueRow(id)!;
    expect(restored).toMatchObject({
      status: "expired",
      decision: before.decision,
      decided_at: before.decided_at,
      decided_by: before.decided_by,
      decided_by_member: before.decided_by_member,
      decision_reason: before.decision_reason,
    });
    expect(memberDecision(queue.toView(restored))).toBe(memberDecision(queue.toView(before)));
    expect(describeDecision(queue.toView(restored))).toBe(describeDecision(queue.toView(before)));
  }
});

it.each(["approved", "rejected", "expired"] as const)(
  "a failed move restores the full %s decision history",
  async (status) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "refused" }, { status: 409 })),
    );
    const id = row();
    if (status === "approved") {
      ledger.approveAllPending({ ids: [id], member: owner });
    } else if (status === "rejected") {
      ledger.setQueueStatus({
        id,
        status,
        decidedBy: "human",
        member: owner,
        decisionReason: "wrong_person",
      });
    } else {
      // Expired without ever being reviewed: the rollback must not stamp it reviewed.
      ledger.setQueueStatus({ id, status });
    }
    const before = ledger.getQueueRow(id)!;
    expect(before.reviewed_at).toBe(status === "expired" ? null : "2026-11-18T10:00:00.000Z");
    vi.setSystemTime(new Date("2026-11-18T11:00:00Z"));
    expect((await queue.moveQueueRowRoute(req({ workspace: "other" }), params(id))).status).toBe(
      409,
    );
    expect(ledger.getQueueRow(id)).toMatchObject({
      status,
      reviewed_at: before.reviewed_at,
      decision: before.decision,
      decided_at: before.decided_at,
      decided_by: before.decided_by,
      decided_by_member: before.decided_by_member,
      decision_reason: before.decision_reason,
    });
  },
);

it("a failed overlapping move preserves the intervening approver's decision", async () => {
  const id = row();
  let release!: (response: Response) => void;
  const paused = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(() => {
        reached();
        return paused;
      })
      .mockResolvedValueOnce(Response.json({ error: "refused" }, { status: 409 })),
  );
  const first = queue.moveQueueRowRoute(req({ workspace: "other" }), params(id));
  await waiting;
  expect(
    (await queue.approveQueueRoute(req({ reason: "fit" }, "/api/queue", owner), params(id))).status,
  ).toBe(200);
  const approved = ledger.getQueueRow(id)!;
  expect((await queue.moveQueueRowRoute(req({ workspace: "other" }), params(id))).status).toBe(409);
  release(Response.json({ error: "refused" }, { status: 409 }));
  expect((await first).status).toBe(409);
  expect(ledger.getQueueRow(id)).toMatchObject({
    status: "approved",
    decision: approved.decision,
    decided_at: approved.decided_at,
    decided_by: approved.decided_by,
    decided_by_member: owner,
    decision_reason: "fit",
  });
});
it("send draft preserves another member's approval and draft editor", async () => {
  const id = row();
  ledger.setQueueStatus({ id, status: "approved", member: owner });
  expect((await queue.regenerateDraftRoute(req({}, "/api/queue", owner), params(id))).status).toBe(
    200,
  );
  expect(queue.toView(ledger.getQueueRow(id)!).lastDraft?.editedBy).toBe(owner);
  expect((await queue.sendDraftRoute(req({ confirmStale: true }), params(id))).status).toBe(200);
  expect(ledger.getQueueRow(id)).toMatchObject({
    status: "sent",
    decided_by: "human",
    decided_by_member: owner,
    sent_by_member: member,
  });
  const saved = ledger.getQueueRow(id)!;
  const view = queue.toView(saved);
  expect(view.lastDraft?.editedBy).toBe(owner);
  expect(memberDecision(view)).toBe(`Sent by ${member}`);
  expect(describeDecision(view)).toBe(`approved by ${owner}`);
  expect(
    buildProspectTimeline({
      rows: [saved],
      sequenceEvents: [],
      replies: [],
      channelEvents: [],
      outcomes: [],
    }).find((event) => event.kind === "decided")?.label,
  ).toBe(`approved by ${owner}`);
  expect((await queue.approveQueueRoute(req(), params(id))).status).toBe(409);
  expect(ledger.getQueueRow(id)).toMatchObject({
    decided_by_member: owner,
    sent_by_member: member,
  });
});
it("an unattended send shows no sender while retaining the approval member", () => {
  const id = row();
  ledger.approveAllPending({ member: owner });
  ledger.setQueueStatus({ id, status: "sent" });
  const view = queue.toView(ledger.getQueueRow(id)!);
  expect(view).toMatchObject({ decidedByMember: owner, sentByMember: null });
  expect(memberDecision(view)).toBeNull();
  expect(describeDecision(view)).toBe(`approved by ${owner} (bulk)`);
});
it("mark sent records the member once; a retry cannot replace the sender", async () => {
  const id = row(true);
  ledger.setQueueStatus({ id, status: "approved", member: owner });
  draft(id);
  expect((await queue.markSentRoute(req(), params(id))).status).toBe(200);
  expect((await queue.markSentRoute(req({}, "/api/queue", owner), params(id))).status).toBe(200);
  expect(ledger.getQueueRow(id)).toMatchObject({
    status: "sent",
    decided_by_member: owner,
    sent_by_member: member,
  });
  expect(ledger.listSequenceEventsForProspect(ledger.getQueueRow(id)!.prospect_id!)).toHaveLength(
    1,
  );
});
it("regenerate stamps the saved draft without changing its approver", async () => {
  const id = row(true);
  ledger.setQueueStatus({ id, status: "approved", member: owner });
  expect((await queue.regenerateDraftRoute(req(), params(id))).status).toBe(200);
  const saved = ledger.getQueueRow(id)!;
  expect(JSON.parse(saved.last_draft_json!)).toMatchObject({ editedBy: member });
  expect(saved.decided_by_member).toBe(owner);
});
it("queue and cadence offer edits retain the member and remain protected from machine rewriting", async () => {
  const id = row();
  expect((await queueOfferRoute(req({ offer: "Plan tomorrow's work." }), params(id))).status).toBe(
    200,
  );
  const offer = JSON.parse(ledger.getQueueRow(id)!.payload_json).offer;
  expect(offer.editedBy).toBe(member);
  expect(offerIsCurrent(offer, "changed-input")).toBe(true);
  expect(offerHoldsSend({ ...offer, relevance: "weak" })).toBe(false);
  const prospectId = ledger.upsertProspect({ email: `cadence${serial}@example.com`, name: "Ada" });
  ledger.enrollCadence({ prospectId, playName: "show-hn", nextDueAt: new Date().toISOString() });
  expect(
    (
      await cadenceOfferRoute(
        req({ offer: "Plan next week's work." }, "/api/cadence?play=show-hn"),
        params(prospectId),
      )
    ).status,
  ).toBe(200);
  expect(JSON.parse(ledger.getCadence(prospectId, "show-hn")!.offer_json!).offer.editedBy).toBe(
    member,
  );
});
it("code answer approval and dismissal store the requesting member", async () => {
  for (const action of ["approve", "dismiss"] as const) {
    const id = ledger.codeAnswers.capture({
      question: `${action}: how does the queue work?`,
      threadKey: action,
    })!.record.id;
    ledger.codeAnswers.recordDerive(id, {
      status: "pending",
      answer: "It holds drafts for review.",
      files: [],
      commit: "test-commit",
      promptVersion: "test",
      digest: "test",
    });
    const response =
      action === "approve"
        ? await answers.approveCodeAnswerRoute(req(), { id })
        : answers.dismissCodeAnswerRoute(req(), { id });
    expect(response.status).toBe(200);
    expect(read("SELECT decided_by FROM code_answers WHERE id = ?", id)).toEqual([
      { decided_by: member },
    ]);
  }
});
it("inbox autosave records the most recent editor", async () => {
  const body = {
    threadKey: "member-thread",
    inboundEmailId: "message",
    toEmail: "ada@example.com",
    subject: "Hi",
    body: "Thanks for asking.",
  };
  expect((await saveDraftRoute(req(body))).status).toBe(200);
  expect(read("SELECT edited_by FROM inbox_drafts WHERE thread_key = ?", body.threadKey)).toEqual([
    { edited_by: member },
  ]);
  expect((await saveDraftRoute(req(body, "/api/inbox", owner))).status).toBe(200);
  expect(read("SELECT edited_by FROM inbox_drafts WHERE thread_key = ?", body.threadKey)).toEqual([
    { edited_by: owner },
  ]);
});
it("setup and each play config save append member, section and time; invalid saves append nothing", async () => {
  const start = new Date().toISOString();
  expect((await setup(req({ founderName: "Mia" }))).status).toBe(200);
  const play = "new-business";
  const days = defaultSequence(play)!.steps.map((_, i) => i + 1);
  for (const body of [{ directMail: null }, { days }, { days: null }]) {
    expect((await setCadenceRoute(req(body), { name: play })).status).toBe(200);
  }
  const audit = read("SELECT member, section, changed_at FROM config_changes ORDER BY id");
  expect(audit.map((r) => [r.member, r.section])).toEqual([
    [member, "setup"],
    [member, "plays.new-business.directMail"],
    [member, "plays.new-business.cadence"],
    [member, "plays.new-business.cadence"],
  ]);
  expect(
    audit.every(
      (r) => String(r.changed_at) >= start && String(r.changed_at) <= new Date().toISOString(),
    ),
  ).toBe(true);
  expect((await setCadenceRoute(req({ days: [-1] }), { name: play })).status).toBe(400);
  expect(read("SELECT id FROM config_changes")).toHaveLength(4);
});
