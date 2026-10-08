import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ReplyReviewStore } from "../src/reply-review-store.ts";
import type { PreferenceCandidate } from "../src/reply-learning-store.ts";
import type { ReplyDraftSet, ReplyThread, ReplySendState } from "@oneshot-gtm/shared-types";

let store: ReplyReviewStore;
let path: string;
const now = 2_000_000_000_000;
const draft = (id: string): ReplyDraftSet => ({
  id,
  revision: 0,
  contextVersion: "ctx",
  read: "Early exchange",
  generated: true,
  originals: { direct: "Want to book a meeting?", technical: "How?", warm: "Hello" },
  edits: { direct: "How are you approaching it?", technical: "How?", warm: "Hello" },
  moves: { direct: "ask" },
  selected: "direct",
  steer: "",
  flags: { direct: [], technical: [], warm: [] },
  setFlags: [],
  learningVersion: 7,
});
function thread(
  key: string,
  workspace = "default",
  channel: "linkedin" | "email" = "linkedin",
): ReplyThread {
  return {
    key,
    channel,
    workspace,
    prospectId: 1,
    name: "Ada",
    address: "",
    company: null,
    subject: "",
    messages: [],
    lastActivityAt: new Date(now).toISOString(),
    archivedAt: null,
    snoozedUntil: null,
    needsReply: true,
    canSend: true,
    canGenerate: true,
    contextVersion: "ctx",
    drafts: null,
    send: null,
    accountKey: "account",
  };
}
function prepare(key: string, workspace = "default", channel: "linkedin" | "email" = "linkedin") {
  const t = thread(key, workspace, channel);
  store.upsert("scope", t);
  const d = draft(randomUUID());
  store.learning.recordGeneration(t, d, { thread: [], founderVoice: "plain" });
  store.saveDrafts(key, d, null);
  return store.get(key)!;
}
function sent(t: ReplyThread, status: ReplySendState["status"] = "sent") {
  const s: ReplySendState = {
    id: randomUUID(),
    status: "pending",
    body: t.drafts!.edits.direct,
    variant: "direct",
    generationId: t.drafts!.id,
  };
  store.beginSend(t.key, s, t.drafts!.revision);
  const confirmed = {
    ...s,
    status,
    sentAt: status === "sent" ? new Date(now).toISOString() : undefined,
  };
  store.updateSend(t.key, confirmed);
  return confirmed;
}
function candidate(
  ids: string[],
  source: PreferenceCandidate["source"] = "edits",
  key = "early-pressure",
): PreferenceCandidate {
  return {
    key,
    instruction: "In early conversations, ask about their approach before suggesting a meeting.",
    source,
    evidenceIds: ids,
  };
}
beforeEach(() => {
  path = join(process.env.ONESHOT_GTM_HOME!, randomUUID() + ".sqlite");
  store = new ReplyReviewStore(path);
});
afterEach(() => store.close());

describe("durable reply learning evidence", () => {
  it("preserves originals through replacement, restart, delayed confirmation and duplicate polling", () => {
    const t = prepare("one");
    const s = sent(t, "uncertain");
    expect(store.learning.status("default").pending).toBe(false);
    store.close();
    store = new ReplyReviewStore(path);
    const confirmed = { ...s, status: "sent" as const, sentAt: new Date(now).toISOString() };
    store.updateSend(t.key, confirmed);
    store.updateSend(t.key, confirmed);
    const current = store.get(t.key)!;
    const replacement = draft("replacement");
    store.learning.recordGeneration(current, replacement, {});
    store.saveDrafts(t.key, replacement, current.drafts!.revision);
    const job = store.learning.claim("default", now)!;
    expect(job.observations).toHaveLength(1);
    expect(job.observations[0]).toMatchObject({
      original: "Want to book a meeting?",
      body: "How are you approaching it?",
      learningVersion: 7,
    });
    expect(
      store.db
        .query("SELECT count(*) n FROM reply_learning_artifacts WHERE kind='replacement'")
        .get(),
    ).toEqual({ n: 1 });
  });
  it("ignores autosaves, unused improvements and failed sends; captures email sends with their channel", () => {
    const t = prepare("one");
    store.learning.recordImprovement(t, "direct", "before", "unused", "Always be concise");
    sent(t, "failed");
    expect(store.learning.claim("default", now)).toBeNull();
    sent(prepare("email", "default", "email"));
    const job = store.learning.claim("default", now)!;
    expect(job.observations).toHaveLength(1);
    expect(job.observations[0]).toMatchObject({ channel: "email", threadKey: "email" });
  });
  it("captures only accepted improvements for the selected variant and rejects forged provenance", () => {
    let t = prepare("one");
    const accepted = store.learning.recordImprovement(
      t,
      "direct",
      t.drafts!.edits.direct,
      "Short answer",
      "Always keep my replies concise",
    )!;
    const unused = store.learning.recordImprovement(
      t,
      "direct",
      t.drafts!.edits.direct,
      "Unused answer",
      "Always add an emoji",
    )!;
    store.saveDrafts(
      t.key,
      {
        ...t.drafts!,
        improvementIds: { direct: [accepted, unused, "forged"] },
        learningVersion: 999,
        originals: { ...t.drafts!.originals, direct: "forged" },
        edits: { ...t.drafts!.edits, direct: "Short answer" },
      },
      t.drafts!.revision,
    );
    t = store.get(t.key)!;
    expect(t.drafts!.improvementIds!.direct).toEqual([accepted]);
    expect(t.drafts!.originals.direct).toBe("Want to book a meeting?");
    sent(t);
    const o = store.learning.claim("default", now)!.observations[0]!;
    expect(o.feedback).toEqual(["Always keep my replies concise"]);
    expect(o.learningVersion).toBe(7);
  });
  it("does not move immutable evidence when a conversation changes workspace", () => {
    const t = prepare("one");
    const s = sent(t, "pending");
    store.upsert("scope", { ...t, workspace: "other" });
    store.updateSend(t.key, { ...s, status: "sent" });
    expect(store.learning.claim("other", now)).toBeNull();
    expect(store.learning.claim("default", now)!.observations).toHaveLength(1);
  });
  it("imports app sends once, skips ambiguous ownership, and tolerates missing original generations", () => {
    for (const key of ["reliable", "ambiguous"]) {
      store.upsert("scope", {
        ...thread(key),
        messages: [
          {
            id: "before",
            human: true,
            deleted: false,
            direction: "inbound",
            body: "How are you approaching this?",
            at: new Date(now - 1000).toISOString(),
          },
          {
            id: "after",
            human: true,
            direction: "inbound",
            body: "Future response must not be evidence",
            at: new Date(now + 1000).toISOString(),
          },
        ],
      });
      store.db.query("INSERT INTO review_sends VALUES(?,?,?)").run(
        key,
        key,
        JSON.stringify({
          id: key,
          generationId: "missing",
          body: "Plain historical reply",
          variant: "direct",
          status: "sent",
          sentAt: new Date(now).toISOString(),
        }),
      );
    }
    expect(store.learning.importHistory("default", (t) => t.key === "reliable")).toBe(1);
    expect(store.learning.importHistory("default", () => true)).toBe(0);
    expect(store.learning.claim("default", now)!.observations[0]).toMatchObject({
      historical: true,
      original: null,
      feedback: [],
      context: [{ direction: "inbound", body: "How are you approaching this?" }],
    });
  });
});

describe("candidate acceptance and watermarks", () => {
  // Since #813 the store validates candidates and hands them back; the job
  // turns them into pending proposals in the ledger. Nothing here applies.
  const accept = (
    job: NonNullable<ReturnType<typeof store.learning.claim>>,
    cands: PreferenceCandidate[],
    at = now,
  ) => store.learning.accept("default", job.token, job.through, cands, job.observations, at);

  it("requires three distinct threads for edits and rejects fabricated or cross-workspace evidence", () => {
    sent(prepare("one"));
    sent(prepare("two"));
    let job = store.learning.claim("default", now)!;
    expect(accept(job, [candidate(job.observations.map((o) => o.id))])).toEqual([]);
    expect(store.learning.finish("default", job.token, job.through, now)).toBe(true);
    sent(prepare("three"));
    job = store.learning.claim("default", now + 300_000)!;
    const ids = job.observations.map((o) => o.id);
    const accepted = accept(
      job,
      [candidate([...ids, "invented"], "edits", "forged"), candidate(ids)],
      now + 300_000,
    )!;
    expect(accepted.map((c) => c.key)).toEqual(["early-pressure"]);
    expect(accepted[0]).toMatchObject({ source: "edits", channel: "linkedin" });
    expect(accepted[0]!.evidence).toHaveLength(3);
    expect(store.learning.claim("other", now + 300_000)).toBeNull();
  });
  it("accepts general feedback from one accepted, confirmed improvement", () => {
    let t = prepare("one");
    const id = store.learning.recordImprovement(
      t,
      "direct",
      "before",
      "plain answer",
      "In general, don't force a question",
    )!;
    store.saveDrafts(
      t.key,
      {
        ...t.drafts!,
        improvementIds: { direct: [id] },
        edits: { ...t.drafts!.edits, direct: "plain answer" },
      },
      t.drafts!.revision,
    );
    t = store.get(t.key)!;
    sent(t);
    const job = store.learning.claim("default", now)!;
    const accepted = accept(job, [
      candidate(
        job.observations.map((o) => o.id),
        "explicit",
      ),
    ])!;
    expect(accepted[0]).toMatchObject({ source: "explicit", channel: "linkedin" });
  });
  it("counts repeated sends in the same thread once", () => {
    for (let i = 0; i < 3; i++) {
      if (i === 0) sent(prepare("same"));
      else {
        const t = store.get("same")!;
        store.saveDrafts(t.key, { ...t.drafts!, edits: draft("unused").edits }, t.drafts!.revision);
        sent(store.get("same")!);
      }
    }
    const job = store.learning.claim("default", now)!;
    expect(accept(job, [candidate(job.observations.map((o) => o.id))])).toEqual([]);
  });
  it("requires five threads for historical or unchanged style, never treating history as strong edits", () => {
    for (let i = 0; i < 5; i++) {
      store.upsert("scope", thread(String(i)));
      store.db.query("INSERT INTO review_sends VALUES(?,?,?)").run(
        String(i),
        String(i),
        JSON.stringify({
          id: String(i),
          generationId: "old",
          body: "a plain answer",
          variant: "direct",
          status: "sent",
          sentAt: new Date(now).toISOString(),
        }),
      );
    }
    store.learning.importHistory("default", () => true);
    const job = store.learning.claim("default", now)!;
    const ids = job.observations.map((o) => o.id);
    const accepted = accept(job, [
      candidate(ids, "edits", "not-edits"),
      candidate(ids.slice(0, 4), "style", "too-few"),
      candidate(ids, "style"),
    ])!;
    expect(accepted.map((c) => c.key)).toEqual(["early-pressure"]);
  });
  it("scopes a candidate to one channel only when every cited send is on it", () => {
    sent(prepare("a"));
    sent(prepare("b"));
    sent(prepare("c", "default", "email"));
    const job = store.learning.claim("default", now)!;
    const ids = job.observations.map((o) => o.id);
    const mixed = accept(job, [candidate(ids)])!;
    expect(mixed[0]!.channel).toBeNull();
    sent(prepare("d"));
    store.learning.finish("default", job.token, job.through, now);
    const next = store.learning.claim("default", now + 300_000)!;
    const linkedin = next.observations.filter((o) => o.channel === "linkedin").map((o) => o.id);
    const only = accept(next, [candidate(linkedin)], now + 300_000)!;
    expect(only[0]!.channel).toBe("linkedin");
  });
  it("leases across restart, retries failures after cooldown, and keeps arrivals during synthesis dirty", () => {
    sent(prepare("one"));
    const job = store.learning.claim("default", now)!;
    store.close();
    store = new ReplyReviewStore(path);
    expect(store.learning.claim("default", now + 1)).toBeNull();
    store.learning.fail("default", job.token, "Retry later");
    expect(store.learning.claim("default", now + 299_999)).toBeNull();
    const retry = store.learning.claim("default", now + 300_000)!;
    sent(prepare("two"));
    expect(store.learning.finish("default", retry.token, retry.through, now + 300_000)).toBe(true);
    expect(store.learning.status("default").pending).toBe(true);
    expect(store.learning.status("default").error).toBeNull();
    expect(store.learning.claim("default", now + 600_000)!.observations).toHaveLength(2);
  });
  it("does not accept or commit a stale run after the user changes controls, and pausing blocks claims", () => {
    sent(prepare("one"));
    const job = store.learning.claim("default", now)!;
    store.learning.setEnabled("default", false);
    expect(store.learning.claim("default", now + 300_000)).toBeNull();
    store.learning.setEnabled("default", true);
    expect(accept(job, [])).toBeNull();
    expect(store.learning.finish("default", job.token, job.through, now)).toBe(false);
    expect(store.learning.status("default").pending).toBe(true);
    expect(store.learning.status("default").preferences).toEqual([]);
  });
  it("hands v1 preference rows back with their evidence for the legacy import", () => {
    sent(prepare("one"));
    const o = store.learning.claim("default", now)!.observations[0]!;
    store.db
      .query("INSERT INTO reply_learning_preferences VALUES(?,?,?,?,?,?)")
      .run("default", "plain", "Keep it plain.", "edits", 0, JSON.stringify([o.id, "gone"]));
    expect(store.learning.legacyPreferences("default")).toEqual([
      expect.objectContaining({ id: "plain", enabled: false, source: "edits" }),
    ]);
    expect(store.learning.legacyPreferences("default")[0]!.evidence.map((e) => e.id)).toEqual([
      o.id,
    ]);
    expect(store.learning.legacyPreferences("other")).toEqual([]);
  });
});

it("renews only the current live lease and recovers after a heartbeat stops", () => {
  sent(prepare("one"));
  const job = store.learning.claim("default", now)!;
  expect(store.learning.renew("other", job.token, now + 60_000)).toBe(false);
  expect(store.learning.renew("default", "wrong-token", now + 60_000)).toBe(false);
  expect(store.learning.renew("default", job.token, now + 180_000)).toBe(true);
  expect(store.learning.claim("default", now + 300_000)).toBeNull();
  expect(store.learning.renew("default", job.token, now + 420_000)).toBe(false);
  const retry = store.learning.claim("default", now + 420_000)!;
  expect(retry.token).not.toBe(job.token);
  expect(store.learning.renew("default", job.token, now + 420_001)).toBe(false);
  store.learning.setEnabled("default", false);
  expect(store.learning.renew("default", retry.token, now + 420_002)).toBe(false);
});
