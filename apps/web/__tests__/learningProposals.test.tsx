import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
  LearningGuidanceView,
  LearningKind,
  LearningProposalView,
} from "@oneshot-gtm/shared-types";
import { LearningProposalsCard } from "../src/components/queue/LearningProposalsCard.tsx";
import {
  angleDiff,
  changedLines,
  editableText,
  editedValue,
  kindTag,
  proposalTitle,
  valueLines,
  whyLine,
} from "../src/lib/learning.ts";
import { saveQueueFilters, validateQueueSearch } from "../src/lib/queueSearch.ts";

// Unified learning review (#813): `/queue` shows every pending learned change
// with its current value, proposed value, scope and evidence, and offers
// approve / edit-and-approve / dismiss; applied rows offer rollback. Nothing
// renders when there is nothing to review and no filter was asked for.

const base = {
  evidence: { refs: [{ type: "reply_send" as const, id: "s1" }], counts: { threads: 3 } },
  baselineKey: "",
  dedupeKey: "x",
  status: "pending" as const,
  legacy: false,
  sourceVersion: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  decidedAt: null,
  decided: null,
  appliedAt: null,
  rolledBackAt: null,
};

const ICP: LearningProposalView = {
  ...base,
  id: "icp1",
  kind: "icp",
  scope: {},
  current: "B2B fintech founders",
  proposed: "B2B fintech CTOs at Series A startups",
  evidenceSummary: "Recent approvals skew toward technical buyers.",
};
const PREF: LearningProposalView = {
  ...base,
  id: "pref1",
  kind: "preference",
  scope: { channel: "email", stage: "reply" },
  current: null,
  proposed: { instruction: "Open with the question, not a greeting", source: "edits" },
  evidenceSummary: "Three edited replies dropped the greeting.",
  evidence: {
    refs: [{ type: "reply_send", id: "s1" }],
    samples: [
      { name: "Ada", at: "2026-10-01T00:00:00Z", original: "Hi Ada, hope", sent: "Quick one:" },
    ],
  },
  legacy: true,
};
const ANGLE: LearningProposalView = {
  ...base,
  id: "ang1",
  kind: "prospect_angle",
  scope: { prospectId: 42 },
  current: { angleJson: JSON.stringify({ hook: "old hook" }), approvedAt: null },
  proposed: {
    hook: "They asked about pricing",
    nextStep: "send the pilot terms",
    doNotSay: ["guarantee"],
  },
  evidenceSummary: "Reply on 2026-10-05.",
  evidence: { refs: [{ type: "inbox_reply", id: "r1" }], method: "reply" },
};
const CAMPAIGN: LearningProposalView = {
  ...base,
  id: "camp1",
  kind: "campaign_angle",
  scope: { playName: "show-hn" },
  current: { field: "yourEdge", edge: "fast // cheap" },
  proposed: { field: "yourEdge", edge: "fast // guaranteed" },
  evidenceSummary: "cheap was rotated away 4 times and never sent.",
  evidence: { refs: [], counts: { offered: 12, sent: 3, replied: 1 }, method: "fit" },
};
const GUIDANCE: LearningGuidanceView = {
  id: "g1",
  instruction: "Keep replies under eighty words",
  source: "style",
  channel: null,
  stage: null,
  proposalId: "pref0",
  evidence: { refs: [] },
  status: "enabled",
  approvedAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

function render(
  proposals: LearningProposalView[],
  opts: { kind?: LearningKind; prospectId?: number; guidance?: LearningGuidanceView[] } = {},
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["learning-proposals", opts.kind ?? "all", opts.prospectId ?? null], {
    proposals,
  });
  client.setQueryData(["learning-guidance"], { version: 1, guidance: opts.guidance ?? [] });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(LearningProposalsCard, { kind: opts.kind, prospectId: opts.prospectId }),
    ),
  );
  client.clear();
  return html;
}

describe("LearningProposalsCard", () => {
  it("renders nothing when there is nothing to review and no filter was asked for", () => {
    expect(render([])).toBe("");
  });

  it("shows an empty note when a kind was asked for explicitly, with a way back to all", () => {
    const html = render([], { kind: "prospect_angle", prospectId: 42 });
    expect(html).toContain("Nothing is waiting for review here");
    expect(html).toContain("angle for #42");
    expect(html).toContain("show all");
    expect(html).toContain('href="/queue"');
  });

  it("renders each pending row as a tag, the changed lines, one reason and approve / dismiss", () => {
    const html = render([ICP, PREF, { ...ANGLE, scopeLabel: "Ada Lovelace" }, CAMPAIGN]);
    expect(html).toContain("4 to review");
    // No kind tabs: the tag on each row says what it is.
    expect(html).not.toContain(">All<");
    expect(html).not.toContain(">Prospect angle<");
    expect(html).not.toContain(">Campaign angles<");
    expect(html).toContain(">ICP<");
    expect(html).toContain("B2B fintech CTOs at Series A startups");
    expect(html).toContain(">Writing</span>");
    expect(html).toContain("email replies");
    expect(html).toContain("learned before review existed");
    expect(html).toContain(">Angle</span>");
    expect(html).toContain("Ada Lovelace");
    expect(html).not.toContain("#42");
    // Only the lines that differ from the active angle make the headline.
    expect(html).toContain("Hook: They asked about pricing");
    expect(html).toContain("Next step: send the pilot terms");
    expect(html).toContain(">Campaign</span>");
    expect(html).toContain("show-hn");
    expect(html).toContain("+ guaranteed");
    expect(html).toContain("− cheap");
    expect(html).toContain("hypothesis");
    // The jargon chips are gone; the reason sentence carries the evidence.
    expect(html).not.toContain("method fit");
    expect(html).not.toContain("offered 12");
    expect(html).not.toContain("source");
    expect(html).toContain("cheap was rotated away 4 times and never sent.");
    expect(html).toContain("approve");
    expect(html).toContain("dismiss");
    expect(html).not.toContain("Edit &amp; approve");
  });

  it("keeps what it was, the evidence excerpts and the edit box behind the row's details", () => {
    const html = render([ANGLE, PREF]);
    expect(html).toContain("was · edit");
    expect(html).toContain("Hook: old hook");
    expect(html).toContain("evidence · edit");
    expect(html).toContain("Suggested: Hi Ada, hope");
    expect(html).toContain("Sent: Quick one:");
    expect(html).toContain("edit before approving");
  });

  it("folds applied proposals and approved guidance into one collapsed history line", () => {
    const applied = {
      ...ICP,
      id: "icp2",
      status: "approved" as const,
      decidedAt: "2026-10-07T00:00:00Z",
      decided: "Edited ICP",
    };
    const html = render([applied], { guidance: [GUIDANCE] });
    expect(html).toContain("1 applied · 1 preference active");
    expect(html).toContain("0 to review");
    expect(html).toContain("Edited ICP");
    expect(html).toContain("edited");
    expect(html).toContain("Roll back");
    expect(html).toContain("Keep replies under eighty words");
    expect(html).toContain("all channels · all stages");
    expect(html).toContain("Disable");
    expect((html.match(/<details/g) ?? []).length).toBe(1);
  });
});

describe("learning helpers", () => {
  it("proposalTitle / editableText / editedValue are shaped per kind", () => {
    expect(proposalTitle(PREF)).toBe("Proposed writing preference · email replies");
    expect(editableText(ICP)).toEqual({ label: "ICP one-liner", value: ICP.proposed });
    expect(editableText(ANGLE).value).toBe("They asked about pricing");
    expect(editedValue(ICP, "x")).toBe("x");
    expect(editedValue(PREF, "x")).toEqual({ instruction: "x" });
    expect(editedValue(ANGLE, "x")).toEqual({ hook: "x" });
    expect(editedValue(CAMPAIGN, "a // b")).toEqual({ edge: "a // b" });
    expect(valueLines("campaign_angle", CAMPAIGN.proposed)).toEqual(["fast", "guaranteed"]);
    expect(valueLines("prospect_angle", ANGLE.current)).toEqual(["Hook: old hook"]);
  });

  it("headline, tag and reason helpers show only what changes, by kind", () => {
    expect(changedLines(ANGLE)).toEqual([
      "Hook: They asked about pricing",
      "Next step: send the pilot terms",
      "Do not say: guarantee",
    ]);
    expect(
      changedLines({
        ...ANGLE,
        current: { angleJson: JSON.stringify({ hook: "They asked about pricing" }) },
      }),
    ).toEqual(["Next step: send the pilot terms", "Do not say: guarantee"]);
    expect(changedLines({ ...ANGLE, current: null })).toEqual([
      "Hook: They asked about pricing",
      "Next step: send the pilot terms",
      "Do not say: guarantee",
    ]);
    expect(changedLines(CAMPAIGN)).toEqual(["+ guaranteed", "− cheap"]);
    expect(changedLines({ ...ICP, decided: "Edited" })).toEqual(["Edited"]);
    expect(angleDiff("fast // cheap", "fast // guaranteed")).toEqual({
      added: ["guaranteed"],
      removed: ["cheap"],
      kept: ["fast"],
    });
    expect(kindTag(ICP)).toEqual({ kind: "ICP", scope: null });
    expect(kindTag(PREF)).toEqual({ kind: "Writing", scope: "email replies" });
    expect(kindTag(ANGLE)).toEqual({ kind: "Angle", scope: "#42" });
    expect(kindTag({ ...ANGLE, scopeLabel: "Ada" })).toEqual({ kind: "Angle", scope: "Ada" });
    expect(kindTag(CAMPAIGN)).toEqual({ kind: "Campaign", scope: "show-hn" });
    expect(whyLine(PREF)).toBe(
      "Three edited replies dropped the greeting. · learned before review existed",
    );
    expect(whyLine(CAMPAIGN)).toBe("cheap was rotated away 4 times and never sent. · hypothesis");
  });

  it("queue search accepts the learning deep link and never remembers it", () => {
    expect(validateQueueSearch({ learning: "preference", prospectId: "42" })).toEqual({
      learning: "preference",
      prospectId: 42,
    });
    expect(validateQueueSearch({ learning: "nope", prospectId: "-1" })).toEqual({});
    const store = new Map<string, string>();
    saveQueueFilters(
      { status: "sent", learning: "icp", prospectId: 3 },
      { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    );
    expect(JSON.parse([...store.values()][0]!)).toEqual({ status: "sent" });
  });
});
