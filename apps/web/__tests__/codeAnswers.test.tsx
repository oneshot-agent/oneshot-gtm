import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CodeAnswer } from "@oneshot-gtm/shared-types";
import {
  CodeAnswerCard,
  CodeAnswerCardView,
  threadCodeAnswersKey,
} from "../src/components/CodeAnswerCard.tsx";
import { CodeAnswersListView } from "../src/components/setup/CodeAnswersList.tsx";
import { SourceRepoTestLine } from "../src/components/setup/ProductBriefSection.tsx";
import {
  askedLabel,
  briefSectionRequest,
  composerCodeAnswerState,
  sortCodeAnswers,
  sourceRepoError,
  sourceRepoField,
  sourceRepoRequest,
  threadCodeAnswer,
} from "../src/lib/codeAnswers.ts";

// Answers from your code, web half: the composer card under the
// conversation insight, and the list on /setup.

const row = (over: Partial<CodeAnswer> = {}): CodeAnswer => ({
  id: "q1",
  question: "How are failed calls retried?",
  status: "pending",
  deriving: false,
  answer: "A failed call is retried twice, then reported as failed.",
  founderEdited: false,
  whyUnresolved: null,
  files: [{ path: "src/retry.ts" }],
  commit: "0123456789abcdef",
  askedCount: 3,
  sourceThreadKey: "t1",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  decidedAt: null,
  ...over,
});

const noop = () => {};
const card = (answer: CodeAnswer | null) =>
  renderToStaticMarkup(
    <CodeAnswerCardView
      answer={answer}
      busy={false}
      onApprove={noop}
      onDismiss={noop}
      onReread={noop}
    />,
  );
const list = (answers: CodeAnswer[], repoConfigured = true) =>
  renderToStaticMarkup(
    <CodeAnswersListView
      answers={answers}
      repoConfigured={repoConfigured}
      busy={false}
      sweeping={false}
      onApprove={noop}
      onDismiss={noop}
      onDerive={noop}
      onSweep={noop}
    />,
  );

describe("composer card", () => {
  it("says it is reading while the code is read", () => {
    expect(card(row({ status: "open", answer: null, deriving: true }))).toContain(
      "Reading your code…",
    );
    expect(card(row({ deriving: true }))).toContain("Reading your code…");
  });

  it("offers to read again when the last read did not finish", () => {
    const html = card(row({ status: "open", answer: null }));
    expect(html).not.toContain("Reading your code…");
    expect(html).toContain("Your code wasn&#x27;t read for this yet.");
    expect(html).toContain("Read again");
  });

  it("offers a pending answer to approve, edit or dismiss", () => {
    const html = card(row());
    expect(html).toContain("Answer from your code: </span>A failed call is retried twice");
    expect(html).toContain("Approve");
    expect(html).toContain("Edit");
    expect(html).toContain("Dismiss");
  });

  it("says why the code did not settle it", () => {
    expect(
      card(
        row({ status: "unresolved", answer: null, whyUnresolved: "no retry logic in the repo" }),
      ),
    ).toContain("Your code didn&#x27;t settle this: no retry logic in the repo");
  });

  it("shows nothing once approved, dismissed or stale", () => {
    for (const status of ["approved", "dismissed", "stale"] as const)
      expect(card(row({ status }))).toBe("");
    expect(card(null)).toBe("");
  });

  it("reads this thread's answer from the query", () => {
    const client = new QueryClient();
    client.setQueryData(threadCodeAnswersKey("t1", "q1"), { answers: [row()] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CodeAnswerCard threadKey="t1" answerId="q1" onApproved={noop} />
      </QueryClientProvider>,
    );
    expect(html).toContain("A failed call is retried twice");
  });
});

describe("/setup list", () => {
  it("puts pending first, then approved, stale, unresolved, and hides dismissed", () => {
    const html = list([
      row({ id: "u", status: "unresolved", question: "Q unresolved", whyUnresolved: "no code" }),
      row({ id: "s", status: "stale", question: "Q stale" }),
      row({ id: "a", status: "approved", question: "Q approved" }),
      row({ id: "d", status: "dismissed", question: "Q dismissed" }),
      row({ id: "p", status: "pending", question: "Q pending" }),
    ]);
    const order = ["Q pending", "Q approved", "Q stale", "Q unresolved"].map((q) =>
      html.indexOf(q),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(html).not.toContain("Q dismissed");
    expect(html).toContain("Answers from your code · 1 to review");
  });

  it("shows the question, times asked, the answer and the short commit", () => {
    const html = list([row()]);
    expect(html).toContain("How are failed calls retried?");
    expect(html).toContain("asked 3 times");
    expect(html).toContain("0123456");
    expect(html).not.toContain("0123456789");
    expect(html).toContain("A failed call is retried twice");
    expect(html).toContain("Approve");
    expect(html).toContain("Dismiss");
  });

  it("says why an unresolved one was not settled and offers to read again", () => {
    const html = list([
      row({ status: "unresolved", answer: null, whyUnresolved: "the retry policy is configured" }),
    ]);
    expect(html).toContain("Your code didn&#x27;t settle this: the retry policy is configured");
    expect(html).toContain("Read again");
    expect(html).toContain("Write the answer");
    expect(html).not.toContain(">Approve");
  });

  it("lets an approved answer be dismissed out of the brief, and offers nothing while reading", () => {
    const approved = list([row({ status: "approved" })]);
    expect(approved).toContain("in the brief");
    expect(approved).toContain("Take it out of the brief");
    expect(approved).not.toContain(">Approve");
    const reading = list([row({ status: "open", answer: null, deriving: true })]);
    expect(reading).toContain("Reading your code…");
    expect(reading).not.toContain("Dismiss");
  });

  it("marks a question whose read did not finish as not read yet, with a re-read", () => {
    const html = list([row({ status: "open", answer: null, commit: null })]);
    expect(html).not.toContain("Reading your code…");
    expect(html).toContain("not read yet");
    expect(html).toContain("Read again");
    expect(html).toContain("Write the answer");
    expect(list([row({ status: "open", answer: null })], false)).not.toContain("Read again");
  });

  it("explains the empty list when a repo is connected, and hides without one", () => {
    expect(list([])).toContain("None yet.");
    expect(list([], false)).toBe("");
  });

  it("reports a repo test", () => {
    expect(
      renderToStaticMarkup(
        <SourceRepoTestLine
          result={{
            ok: true,
            backend: "github",
            ref: "main",
            commit: "abcdef12345",
            readableFiles: 41,
          }}
        />,
      ),
    ).toContain("readable via GitHub · main @ abcdef1 · 41 files the answers may read");
    expect(
      renderToStaticMarkup(<SourceRepoTestLine result={{ ok: false, error: "Repo not found" }} />),
    ).toContain("can&#x27;t read it · Repo not found");
  });
});

describe("helpers", () => {
  it("picks the thread's answer by id, else the latest it asked", () => {
    const answers = [
      row({
        id: "a",
        sourceThreadKey: "t1",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-09T00:00:00Z",
      }),
      row({
        id: "b",
        sourceThreadKey: "t1",
        createdAt: "2026-10-05T00:00:00Z",
        updatedAt: "2026-10-06T00:00:00Z",
      }),
      row({ id: "c", sourceThreadKey: "t2" }),
    ];
    expect(threadCodeAnswer(answers, "t1", "c")?.id).toBe("c");
    expect(threadCodeAnswer(answers, "t1")?.id).toBe("b");
    expect(threadCodeAnswer(answers, "t3")).toBeNull();
  });

  it("maps states and labels", () => {
    expect(composerCodeAnswerState(row({ status: "pending", answer: null }))).toBeNull();
    expect(askedLabel(1)).toBe("asked once");
    expect(sortCodeAnswers([row({ status: "dismissed" })])).toEqual([]);
  });

  it("maps the repo field to a URL or a path", () => {
    expect(sourceRepoRequest("github.com/acme/widget", " main ")).toEqual({
      url: "https://github.com/acme/widget",
      ref: "main",
    });
    expect(sourceRepoRequest("http://github.com/acme/widget", "")).toEqual({
      url: "https://github.com/acme/widget",
    });
    expect(sourceRepoRequest("HTTPS://github.com/acme/widget", "")).toEqual({
      url: "https://github.com/acme/widget",
    });
    expect(sourceRepoRequest("/home/me/widget", "")).toEqual({ path: "/home/me/widget" });
    expect(sourceRepoRequest("  ", "main")).toBeNull();
    expect(sourceRepoField({ url: "https://github.com/a/b", path: "/x" })).toBe("/x");
    expect(sourceRepoField(undefined)).toBe("");
  });

  it("sends the repo with its saved ref when only one of them was edited", () => {
    const saved = {
      productBrief: "Brief.",
      sourceRepo: "https://github.com/acme/widget",
      sourceRef: "main",
      codeAnswerDisclosure: "",
    };
    expect(briefSectionRequest({ sourceRef: "release" }, saved)).toEqual({
      sourceRepo: { url: "https://github.com/acme/widget", ref: "release" },
    });
    expect(briefSectionRequest({ sourceRepo: "/srv/widget" }, saved)).toEqual({
      sourceRepo: { path: "/srv/widget", ref: "main" },
    });
    expect(briefSectionRequest({ sourceRepo: "" }, saved)).toEqual({ sourceRepo: null });
    expect(briefSectionRequest({ productBrief: "New." }, saved)).toEqual({ productBrief: "New." });
  });

  it("flags a repo the server would refuse", () => {
    expect(sourceRepoError("")).toBeNull();
    expect(sourceRepoError("https://github.com/acme/widget")).toBeNull();
    expect(sourceRepoError("~/code/widget")).toBeNull();
    expect(sourceRepoError("https://gitlab.com/acme/widget")).toMatch(/Only GitHub/);
    expect(sourceRepoError("https://github.com/acme")).toMatch(/owner\/repo/);
    expect(sourceRepoError("code/widget")).toMatch(/absolute path/);
  });
});

const thread = (codeAnswerId?: string) => ({
  key: "t1",
  channel: "email" as const,
  name: "Ada",
  company: null,
  subject: "Question",
  address: "ada@example.com",
  workspace: "default",
  prospectId: null,
  messages: [],
  lastActivityAt: "2026-10-21T00:00:00Z",
  archivedAt: null,
  snoozedUntil: null,
  needsReply: false,
  canSend: true,
  canGenerate: true,
  contextVersion: "v1",
  send: null,
  drafts: {
    id: "g1",
    revision: 1,
    contextVersion: "v1",
    read: "They ask how retries behave; the brief does not say.",
    originals: { direct: "a", technical: "b", warm: "c" },
    edits: { direct: "a", technical: "b", warm: "c" },
    moves: {},
    flags: { direct: [], technical: [], warm: [] },
    setFlags: [],
    selected: "direct" as const,
    steer: "",
    generated: true,
    ...(codeAnswerId ? { codeAnswerId } : {}),
  },
});

describe("composer mount", () => {
  it("shows the card under the conversation insight for the question the drafts carry", async () => {
    const { ReplyOptionsComposer } = await import("../src/components/ReplyOptionsComposer.tsx");
    const client = new QueryClient();
    client.setQueryData(threadCodeAnswersKey("t1", "q1"), { answers: [row()] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ReplyOptionsComposer thread={thread("q1")} />
      </QueryClientProvider>,
    );
    const insight = html.indexOf("Conversation insight");
    const answer = html.indexOf("Answer from your code");
    expect(insight).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(insight);
    const without = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ReplyOptionsComposer thread={thread()} />
      </QueryClientProvider>,
    );
    expect(without).toContain("Conversation insight");
    expect(without).not.toContain("Answer from your code");
  });
});
