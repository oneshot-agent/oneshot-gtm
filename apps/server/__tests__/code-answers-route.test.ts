import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeAnswer, ReplyDraftSet, ReplyThread } from "@oneshot-gtm/shared-types";

// Answers from your code, server half: the reply composer captures a
// how-it-works question the brief does not answer (only with a source repo
// connected, and read once), and the routes list, approve, dismiss, re-read
// and sweep. The ledger store is real; reading the repo and the model are
// doubles, so these tests pin the capture rule and the route contract.

const generate = vi.fn();
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
vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  generateReplyOptions: (...a: unknown[]) => generate(...a),
}));
vi.mock("@oneshot-gtm/find", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find")),
  deriveCodeAnswer: (...a: unknown[]) => derive(...a),
  sweepCodeAnswers: (...a: unknown[]) => sweep(...a),
  testSourceRepo: (...a: unknown[]) => testRepo(...a),
}));

const { getLedger, getReplyReviewStore, loadConfig, saveConfig } =
  await import("@oneshot-gtm/core");
const { replyGenerateRoute, replyDraftSaveRoute } = await import("../src/api/replies.ts");
const routes = await import("../src/api/code-answers.ts");
const review = getReplyReviewStore();
const ledger = getLedger();
const store = ledger.codeAnswers;

const post = (path: string, body: unknown = {}) =>
  new Request(`http://localhost:3030${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3030" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`http://localhost:3030${path}`);
const flush = () => new Promise((r) => setTimeout(r, 0));
const noop = () => {};

const QUESTION = "How are failed calls retried?";
const MECHANISM = { level: "mechanism", question: QUESTION, briefAnswers: false } as const;

function seed(key = "email"): ReplyThread {
  const t: ReplyThread = {
    key,
    channel: "email",
    name: "Ada",
    company: null,
    address: "ada@example.com",
    subject: "Question",
    workspace: "default",
    prospectId: null,
    messages: [
      { id: "in", direction: "inbound", body: QUESTION, at: "2026-09-17T12:00:00Z", human: true },
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

/** What a real derive leaves behind: a pending answer read at a commit. */
function answered(id: string, answer = "A failed call is retried twice.") {
  store.recordDerive(id, {
    status: "pending",
    answer,
    files: [{ path: "src/retry.ts", sha256: "h" }],
    commit: "0123456789abcdef",
    promptVersion: "test",
    digest: "d",
  });
}

async function generateFor(key: string, extra: Record<string, unknown> = {}) {
  const res = await replyGenerateRoute(post("/api/replies/generate", { key, ...extra }));
  return { status: res.status, body: (await res.json()) as ReplyDraftSet };
}

const answersOf = async (res: Response) =>
  ((await res.json()) as { answers: CodeAnswer[] }).answers;

beforeEach(() => {
  review.db.exec("DELETE FROM review_threads; DELETE FROM review_sends; DELETE FROM review_leases");
  (ledger as unknown as { db: { exec: (sql: string) => void } }).db.exec(
    "DELETE FROM code_answers",
  );
  withRepo({ path: "/tmp/checkout" });
  for (const fn of [generate, derive, sweep, testRepo]) fn.mockReset();
  derive.mockImplementation(async (id: string) => {
    answered(id);
    return { status: "pending", answer: null };
  });
});

describe("capture from the reply composer", () => {
  it("captures a mechanism question the brief does not answer, reads it once, and carries the id", async () => {
    seed();
    generate.mockResolvedValue(generated(MECHANISM));
    const { status, body } = await generateFor("email");
    expect(status).toBe(200);
    expect(body.ask).toEqual(MECHANISM);
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ question: QUESTION, sourceThreadKey: "email", askedCount: 1 });
    expect(body.codeAnswerId).toBe(rows[0]!.id);
    await flush();
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith(rows[0]!.id, expect.objectContaining({ ledger }));
    // Regenerating: same row, not counted again, not read again.
    const again = await generateFor("email", { force: true });
    await flush();
    expect(again.body.codeAnswerId).toBe(rows[0]!.id);
    expect(store.list()[0]!.askedCount).toBe(1);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("counts the same question from another conversation without reading it again", async () => {
    seed("email");
    seed("other");
    generate.mockResolvedValue(generated(MECHANISM));
    await generateFor("email");
    await flush();
    generate.mockResolvedValue(
      generated({ ...MECHANISM, question: "how are failed calls retried" }),
    );
    const other = await generateFor("other");
    await flush();
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.askedCount).toBe(2);
    expect(other.body.codeAnswerId).toBe(rows[0]!.id);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("leaves capability questions, covered questions and garbled asks alone", async () => {
    seed();
    for (const ask of [
      { level: "capability", question: "Does it retry failed calls?", briefAnswers: false },
      { ...MECHANISM, briefAnswers: true },
      { level: null, question: null, briefAnswers: false },
      { ...MECHANISM, question: null },
      undefined,
    ]) {
      generate.mockResolvedValue(generated(ask));
      expect((await generateFor("email", { force: true })).body.codeAnswerId).toBeUndefined();
    }
    expect(store.list()).toEqual([]);
    expect(derive).not.toHaveBeenCalled();
  });

  it("captures nothing without a source repo", async () => {
    withRepo(undefined);
    seed();
    generate.mockResolvedValue(generated(MECHANISM));
    const { body } = await generateFor("email");
    expect(body.ask).toEqual(MECHANISM);
    expect(body.codeAnswerId).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("never fails the draft when the read fails", async () => {
    seed();
    generate.mockResolvedValue(generated(MECHANISM));
    derive.mockRejectedValueOnce(new Error("model down"));
    const { status, body } = await generateFor("email");
    await flush();
    expect(status).toBe(200);
    expect(body.codeAnswerId).toBeTruthy();
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
  const capture = (question: string, threadKey: string) =>
    store.capture({ question, threadKey })!.record.id;

  it("lists every question, or only the ones a conversation asked", async () => {
    const a = capture(QUESTION, "email");
    const b = capture("What happens when the spend limit is reached mid-run?", "other");
    const c = capture("Is the approval queue ordered by arrival time?", "third");
    expect((await answersOf(routes.listCodeAnswersRoute(get("/api/code-answers")))).length).toBe(3);
    const mine = await answersOf(
      routes.listCodeAnswersRoute(get("/api/code-answers?threadKey=email")),
    );
    expect(mine.map((x) => x.id)).toEqual([a]);
    // The id the drafts carry and an explicit id are included too.
    seed("email");
    review.saveDrafts(
      "email",
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
        codeAnswerId: b,
      },
      null,
    );
    const carried = await answersOf(
      routes.listCodeAnswersRoute(get(`/api/code-answers?threadKey=email&id=${c}`)),
    );
    expect(carried.map((x) => x.id).toSorted()).toEqual([a, b, c].toSorted());
  });

  it("approves as read, or with the founder's edit", async () => {
    const id = capture(QUESTION, "email");
    answered(id);
    const edited = await routes.approveCodeAnswerRoute(
      post(`/api/code-answers/${id}/approve`, { text: "  Failed calls are retried twice.  " }),
      { id },
    );
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({
      ok: true,
      answer: {
        status: "approved",
        answer: "Failed calls are retried twice.",
        founderEdited: true,
      },
    });
    const twice = await routes.approveCodeAnswerRoute(post(`/api/code-answers/${id}/approve`), {
      id,
    });
    expect(twice.status).toBe(409);

    const other = capture("What happens when the spend limit is reached mid-run?", "other");
    answered(other, "The run pauses until you approve more spend.");
    const plain = await routes.approveCodeAnswerRoute(post(`/api/code-answers/${other}/approve`), {
      id: other,
    });
    expect(await plain.json()).toMatchObject({
      answer: {
        status: "approved",
        answer: "The run pauses until you approve more spend.",
        founderEdited: false,
      },
    });
  });

  it("refuses a blank edit, a runaway edit, an unread question without text, and an unknown id", async () => {
    const id = capture(QUESTION, "email");
    const approve = (b: unknown) =>
      routes.approveCodeAnswerRoute(post(`/api/code-answers/${id}/approve`, b), { id });
    expect((await approve({ text: "  " })).status).toBe(400);
    expect((await approve({ text: "x".repeat(1201) })).status).toBe(400);
    expect((await approve({})).status).toBe(409);
    expect(
      (await routes.approveCodeAnswerRoute(post("/api/code-answers/nope/approve"), { id: "nope" }))
        .status,
    ).toBe(404);
  });

  it("dismisses", async () => {
    const id = capture(QUESTION, "email");
    const res = routes.dismissCodeAnswerRoute(post(`/api/code-answers/${id}/dismiss`), { id });
    expect(res.status).toBe(200);
    expect(store.get(id)?.status).toBe("dismissed");
    expect(
      routes.dismissCodeAnswerRoute(post(`/api/code-answers/${id}/dismiss`), { id }).status,
    ).toBe(409);
  });

  it("re-reads in the background, forced, once at a time", async () => {
    const id = capture(QUESTION, "email");
    let finish: (v: unknown) => void = noop;
    derive.mockReturnValue(new Promise((r) => (finish = r)));
    const first = routes.deriveCodeAnswerRoute(post(`/api/code-answers/${id}/derive`), { id });
    expect(first.status).toBe(202);
    expect(derive).toHaveBeenCalledWith(id, expect.objectContaining({ force: true }));
    const listed = await answersOf(routes.listCodeAnswersRoute(get("/api/code-answers")));
    expect(listed[0]!.deriving).toBe(true);
    expect(
      routes.deriveCodeAnswerRoute(post(`/api/code-answers/${id}/derive`), { id }).status,
    ).toBe(409);
    finish({ status: "unresolved", answer: null });
    await flush();
    expect(
      routes.deriveCodeAnswerRoute(post("/api/code-answers/missing/derive"), { id: "missing" })
        .status,
    ).toBe(404);
  });

  it("refuses to read or sweep without a source repo", async () => {
    const id = capture(QUESTION, "email");
    withRepo(undefined);
    expect(
      routes.deriveCodeAnswerRoute(post(`/api/code-answers/${id}/derive`), { id }).status,
    ).toBe(409);
    expect((await routes.sweepCodeAnswersRoute(post("/api/code-answers/sweep"))).status).toBe(409);
    expect(derive).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("sweeps on demand and reports a repo failure", async () => {
    const result = { skipped: false, checked: 2, unchanged: 1, stale: 1, rederived: 1 };
    sweep.mockResolvedValueOnce(result);
    const ok = await routes.sweepCodeAnswersRoute(post("/api/code-answers/sweep"));
    expect(await ok.json()).toEqual({ ok: true, result });
    sweep.mockResolvedValueOnce({ ...result, error: "unknown ref main" });
    expect((await routes.sweepCodeAnswersRoute(post("/api/code-answers/sweep"))).status).toBe(502);
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
    expect(testRepo).toHaveBeenCalledTimes(2);
    withRepo(undefined);
    const none = await routes.testSourceRepoRoute(post("/api/setup/source-repo/test"));
    expect(await none.json()).toMatchObject({ ok: false });
  });

  it("is read-only in the demo", async () => {
    const id = capture(QUESTION, "email");
    const previous = process.env.ONESHOT_GTM_DEMO;
    process.env.ONESHOT_GTM_DEMO = "1";
    try {
      expect(
        (await routes.approveCodeAnswerRoute(post(`/api/code-answers/${id}/approve`), { id }))
          .status,
      ).toBe(403);
      expect(
        routes.dismissCodeAnswerRoute(post(`/api/code-answers/${id}/dismiss`), { id }).status,
      ).toBe(403);
      expect(store.get(id)?.status).toBe("open");
    } finally {
      if (previous === undefined) delete process.env.ONESHOT_GTM_DEMO;
      else process.env.ONESHOT_GTM_DEMO = previous;
    }
  });
});
