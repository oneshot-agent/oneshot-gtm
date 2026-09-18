import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { ReplyPreferences } from "../src/components/ReplyPreferences.tsx";
import {
  adoptReplyImprovement,
  replyLearningSummary,
  replyDraftFingerprint,
} from "../src/lib/replyLearning.ts";
import type { ReplyDraftSet, ReplyLearningStatus } from "@oneshot-gtm/shared-types";

const status: ReplyLearningStatus = {
  enabled: true,
  version: 1,
  pending: false,
  imported: true,
  lastRefreshedAt: null,
  error: null,
  preferences: [
    {
      id: "plain",
      instruction: "Keep language plain.",
      source: "edits",
      enabled: true,
      evidence: [
        {
          id: "sent",
          threadKey: "one",
          name: "Ada",
          original: "Let's book a meeting",
          body: "How are you approaching this?",
          feedback: [],
          historical: true,
          at: "2026-09-18T12:00:00Z",
        },
      ],
    },
  ],
};
it("renders inspectable preferences, historical evidence, and pause/disable controls", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["reply-learning", "default"], status);
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ReplyPreferences, { workspace: "default" }),
    ),
  );
  expect(html).toContain("Keep language plain.");
  expect(html).toContain("Repeated edits");
  expect(html).toContain("Historical example");
  expect(html).toContain("How are you approaching this?");
  expect(html).toContain("Pause learning");
  expect(html).toContain("Disable");
  client.clear();
});
it("explains paused, pending, empty, and failed states", () => {
  expect(replyLearningSummary({ ...status, enabled: false })).toContain("not used");
  expect(replyLearningSummary({ ...status, pending: true })).toContain("next refresh");
  expect(replyLearningSummary({ ...status, preferences: [] })).toContain("No active preferences");
  expect(replyLearningSummary({ ...status, error: "Will retry" })).toBe("Will retry");
});
it("associates adopted improvements with the edited variant without changing original suggestions", () => {
  const draft: ReplyDraftSet = {
    id: "generation",
    revision: 1,
    contextVersion: "v",
    read: "",
    originals: { direct: "before", technical: "detail", warm: "hello" },
    edits: { direct: "my edit", technical: "detail", warm: "hello" },
    selected: "direct",
    moves: {},
    flags: { direct: [], technical: [], warm: [] },
    setFlags: [],
    steer: "",
    generated: true,
  };
  const next = adoptReplyImprovement(draft, "technical", "improved detail", "server-id");
  expect(next.improvementIds).toEqual({ technical: ["server-id"] });
  expect(next.selected).toBe("technical");
  expect(next.originals).toEqual(draft.originals);
  expect(draft.edits.technical).toBe("detail");
  expect(next.edits.direct).toBe("my edit");
});

it("treats reordered or omitted empty improvement IDs as the same saved draft", () => {
  const d: ReplyDraftSet = {
    id: "generation",
    revision: 1,
    contextVersion: "v",
    read: "",
    originals: { direct: "before", technical: "detail", warm: "hello" },
    edits: { direct: "my edit", technical: "detail", warm: "hello" },
    selected: "direct",
    moves: {},
    flags: { direct: [], technical: [], warm: [] },
    setFlags: [],
    steer: "",
    generated: true,
  };
  expect(replyDraftFingerprint(d)).toBe(replyDraftFingerprint({ ...d, improvementIds: {} }));
  expect(replyDraftFingerprint(d)).toBe(
    replyDraftFingerprint({ ...d, improvementIds: { warm: [], direct: [], technical: [] } }),
  );
  const adopted = { ...d, improvementIds: { technical: ["a"], direct: ["b"] } };
  expect(replyDraftFingerprint(adopted)).toBe(
    replyDraftFingerprint({ ...d, improvementIds: { direct: ["b"], technical: ["a"] } }),
  );
  expect(replyDraftFingerprint(adopted)).not.toBe(replyDraftFingerprint(d));
  expect(replyDraftFingerprint({ ...d, edits: { ...d.edits, direct: "new edit" } })).not.toBe(
    replyDraftFingerprint(d),
  );
});
