import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import { computeLinkedInFunnel, mergeLinkedInReplies } from "../src/linkedin-funnel.ts";

// The LinkedIn funnel (#792) over a fixture ledger with invites in every
// state. The ledger is real; the synced inbox is a stub conversation lookup.

const NOW = new Date("2026-10-13T12:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number, extraHours = 0): string =>
  new Date(NOW.getTime() - daysAgo * DAY + extraHours * 3_600_000).toISOString();
const sqlite = (iso: string): string => iso.slice(0, 19).replace("T", " ");

let dir: string;
let dbPath: string;
let ledger: Ledger;
let conversations: Map<number, string>;

const LUMA = "luma-events";
const REPO = "repo-interest";

function person(name: string): number {
  return ledger.upsertProspect({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`,
    linkedin_url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, "-")}`,
  });
}

function stamp(table: "sequence_events", id: number, iso: string): void {
  const db = new Database(dbPath);
  db.query(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(sqlite(iso), id);
  db.close();
}

function invite(
  prospectId: number,
  playName: string,
  sentIso: string,
  metadata: Record<string, unknown> = {},
  stepIndex = 0,
): number {
  const id = ledger.recordLinkedInInviteEvent({
    prospectId,
    playName,
    stepIndex,
    status: "sent",
    metadata: { invitationId: `inv-${prospectId}`, ...metadata },
  });
  stamp("sequence_events", id, sentIso);
  return id;
}

function withdraw(
  prospectId: number,
  playName: string,
  iso: string,
  withdrawnBy?: string,
  stepIndex = 0,
): void {
  const id = ledger.recordLinkedInInviteEvent({
    prospectId,
    playName,
    stepIndex,
    status: "withdrawn",
    metadata: { withdrawStatus: "withdrawn", ...(withdrawnBy ? { withdrawnBy } : {}) },
  });
  stamp("sequence_events", id, iso);
}

function message(
  prospectId: number,
  playName: string,
  stepIndex: number,
  iso: string,
  metadata: Record<string, unknown> = {},
): void {
  const id = ledger.recordSequenceEvent({
    prospectId,
    playName,
    stepIndex,
    channel: "linkedin",
    status: "sent",
    metadata: { body: "hello", ...metadata },
  });
  stamp("sequence_events", id, iso);
}

function reply(
  prospectId: number,
  source: string,
  externalEventId: string,
  iso: string,
  body: string,
): void {
  ledger.recordLinkedInReply({ prospectId, source, externalEventId, occurredAt: iso, body });
}

const compute = (
  filters: Parameters<typeof computeLinkedInFunnel>[0]["filters"] = {},
): ReturnType<typeof computeLinkedInFunnel> =>
  computeLinkedInFunnel({
    source: ledger.readLinkedInFunnelSource(),
    workspace: "alpha",
    now: NOW,
    filters,
    conversationFor: ({ prospectId }) => conversations.get(prospectId) ?? null,
  });

// A  accepted by invitation (2d), evidence, first message d-8, close d-2, one reply recorded by two sources between them
// B  accepted by a synced conversation, no evidence, first message and a close, reply only after the close
// C  pending, evidence, sent 5 days ago
// D  withdrawn by the timeout, sent before the clause was recorded
// E  withdrawn by hand, no evidence, sent 40 days ago
// F  continuation invite (step 3, another play), accepted by invitation (4d), evidence
// G  never sent (not_sent): not an invite
// H  already connected, sent before the clause was recorded
let ids: Record<string, number>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "linkedin-funnel-"));
  dbPath = join(dir, "ledger.sqlite");
  ledger = new Ledger(dbPath);
  conversations = new Map();
  ids = {
    A: person("Ada Fixture"),
    B: person("Ben Fixture"),
    C: person("Cy Fixture"),
    D: person("Di Fixture"),
    E: person("Eli Fixture"),
    F: person("Fay Fixture"),
    G: person("Gus Fixture"),
    H: person("Hal Fixture"),
  };

  invite(ids.A!, LUMA, at(10), {
    evidenceClause: true,
    acceptedAt: at(8),
    invitationStatus: "accepted",
  });
  message(ids.A!, LUMA, 1, at(8, 2));
  message(ids.A!, LUMA, 2, at(2));
  reply(ids.A!, "oneshot-linkedin", "acct:m1", at(7), "Sounds interesting, tell me more");
  reply(ids.A!, "older-capture", "legacy-1", at(7, 0.01), "Sounds interesting, tell me more");

  invite(ids.B!, LUMA, at(12), { evidenceClause: false });
  conversations.set(ids.B!, "conv-b");
  message(ids.B!, LUMA, 1, at(10));
  message(ids.B!, LUMA, 2, at(5), { conversationId: "conv-b" });
  reply(ids.B!, "oneshot-linkedin", "acct:m2", at(3), "Sorry, only just saw this");

  invite(ids.C!, LUMA, at(5), { evidenceClause: true });

  invite(ids.D!, LUMA, at(25));
  withdraw(ids.D!, LUMA, at(4), "timeout");

  invite(ids.E!, LUMA, at(40), { evidenceClause: false });
  withdraw(ids.E!, LUMA, at(30), "manual");

  ledger.recordSequenceEvent({
    prospectId: ids.F!,
    playName: REPO,
    stepIndex: 0,
    channel: "email",
    status: "sent",
    metadata: { subject: "hi", body: "hi" },
  });
  invite(ids.F!, REPO, at(9), { evidenceClause: true, acceptedAt: at(5) }, 3);

  const failed = invite(ids.G!, LUMA, at(6), { evidenceClause: true });
  ledger.updateLinkedInInviteEvent({
    id: failed,
    status: "failed",
    metadata: { failureReason: "not_sent" },
  });

  invite(ids.H!, LUMA, at(15), { inviteStatus: "already_connected" });
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("LinkedIn funnel", () => {
  it("counts invites in every state, once per person", () => {
    const f = compute().view.funnel;
    expect(f.invitesSent).toBe(7); // A B C D E F H; G never went out
    expect(f.pending).toBe(1); // C
    expect(f.withdrawn).toEqual({ total: 2, timeout: 1, manual: 1, unknown: 0 });
    expect(f.accepted.total).toBe(3); // A, F by invitation; B by conversation
    expect(f.accepted.viaInvitation).toBe(2);
    expect(f.accepted.viaConversation).toBe(1);
    expect(f.accepted.rate).toBeCloseTo(3 / 7);
    expect(f.alreadyConnected).toBe(1);
  });

  it("reports the median days to accept over the accepts whose time is known", () => {
    const f = compute().view.funnel;
    // A: 2 days, F: 4 days; B's accept has no time and is left out.
    expect(f.accepted.medianDaysToAccept).toBe(3);
    expect(f.accepted.daysKnown).toBe(2);
  });

  it("counts a reply before the next step as replied to the first message, and one after it only at any point", () => {
    const f = compute().view.funnel;
    expect(f.firstMessageSent).toBe(2); // A, B
    // A replied between its first message and its close; B only after the close.
    expect(f.repliedToFirstMessage).toEqual({ count: 1, of: 2, rate: 0.5 });
    // Both replied at some point, over the 7 invites sent.
    expect(f.repliedAtAnyPoint.count).toBe(2);
    expect(f.repliedAtAnyPoint.of).toBe(7);
    expect(f.repliedAtAnyPoint.rate).toBeCloseTo(2 / 7);
  });

  it("counts a reply with no next step sent as a reply to the first message", () => {
    message(ids.C!, LUMA, 1, at(3));
    reply(ids.C!, "oneshot-linkedin", "acct:m3", at(1), "Yes, happy to chat");
    const f = compute().view.funnel;
    expect(f.firstMessageSent).toBe(3);
    expect(f.repliedToFirstMessage.count).toBe(2); // A and C
  });

  it("counts a reply recorded by two sources once", () => {
    const f = compute().view.funnel;
    // A's reply sits in the ledger twice (the older capture and GTM's sync).
    expect(ledger.listChannelEventsForProspect(ids.A!)).toHaveLength(2);
    expect(f.repliedAtAnyPoint.count).toBe(2);
    expect(f.repliesMerged).toBe(1);
  });

  it("does not count a reply that arrived before the first message", () => {
    reply(ids.C!, "oneshot-linkedin", "acct:m4", at(4), "Hi, thanks for the connection");
    message(ids.C!, LUMA, 1, at(3));
    const f = compute().view.funnel;
    expect(f.repliedToFirstMessage.count).toBe(1); // still only A
    expect(f.repliedAtAnyPoint.count).toBe(3); // A, B, and C's early reply
  });

  it("splits the funnel by whether the note carried an evidence clause", () => {
    const { variants } = compute().view;
    // Recorded at send time: A, C, F with; B, E without; D, H predate the field.
    expect(variants.withEvidence.invitesSent).toBe(3);
    expect(variants.withEvidence.accepted.total).toBe(2);
    expect(variants.withEvidence.firstMessageSent).toBe(1);
    expect(variants.withEvidence.repliedToFirstMessage).toEqual({ count: 1, of: 1, rate: 1 });
    expect(variants.withoutEvidence.invitesSent).toBe(2);
    expect(variants.withoutEvidence.withdrawn.manual).toBe(1);
    expect(variants.withoutEvidence.accepted.viaConversation).toBe(1);
    expect(variants.withoutEvidence.repliedToFirstMessage).toEqual({ count: 0, of: 1, rate: 0 });
    expect(variants.unrecorded.invitesSent).toBe(2);
    expect(variants.unrecorded.alreadyConnected).toBe(1);
    expect(variants.unrecorded.withdrawn.timeout).toBe(1);
    const parts = [variants.withEvidence, variants.withoutEvidence, variants.unrecorded];
    expect(parts.reduce((n, v) => n + v.invitesSent, 0)).toBe(compute().view.funnel.invitesSent);
  });

  it("filters by step kind", () => {
    const first = compute({ stepKind: "first-touch" }).view;
    const continuation = compute({ stepKind: "continuation" }).view;
    expect(first.funnel.invitesSent).toBe(6);
    expect(continuation.funnel.invitesSent).toBe(1); // F, invited at step 3
    expect(continuation.funnel.accepted.total).toBe(1);
    expect(continuation.funnel.accepted.medianDaysToAccept).toBe(4);
    expect(continuation.filters.stepKind).toBe("continuation");
  });

  it("filters by play and lists the plays", () => {
    const view = compute({ play: REPO }).view;
    expect(view.funnel.invitesSent).toBe(1);
    expect(view.plays).toEqual([LUMA, REPO]);
  });

  it("filters by how recently the invite was sent", () => {
    const f = compute({ sinceDays: 30 }).view.funnel;
    expect(f.invitesSent).toBe(6); // E went out 40 days ago
    expect(f.withdrawn.manual).toBe(0);
  });

  it("counts a person once per row when they were invited again", () => {
    withdraw(ids.C!, LUMA, at(3), "manual");
    invite(ids.C!, LUMA, at(1), { evidenceClause: false });
    const view = compute().view;
    expect(view.funnel.invitesSent).toBe(7); // C is still one person
    expect(view.funnel.pending).toBe(1);
    expect(view.funnel.withdrawn.total).toBe(2); // D and E; C's newest invite is pending
  });

  it("reads rates over a zero denominator as null, not zero", () => {
    const view = computeLinkedInFunnel({
      source: { events: [], prospects: [], replies: [] },
      workspace: "alpha",
      now: NOW,
      conversationFor: () => null,
    }).view;
    expect(view.funnel.invitesSent).toBe(0);
    expect(view.funnel.repliedToFirstMessage).toEqual({ count: 0, of: 0, rate: null });
    expect(view.funnel.accepted.rate).toBeNull();
    expect(view.funnel.accepted.medianDaysToAccept).toBeNull();
  });

  it("is read-only over the ledger", () => {
    const before = ledger.readLinkedInFunnelSource();
    compute();
    compute({ play: LUMA, stepKind: "first-touch", sinceDays: 30 });
    expect(ledger.readLinkedInFunnelSource()).toEqual(before);
  });
});

describe("invite listing rows", () => {
  const byName = (name: string) => compute().rows.find((r) => r.prospect === name)!;

  it("has one row per invite sent with the detected state", () => {
    const { rows } = compute();
    expect(rows).toHaveLength(7);
    expect(byName("Ada Fixture")).toMatchObject({
      state: "accepted",
      acceptedVia: "invitation",
      stepKind: "first-touch",
      stepIndex: 0,
      daysPending: null,
      evidence: "with",
      playName: LUMA,
    });
    expect(byName("Ben Fixture")).toMatchObject({
      state: "accepted",
      acceptedVia: "conversation",
      conversationId: "conv-b",
      evidence: "without",
    });
    expect(byName("Cy Fixture")).toMatchObject({
      state: "pending",
      daysPending: 5,
      acceptedVia: null,
    });
    expect(byName("Di Fixture")).toMatchObject({ state: "withdrawn", withdrawnBy: "timeout" });
    expect(byName("Eli Fixture")).toMatchObject({ state: "withdrawn", withdrawnBy: "manual" });
    expect(byName("Fay Fixture")).toMatchObject({
      state: "accepted",
      stepKind: "continuation",
      stepIndex: 3,
      playName: REPO,
    });
    expect(byName("Hal Fixture")).toMatchObject({ state: "already_connected" });
    expect(rows.map((r) => r.prospect)).not.toContain("Gus Fixture");
  });

  it("carries the profile, the send time and the conversation a message went into", () => {
    const ben = byName("Ben Fixture");
    expect(ben.profile).toBe("https://www.linkedin.com/in/ben-fixture");
    expect(ben.sentAt).toBe(at(12).slice(0, 19) + ".000Z");
    conversations.clear();
    // The message step stored where it went, so the conversation id survives
    // the inbox losing track of it, and a sent message still means accepted.
    expect(byName("Ben Fixture")).toMatchObject({
      conversationId: "conv-b",
      state: "accepted",
      acceptedVia: "conversation",
    });
  });

  it("reads a sent first message as accepted even with no conversation known", () => {
    message(ids.C!, LUMA, 1, at(1));
    expect(byName("Cy Fixture")).toMatchObject({
      state: "accepted",
      acceptedVia: "conversation",
      conversationId: null,
    });
    const f = compute().view.funnel;
    expect(f.firstMessageSent).toBeLessThanOrEqual(f.accepted.total);
  });

  it("lists newest first", () => {
    const sent = compute().rows.map((r) => Date.parse(r.sentAt));
    expect(sent).toEqual(sent.toSorted((a, b) => b - a));
  });

  it("reads a withdrawal recorded before the reason was as unrecorded", () => {
    withdraw(ids.C!, LUMA, at(1));
    expect(byName("Cy Fixture")).toMatchObject({ state: "withdrawn", withdrawnBy: "unknown" });
  });
});

const row = (source: string, occurred_at: string, body: string | null, id = 1) => ({
  id,
  prospect_id: 1,
  source,
  occurred_at,
  body,
});

describe("mergeLinkedInReplies", () => {
  it("merges the same text from two sources even when the times differ", () => {
    const out = mergeLinkedInReplies([
      row("oneshot-linkedin", "2026-10-01T10:00:00Z", "Thanks!  Let's talk"),
      row("older-capture", "2026-10-01T13:30:00Z", "thanks! let's   talk", 2),
    ]);
    expect(out.replies).toHaveLength(1);
    expect(out.merged).toBe(1);
  });

  it("merges different text from two sources within a minute", () => {
    const out = mergeLinkedInReplies([
      row("oneshot-linkedin", "2026-10-01T10:00:00Z", "Sounds good"),
      row("older-capture", "2026-10-01T10:00:40Z", null, 2),
    ]);
    expect(out.replies).toHaveLength(1);
  });

  it("keeps different text from two sources more than a minute apart", () => {
    const out = mergeLinkedInReplies([
      row("oneshot-linkedin", "2026-10-01T10:00:00Z", "Sounds good"),
      row("older-capture", "2026-10-01T10:05:00Z", "One more thing", 2),
    ]);
    expect(out.replies).toHaveLength(2);
    expect(out.merged).toBe(0);
  });

  it("never merges two replies from the same source", () => {
    const out = mergeLinkedInReplies([
      row("oneshot-linkedin", "2026-10-01T10:00:00Z", "ok"),
      row("oneshot-linkedin", "2026-10-01T10:00:10Z", "ok", 2),
    ]);
    expect(out.replies).toHaveLength(2);
  });
});

describe("friend invites (#791)", () => {
  const FRIEND = "linkedin:friend";

  it("are their own funnel and stay out of the cold one", () => {
    const before = compute().view;
    const f = person("Gil Fixture");
    invite(f, FRIEND, at(6), { acceptedAt: at(5), invitationStatus: "accepted" }, 1);
    const after = compute().view;
    expect(after.friend.invitesSent).toBe(1);
    expect(after.friend.accepted.total).toBe(1);
    expect(after.funnel).toEqual(before.funnel);
    expect(after.variants).toEqual(before.variants);
  });

  it("is labelled friend in the listing, never first-touch or continuation", () => {
    const f = person("Hue Fixture");
    invite(f, FRIEND, at(3), {}, 1);
    const row = compute().rows.find((r) => r.prospectId === f)!;
    expect(row).toMatchObject({ stepKind: "friend", playName: FRIEND, stepIndex: 1 });
    expect(compute({ stepKind: "first-touch" }).rows.some((r) => r.prospectId === f)).toBe(false);
    expect(compute({ stepKind: "continuation" }).rows.some((r) => r.prospectId === f)).toBe(false);
  });

  it("the friend filter shows only friend invites, in the main funnel too", () => {
    const f = person("Ivy Fixture");
    invite(f, FRIEND, at(2), {}, 1);
    const view = compute({ stepKind: "friend" }).view;
    expect(view.friend.invitesSent).toBe(1);
    expect(view.funnel.invitesSent).toBe(1);
    expect(view.filters.stepKind).toBe("friend");
  });

  it("tracks a withdrawn friend invite", () => {
    const f = person("Jo Fixture");
    invite(f, FRIEND, at(30), {}, 1);
    withdraw(f, FRIEND, at(9), "timeout", 1);
    const view = compute().view;
    expect(view.friend.withdrawn).toEqual({ total: 1, timeout: 1, manual: 0, unknown: 0 });
  });
});
