import { beforeEach, expect, it, vi } from "vitest";
import type {
  LearningGuidanceResult,
  LearningProposalsResult,
  ReplyDraftSet,
  ReplyLearningStatus,
} from "@oneshot-gtm/shared-types";

// A rule learned from replies is every member's; the LinkedIn messages it
// was learned from are not (#1040). Two members reply on their own accounts
// through the routes, the learning job turns those sends into one rule, and
// each route that returns learning evidence is read as each member.

const sdk = vi.fn();
const complete = vi.fn();
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: (...args: unknown[]) => sdk(...args),
}));
// A confirmed send starts a sync in the background: not part of this test.
vi.mock("../src/linkedin-sync.ts", () => ({ refreshLinkedInInbox: async () => {} }));
vi.mock("../src/api/inbox.ts", () => ({
  listInboxRoute: async () => Response.json({ replies: [], conversations: [], hasMore: false }),
  draftReplyRoute: vi.fn(),
  saveDraftRoute: vi.fn(),
  steerRoute: vi.fn(),
  archiveInboxConversationRoute: vi.fn(),
  sendReplyRoute: vi.fn(),
}));
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  oneshotEnvReady: () => true,
  linkedInMatches: () => [],
  currentWorkspaceName: () => "default",
  tryReserveDailySpend: () => ({ granted: true, release: () => {} }),
}));
const { getLedger, getLinkedInInboxStore, getReplyReviewStore, getSharedDb } =
  await import("@oneshot-gtm/core");
const { collectReplies } = await import("../src/api/replies-view.ts");
const { replyDraftSaveRoute, replyLearningRoute, replySendRoute } =
  await import("../src/api/replies.ts");
const { approveLearningProposalRoute, listLearningGuidanceRoute, listLearningProposalsRoute } =
  await import("../src/api/learning.ts");
const { refreshReplyLearning } = await import("../src/reply-learning.ts");

const TAILNET = "gtm-host.tail1234.ts.net";
const OWNER = "olive@example.com";
const MIA = "mia@example.com";
const RULE = "Open with a plain thank-you.";
/** A request made on the host machine. */
const local = { host: "127.0.0.1:3030" };
/** What `tailscale serve` puts in front of the server for a signed-in member. */
const as = (login: string): Record<string, string> => ({
  host: `${TAILNET}:3030`,
  "x-forwarded-host": `${TAILNET}:3030`,
  "x-forwarded-for": "100.64.0.7",
  "tailscale-user-login": login,
  origin: `https://${TAILNET}:3030`,
});
const get = (headers: Record<string, string>, path: string) =>
  new Request(`http://127.0.0.1:3030${path}`, { headers });
const post = (headers: Record<string, string>, body: unknown) =>
  new Request("http://127.0.0.1:3030/api/replies", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const store = getLinkedInInboxStore();
const review = getReplyReviewStore();
const ledger = getLedger();
const ldb = (ledger as unknown as { db: { exec: (sql: string) => void } }).db;

function seedAccount(id: string, ownerMember: string, conversations: number): void {
  const key = `wallet:${id}`;
  store.saveAccount({
    key,
    wallet: "wallet",
    workspace: "default",
    account: {
      id,
      display_name: `${id} account`,
      status: "connected",
      allowed_actions: ["read", "reply"],
    } as never,
    sync: null,
    checkedAt: null,
    error: null,
    ownerMember,
  });
  for (let n = 1; n <= conversations; n++) {
    const chat = `${id}-chat-${n}`;
    store.saveConversation(
      key,
      {
        id: chat,
        attendees: [{ is_self: false, provider_id: `${id}-peer-${n}`, name: `${id} contact ${n}` }],
        attendees_synced: true,
        type: 0,
      } as never,
      [],
    );
    store.saveMessages(key, [
      {
        id: `${id}-message-${n}`,
        conversation_id: chat,
        direction: "inbound",
        sender_provider_id: `${id}-peer-${n}`,
        sender_name: `${id} contact ${n}`,
        text: `A question for ${id}, number ${n}?`,
        sent_at: "2026-11-01T10:00:00Z",
        attachments: [],
      },
    ] as never);
    // Learning reads sends in a workspace: the conversation is a prospect's.
    const prospectId = ledger.upsertProspect({
      email: `${id}-${n}@prospect.example`,
      name: `${id} contact ${n}`,
    });
    store.assign(`linkedin:${key}:${chat}`, { workspace: "default", prospectId });
  }
}

/** The member opens Replies, edits the suggested reply and sends it: all through the routes. */
async function sendReply(member: string, id: string, n: number): Promise<string> {
  const headers = as(member);
  const key = `linkedin:wallet:${id}:${id}-chat-${n}`;
  await collectReplies(get(headers, "/api/replies"));
  const t = review.get(key)!;
  const drafts: ReplyDraftSet = {
    id: `generation-${id}-${n}`,
    revision: 0,
    contextVersion: t.contextVersion,
    read: "",
    originals: { direct: `Suggested to ${id}, number ${n}`, technical: "", warm: "" },
    edits: { direct: `Sent by ${id}, number ${n}`, technical: "", warm: "" },
    moves: {},
    flags: { direct: [], technical: [], warm: [] },
    setFlags: [],
    selected: "direct",
    steer: "",
    generated: true,
  };
  // What the generate route records once the model has written the options.
  review.learning.recordGeneration(t, drafts, {});
  const saved = await replyDraftSaveRoute(post(headers, { key, drafts, expectedRevision: null }));
  expect(saved.status).toBe(200);
  const sendId = `send-${id}-${n}-0123456789`;
  const sent = await replySendRoute(post(headers, { key, sendId, revision: 1 }));
  expect(await sent.json()).toMatchObject({ status: "sent" });
  return sendId;
}

/** Everything a response says, as the browser receives it. */
const read = async <T>(res: Response): Promise<{ body: T; text: string }> => {
  expect(res.status).toBe(200);
  const text = await res.text();
  return { body: JSON.parse(text) as T, text };
};
const proposals = async (headers: Record<string, string>) =>
  read<LearningProposalsResult>(
    listLearningProposalsRoute(get(headers, "/api/learning/proposals?status=all")),
  );
const guidance = async (headers: Record<string, string>) =>
  read<LearningGuidanceResult>(listLearningGuidanceRoute(get(headers, "/api/learning/guidance")));
const preferences = async (headers: Record<string, string>) =>
  read<ReplyLearningStatus>(await replyLearningRoute(get(headers, "/api/replies/learning")));

let sendIds: string[];
beforeEach(async () => {
  store.db.exec(
    "DELETE FROM accounts;DELETE FROM conversations;DELETE FROM messages;DELETE FROM progress;DELETE FROM identities;DELETE FROM assignments;",
  );
  for (const table of [
    "review_threads",
    "review_sends",
    "review_leases",
    "reply_learning_state",
    "reply_learning_preferences",
    "reply_learning_observations",
    "reply_learning_artifacts",
  ])
    review.db.exec(`DELETE FROM ${table}`);
  for (const table of [
    "learning_proposals",
    "learning_guidance",
    "learning_jobs",
    "learning_state",
    "channel_events",
  ])
    ldb.exec(`DELETE FROM ${table}`);
  const db = getSharedDb();
  for (const m of db.listMembers()) db.removeMember(m.email);
  for (const host of db.allowedHosts()) db.disallowHost(host);
  db.addMember({ email: OWNER, name: "Olive Owner", role: "owner" });
  db.addMember({ email: MIA, name: "Mia Member", role: "member" });
  db.allowHost(TAILNET);
  sdk.mockReset().mockImplementation(async (_workspace, op) => {
    if (op.kind === "reply") return { status: "sent", sent_at: new Date().toISOString() };
    throw new Error(`Unexpected operation ${op.kind}`);
  });

  seedAccount("olive", OWNER, 3);
  seedAccount("mia", MIA, 2);
  // The rule's five examples, in the order the job cites them.
  sendIds = [
    await sendReply(OWNER, "olive", 1),
    await sendReply(MIA, "mia", 1),
    await sendReply(OWNER, "olive", 2),
    await sendReply(MIA, "mia", 2),
    await sendReply(OWNER, "olive", 3),
  ];
  complete.mockReset().mockResolvedValue({
    content: JSON.stringify({
      preferences: [
        { key: "plain-thanks", instruction: RULE, source: "style", evidenceIds: sendIds },
      ],
    }),
  });
  // The scheduler's job: no request, no viewer, every account's sends.
  await refreshReplyLearning();
});

const OLIVE_PRIVATE = ["Sent by olive", "Suggested to olive", "olive contact"];
const MIA_PRIVATE = ["Sent by mia", "Suggested to mia", "mia contact"];

it("shares a learned rule with every member, each with only their own account's messages", async () => {
  // Waiting for review: both members read the same rule, summary and counts.
  for (const [member, mine, theirs, hidden] of [
    [MIA, ["Sent by mia, number 1", "Sent by mia, number 2"], OLIVE_PRIVATE, 3],
    [
      OWNER,
      ["Sent by olive, number 1", "Sent by olive, number 2", "Sent by olive, number 3"],
      MIA_PRIVATE,
      2,
    ],
  ] as const) {
    const { body, text } = await proposals(as(member));
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      kind: "preference",
      status: "pending",
      scope: { channel: "linkedin", stage: "reply" },
      proposed: { instruction: RULE, source: "style" },
      evidenceSummary: "A consistent pattern across 5 LinkedIn replies.",
      evidence: { counts: { threads: 5 }, withheld: hidden },
    });
    expect(body.proposals[0]!.evidence.refs).toHaveLength(5);
    expect(body.proposals[0]!.evidence.samples!.map((s) => s.sent)).toEqual(mine);
    for (const secret of theirs) expect(text).not.toContain(secret);
  }

  // The owner approves it; the answer is theirs to read, like the list.
  const id = (await proposals(as(OWNER))).body.proposals[0]!.id;
  const approved = await read<{ proposal: { evidence: { withheld?: number } } }>(
    await approveLearningProposalRoute(post(as(OWNER), {}), { id }),
  );
  expect(approved.body.proposal.evidence.withheld).toBe(2);
  for (const secret of MIA_PRIVATE) expect(approved.text).not.toContain(secret);

  // Applied: the rule reaches every member's drafts, and every reader of it.
  expect(
    ledger.learning
      .guidance({ channel: "linkedin", stage: "reply" })
      .instructions.map((i) => i.instruction),
  ).toEqual([RULE]);
  for (const [member, theirs, shown] of [
    [MIA, OLIVE_PRIVATE, 2],
    [OWNER, MIA_PRIVATE, 3],
  ] as const) {
    const rules = await guidance(as(member));
    expect(rules.body.guidance).toHaveLength(1);
    expect(rules.body.guidance[0]).toMatchObject({ instruction: RULE, status: "enabled" });
    expect(rules.body.guidance[0]!.evidence.samples).toHaveLength(shown);
    expect(rules.body.guidance[0]!.evidence.withheld).toBe(5 - shown);

    const prefs = await preferences(as(member));
    expect(prefs.body.preferences).toHaveLength(1);
    expect(prefs.body.preferences[0]).toMatchObject({ instruction: RULE, enabled: true });
    expect(prefs.body.preferences[0]!.evidence).toHaveLength(shown);

    const decided = await proposals(as(member));
    expect(decided.body.proposals[0]).toMatchObject({ status: "approved" });
    for (const secret of theirs)
      for (const text of [rules.text, prefs.text, decided.text]) expect(text).not.toContain(secret);
  }
  // What each member does read is their own: the reply, the suggestion, the name.
  const mine = (await preferences(as(MIA))).body.preferences[0]!.evidence;
  expect(mine[0]).toMatchObject({
    name: "mia contact 1",
    body: "Sent by mia, number 1",
    original: "Suggested to mia, number 1",
  });
});

it("leaves out a LinkedIn message whose account cannot be told, and keeps email", async () => {
  // The send behind one of Mia's examples is no longer on record.
  review.db.query("DELETE FROM reply_learning_observations WHERE id=?").run(sendIds[1] as string);
  const replies = (await proposals(as(MIA))).body.proposals[0]!.evidence;
  expect(replies.samples!.map((s) => s.sent)).toEqual(["Sent by mia, number 2"]);
  expect(replies.withheld).toBe(4);

  // Learned from outreach drafts: a draft names no account, a mailbox is everyone's.
  ledger.learning.insert({
    kind: "preference",
    scope: { channel: "linkedin", stage: "first_touch" },
    current: null,
    proposed: { instruction: "Keep first touches short.", source: "style" },
    evidence: {
      refs: [
        { type: "draft_version", id: 1 },
        { type: "draft_version", id: 2 },
      ],
      samples: [
        { sent: "A LinkedIn first touch", channel: "linkedin", stage: "first_touch" },
        { sent: "An email first touch", channel: "email", stage: "first_touch" },
      ],
    },
    evidenceSummary: "What you sent across 5 LinkedIn first touches.",
    baselineKey: "",
    dedupeKey: "linkedin:first_touch:keep first touches short",
  });
  for (const member of [MIA, OWNER]) {
    const { body, text } = await proposals(as(member));
    const drafts = body.proposals.find((p) => p.scope.stage === "first_touch")!;
    expect(drafts.proposed).toMatchObject({ instruction: "Keep first touches short." });
    expect(drafts.evidence.samples).toEqual([
      { sent: "An email first touch", channel: "email", stage: "first_touch" },
    ]);
    expect(drafts.evidence.withheld).toBe(1);
    expect(text).not.toContain("A LinkedIn first touch");
  }
});

it("shows a prospect's LinkedIn reply behind an angle only to the member whose account received it", async () => {
  const prospectId = ledger.upsertProspect({ email: "pat@prospect.example", name: "Pat" });
  const at = "2026-11-02T09:00:00.000Z";
  // What the sync records on the prospect when a matched reply arrives on Mia's account.
  ledger.recordLinkedInReply({
    prospectId,
    accountKey: "wallet:mia",
    source: "oneshot-linkedin",
    externalEventId: "wallet:mia:pat-message",
    occurredAt: at,
    body: "We already use a competitor for this.",
  });
  ledger.learning.insert({
    kind: "prospect_angle",
    scope: { prospectId },
    current: { angleJson: null, approvedAt: null },
    proposed: { hook: "Lead with the migration path." },
    evidence: {
      refs: [],
      samples: [
        { at, label: "Reply · (linkedin reply)", text: "We already use a competitor for this." },
        { at, label: "Reply · Re: pricing", text: "An email reply about pricing." },
      ],
    },
    evidenceSummary: "Re-synthesized after a reply.",
    baselineKey: "",
    dedupeKey: `${prospectId}:migration`,
  });
  const angle = async (member: string) => {
    const { body, text } = await proposals(as(member));
    return { text, evidence: body.proposals.find((p) => p.kind === "prospect_angle")!.evidence };
  };
  const mia = await angle(MIA);
  expect(mia.evidence.samples).toHaveLength(2);
  expect(mia.evidence.withheld).toBeUndefined();

  const olive = await angle(OWNER);
  expect(olive.evidence.samples!.map((s) => s.text)).toEqual(["An email reply about pricing."]);
  expect(olive.evidence.withheld).toBe(1);
  expect(olive.text).not.toContain("We already use a competitor");
});

it("is unchanged on a single-user install: the host machine reads every example", async () => {
  const db = getSharedDb();
  for (const m of db.listMembers()) db.removeMember(m.email);
  const { body } = await proposals(local);
  expect(body.proposals[0]!.evidence.samples!.map((s) => s.sent)).toEqual([
    "Sent by olive, number 1",
    "Sent by mia, number 1",
    "Sent by olive, number 2",
    "Sent by mia, number 2",
    "Sent by olive, number 3",
  ]);
  expect(body.proposals[0]!.evidence.withheld).toBeUndefined();
});
