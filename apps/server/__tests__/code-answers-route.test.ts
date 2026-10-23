import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeAnswer, ReplyDraftSet, ReplyThread } from "@oneshot-gtm/shared-types";

// Answers from your code, server half: the reply composer captures a
// how-it-works question the brief does not answer (only with a source repo
// configured, and read once), and the routes list, approve, dismiss, re-read
// and sweep. The store and the reader are the backend's; they are doubles
// here so these tests pin the capture rule and the route contract.

const generate = vi.fn();
const capture = vi.fn();
const list = vi.fn();
const approve = vi.fn();
const dismiss = vi.fn();
const derive = vi.fn();
const sweep = vi.fn();
const testRepo = vi.fn();
vi.mock("../src/linkedin-client.ts", () => ({ callLinkedIn: vi.fn() }));
vi.mock("../src/linkedin-sync.ts", () => ({ refreshLinkedInInbox: async () => {} }));
vi.mock("../src/api/replies-view.ts", () => ({
  collectReplies: async () => ({ threads: [] }),
  threadContextVersion: (t: { contextVersion: string }) => t.contextVersion,
}));
vi.mock("../src/api/inbox.ts", () => ({
  listInboxRoute: vi.fn(),
  draftReplyRoute: vi.fn(),
  saveDraftRoute: vi.fn(),
  steerRoute: vi.fn(),
  archiveInboxConversationRoute: vi.fn(),
  sendReplyRoute: vi.fn(),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  captureCodeQuestion: (...a: unknown[]) => capture(...a),
  listCodeAnswers: (...a: unknown[]) => list(...a),
  approveCodeAnswer: (...a: unknown[]) => approve(...a),
  dismissCodeAnswer: (...a: unknown[]) => dismiss(...a),
}));
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  generateReplyOptions: (...a: unknown[]) => generate(...a),
  deriveCodeAnswer: (...a: unknown[]) => derive(...a),
  sweepCodeAnswers: (...a: unknown[]) => sweep(...a),
}));
vi.mock("@oneshot-gtm/find", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find")),
  testSourceRepo: (...a: unknown[]) => testRepo(...a),
}));

const { getReplyReviewStore, loadConfig, saveConfig } = await import("@oneshot-gtm/core");
const { replyGenerateRoute, replyDraftSaveRoute } = await import("../src/api/replies.ts");
const routes = await import("../src/api/code-answers.ts");
const review = getReplyReviewStore();

const post = (path: string, body: unknown = {}) =>
  new Request(`http://localhost:3030${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3030" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`http://localhost:3030${path}`);

const row = (over: Partial<CodeAnswer> = {}): CodeAnswer => ({
  id: "q1",
  question: "How are failed calls retried?",
  status: "open",
  deriving: false,
  answer: null,
  founderEdited: false,
  whyUnresolved: null,
  files: [],
  commit: null,
  askedCount: 1,
  sourceThreadKey: "email",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  decidedAt: null,
  ...over,
});

const MECHANISM = {
  level: "mechanism",
  question: "How are failed calls retried?",
  briefAnswers: false,
} as const;

function seed(): ReplyThread {
  const t: ReplyThread = {
    key: "email",
    channel: "email",
    name: "Ada",
    company: null,
    address: "ada@example.com",
    subject: "Question",
    workspace: "default",
    prospectId: null,
    messages: [
      {
        id: "in",
        direction: "inbound",
        body: "How are failed calls retried?",
        at: "2026-09-17T12:00:00Z",
        human: true,
      },
    ],
    lastActivityAt: "2026-09-17T12:00:00Z",
    archivedAt: null,
    snoozedUntil: null,
    needsReply: true,
    canGenerate: true,
    canSend: true,
    contextVersion: "context",
    drafts: null,
    send: null,
  };
  review.upsert("test", t);
  return t;
}

function generated(ask?: unknown) {
  return {
    drafts: { direct: "First", technical: "Second", warm: "Third" },
    read: "A mechanism question the brief does not answer.",
    moves: { direct: "answer", technical: "check", warm: "ask" },
    flags: { perVariant: { direct: [], technical: [], warm: [] }, set: [] },
    ...(ask ? { ask } : {}),
  };
}

function withRepo(repo: { url?: string; path?: string } | undefined) {
  const { sourceRepo: _drop, ...cfg } = loadConfig();
  saveConfig({
    ...cfg,
    productBrief: "Tools with retries.",
    ...(repo ? { sourceRepo: repo } : {}),
  });
}

beforeEach(() => {
  review.db.exec("DELETE FROM review_threads; DELETE FROM review_sends; DELETE FROM review_leases");
  withRepo({ path: "/tmp/checkout" });
  for (const fn of [generate, capture, list, approve, dismiss, derive, sweep, testRepo])
    fn.mockReset();
  capture.mockReturnValue(row());
  derive.mockResolvedValue(row({ status: "pending", answer: "Failed calls retry twice." }));
  list.mockReturnValue([]);
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const noop = () => {};

describe("capture from the reply composer", () => {
  it("captures a mechanism question the brief does not answer, reads it once, and carries the id", async () => {
    seed();
    generate.mockResolvedValue(generated(MECHANISM));
    const res = await replyGenerateRoute(post("/api/replies/generate", { key: "email" }));
    const body = (await res.json()) as ReplyDraftSet;
    expect(res.status).toBe(200);
    expect(body.ask).toEqual(MECHANISM);
    expect(body.codeAnswerId).toBe("q1");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(expect.anything(), {
      question: "How are failed calls retried?",
      threadKey: "email",
    });
    await flush();
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith(expect.anything(), "q1");
  });

  it("does not read again a question already answered or being read", async () => {
    seed();
    generate.mockResolvedValue(generated(MECHANISM));
    capture.mockReturnValueOnce(row({ status: "pending", answer: "x" }));
    await replyGenerateRoute(post("/api/replies/generate", { key: "email" }));
    capture.mockReturnValueOnce(row({ deriving: true }));
    await replyGenerateRoute(post("/api/replies/generate", { key: "email", force: true }));
    await flush();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(derive).not.toHaveBeenCalled();
  });

  it("regenerating the same conversation state reuses the capture instead of counting it again", async () => {
    const t = seed();
    generate.mockResolvedValue(generated(MECHANISM));
    const first = (await (
      await replyGenerateRoute(post("/api/replies/generate", { key: t.key }))
    ).json()) as ReplyDraftSet;
    review.saveDrafts(t.key, first, null);
    const again = (await (
      await replyGenerateRoute(post("/api/replies/generate", { key: t.key, force: true }))
    ).json()) as ReplyDraftSet;
    expect(again.codeAnswerId).toBe("q1");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("leaves capability questions, covered questions and garbled asks alone", async () => {
    seed();
    for (const ask of [
      { level: "capability", question: "Does it retry?", briefAnswers: false },
      { ...MECHANISM, briefAnswers: true },
      { level: null, question: null, briefAnswers: false },
      { ...MECHANISM, question: null },
      undefined,
    ]) {
      generate.mockResolvedValue(generated(ask));
      const body = (await (
        await replyGenerateRoute(post("/api/replies/generate", { key: "email", force: true }))
      ).json()) as ReplyDraftSet;
      expect(body.codeAnswerId).toBeUndefined();
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures nothing without a source repo", async () => {
    withRepo(undefined);
    seed();
    generate.mockResolvedValue(generated(MECHANISM));
    const body = (await (
      await replyGenerateRoute(post("/api/replies/generate", { key: "email" }))
    ).json()) as ReplyDraftSet;
    expect(body.ask).toEqual(MECHANISM);
    expect(body.codeAnswerId).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it("never fails the draft when capture or the read fails", async () => {
    seed();
    generate.mockResolvedValue(generated(MECHANISM));
    capture.mockImplementationOnce(() => {
      throw new Error("ledger locked");
    });
    const res = await replyGenerateRoute(post("/api/replies/generate", { key: "email" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as ReplyDraftSet).codeAnswerId).toBeUndefined();
    derive.mockRejectedValueOnce(new Error("model down"));
    const ok = await replyGenerateRoute(
      post("/api/replies/generate", { key: "email", force: true }),
    );
    expect(ok.status).toBe(200);
    await flush();
  });

  it("a saved draft keeps a well-formed ask and id, and drops a garbled ask", async () => {
    const t = seed();
    const base: ReplyDraftSet = {
      id: "g1",
      revision: 0,
      contextVersion: "context",
      read: "",
      originals: { direct: "a", technical: "b", warm: "c" },
      edits: { direct: "a", technical: "b", warm: "c" },
      moves: {},
      flags: { direct: [], technical: [], warm: [] },
      setFlags: [],
      selected: "direct",
      steer: "",
      generated: true,
    };
    const saved = await replyDraftSaveRoute(
      post("/api/replies/drafts", {
        key: t.key,
        drafts: { ...base, ask: MECHANISM, codeAnswerId: "q1" },
        expectedRevision: null,
      }),
    );
    expect(await saved.json()).toMatchObject({ ask: MECHANISM, codeAnswerId: "q1" });
    const garbled = await replyDraftSaveRoute(
      post("/api/replies/drafts", {
        key: t.key,
        drafts: { ...base, ask: { level: "deep", briefAnswers: "no" } },
        expectedRevision: 1,
      }),
    );
    const body = (await garbled.json()) as ReplyDraftSet;
    expect(body.ask).toBeUndefined();
    expect(body.codeAnswerId).toBeUndefined();
  });
});

describe("code answer routes", () => {
  it("lists every answer, or only the ones a thread asked", async () => {
    const t = seed();
    list.mockReturnValue([
      row({ id: "q1", sourceThreadKey: "email" }),
      row({ id: "q2", sourceThreadKey: "linkedin:other" }),
      row({ id: "q3", sourceThreadKey: "linkedin:third" }),
    ]);
    const all = await routes.listCodeAnswersRoute(get("/api/code-answers"));
    expect(((await all.json()) as { answers: CodeAnswer[] }).answers.map((a) => a.id)).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
    const mine = await routes.listCodeAnswersRoute(get("/api/code-answers?threadKey=email"));
    expect(((await mine.json()) as { answers: CodeAnswer[] }).answers.map((a) => a.id)).toEqual([
      "q1",
    ]);
    // A question first asked elsewhere still shows where its drafts carry it.
    review.saveDrafts(
      t.key,
      {
        id: "g",
        revision: 0,
        contextVersion: "context",
        read: "",
        originals: { direct: "", technical: "", warm: "" },
        edits: { direct: "", technical: "", warm: "" },
        moves: {},
        flags: { direct: [], technical: [], warm: [] },
        setFlags: [],
        selected: "direct",
        steer: "",
        generated: true,
        codeAnswerId: "q2",
      },
      null,
    );
    const carried = await routes.listCodeAnswersRoute(
      get("/api/code-answers?threadKey=email&id=q3"),
    );
    expect(
      ((await carried.json()) as { answers: CodeAnswer[] }).answers.map((a) => a.id).toSorted(),
    ).toEqual(["q1", "q2", "q3"]);
  });

  it("approves as read, or with the founder's edit", async () => {
    approve.mockImplementation((_l: unknown, id: string, text?: string) =>
      row({ id, status: "approved", answer: text ?? "as read", founderEdited: text != null }),
    );
    const plain = await routes.approveCodeAnswerRoute(post("/api/code-answers/q1/approve"), {
      id: "q1",
    });
    expect(plain.status).toBe(200);
    expect(approve).toHaveBeenLastCalledWith(expect.anything(), "q1", undefined);
    const edited = await routes.approveCodeAnswerRoute(
      post("/api/code-answers/q1/approve", { text: "  Failed calls retry twice.  " }),
      { id: "q1" },
    );
    expect(await edited.json()).toMatchObject({
      ok: true,
      answer: { status: "approved", answer: "Failed calls retry twice.", founderEdited: true },
    });
    expect(approve).toHaveBeenLastCalledWith(expect.anything(), "q1", "Failed calls retry twice.");
    const blank = await routes.approveCodeAnswerRoute(
      post("/api/code-answers/q1/approve", { text: "  " }),
      { id: "q1" },
    );
    expect(blank.status).toBe(400);
    approve.mockImplementationOnce(() => {
      throw new Error("Answer is not pending");
    });
    const refused = await routes.approveCodeAnswerRoute(post("/api/code-answers/q1/approve"), {
      id: "q1",
    });
    expect(refused.status).toBe(409);
  });

  it("dismisses", async () => {
    dismiss.mockReturnValue(row({ status: "dismissed" }));
    const res = routes.dismissCodeAnswerRoute(post("/api/code-answers/q1/dismiss"), { id: "q1" });
    expect(res.status).toBe(200);
    expect(dismiss).toHaveBeenCalledWith(expect.anything(), "q1");
  });

  it("re-reads in the background, once at a time", async () => {
    list.mockReturnValue([row({ status: "unresolved", whyUnresolved: "no retry code found" })]);
    let finish: (v: unknown) => void = noop;
    derive.mockReturnValue(new Promise((r) => (finish = r)));
    const first = routes.deriveCodeAnswerRoute(post("/api/code-answers/q1/derive"), { id: "q1" });
    expect(first.status).toBe(202);
    await flush();
    expect(derive).toHaveBeenCalledTimes(1);
    const listed = await routes.listCodeAnswersRoute(get("/api/code-answers"));
    expect(((await listed.json()) as { answers: CodeAnswer[] }).answers[0]!.deriving).toBe(true);
    const second = routes.deriveCodeAnswerRoute(post("/api/code-answers/q1/derive"), { id: "q1" });
    expect(second.status).toBe(409);
    finish(row({ status: "pending" }));
    await flush();
    expect(
      routes.deriveCodeAnswerRoute(post("/api/code-answers/missing/derive"), { id: "missing" })
        .status,
    ).toBe(404);
  });

  it("refuses to read or sweep without a source repo", async () => {
    withRepo(undefined);
    expect(
      routes.deriveCodeAnswerRoute(post("/api/code-answers/q1/derive"), { id: "q1" }).status,
    ).toBe(409);
    expect((await routes.sweepCodeAnswersRoute(post("/api/code-answers/sweep"))).status).toBe(409);
    expect(derive).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("sweeps on demand", async () => {
    sweep.mockResolvedValue({ checked: 2, stale: 1 });
    const res = await routes.sweepCodeAnswersRoute(post("/api/code-answers/sweep"));
    expect(await res.json()).toEqual({ ok: true, result: { checked: 2, stale: 1 } });
  });

  it("tests the form's unsaved repo, or the saved one", async () => {
    testRepo.mockResolvedValue({ ok: true, backend: "github", ref: "main", commit: "abc" });
    const form = await routes.testSourceRepoRoute(
      post("/api/setup/source-repo/test", { url: "https://github.com/acme/widget", ref: "main" }),
    );
    expect(await form.json()).toMatchObject({ ok: true, backend: "github" });
    expect(testRepo).toHaveBeenLastCalledWith({
      url: "https://github.com/acme/widget",
      ref: "main",
    });
    await routes.testSourceRepoRoute(post("/api/setup/source-repo/test"));
    expect(testRepo).toHaveBeenLastCalledWith({ path: "/tmp/checkout" });
    const bad = await routes.testSourceRepoRoute(
      post("/api/setup/source-repo/test", { url: "https://example.com/x" }),
    );
    expect(await bad.json()).toMatchObject({ ok: false });
    testRepo.mockRejectedValueOnce(new Error("Repo not found (private? set GITHUB_TOKEN)"));
    const missing = await routes.testSourceRepoRoute(post("/api/setup/source-repo/test"));
    expect(await missing.json()).toEqual({
      ok: false,
      error: "Repo not found (private? set GITHUB_TOKEN)",
    });
  });

  it("is read-only in the demo", async () => {
    const previous = process.env.ONESHOT_GTM_DEMO;
    process.env.ONESHOT_GTM_DEMO = "1";
    try {
      expect(
        (await routes.approveCodeAnswerRoute(post("/api/code-answers/q1/approve"), { id: "q1" }))
          .status,
      ).toBe(403);
      expect(
        routes.dismissCodeAnswerRoute(post("/api/code-answers/q1/dismiss"), { id: "q1" }).status,
      ).toBe(403);
      expect(approve).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.ONESHOT_GTM_DEMO;
      else process.env.ONESHOT_GTM_DEMO = previous;
    }
  });
});
