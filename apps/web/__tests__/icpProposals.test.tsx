import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { IcpProposalsCard } from "../src/routes/queue.tsx";
import type { IcpProposalsResult } from "@oneshot-gtm/shared-types";

// Learning-loop v2 (issue #750): `/queue` shows pending ICP rewrite
// proposals and offers approve/dismiss. Nothing renders when there is no
// pending proposal — the common case.

const PROPOSAL: IcpProposalsResult["proposals"][number] = {
  id: "p1",
  currentIcp: "B2B fintech founders",
  proposedIcp: "B2B fintech CTOs at Series A startups",
  evidenceSummary: "Recent approvals skew toward technical buyers.",
  createdAt: "2026-09-29T00:00:00.000Z",
  status: "pending",
  decidedAt: null,
};

function renderWithData(proposals: IcpProposalsResult["proposals"]): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["icp-proposals"], { proposals });
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(IcpProposalsCard)),
  );
  client.clear();
  return html;
}

describe("IcpProposalsCard", () => {
  it("renders nothing when there is no pending proposal", () => {
    expect(renderWithData([])).toBe("");
  });

  it("shows the current ICP, proposed ICP, evidence summary, and both actions", () => {
    const html = renderWithData([PROPOSAL]);
    expect(html).toContain("B2B fintech founders");
    expect(html).toContain("B2B fintech CTOs at Series A startups");
    expect(html).toContain("Recent approvals skew toward technical buyers.");
    expect(html).toContain("Approve");
    expect(html).toContain("Dismiss");
  });

  it("renders one card per pending proposal", () => {
    const second = { ...PROPOSAL, id: "p2", proposedIcp: "A different rewrite" };
    const html = renderWithData([PROPOSAL, second]);
    expect(html).toContain("B2B fintech CTOs at Series A startups");
    expect(html).toContain("A different rewrite");
  });
});
