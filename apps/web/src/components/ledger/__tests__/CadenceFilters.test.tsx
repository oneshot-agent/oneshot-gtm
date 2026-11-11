import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CadenceFilterCounts } from "../../../lib/cadenceFilter.ts";
import { CadenceFilters } from "../CadenceFilters.tsx";

const counts = (
  o: {
    step?: Partial<CadenceFilterCounts["step"]>;
    due?: Partial<CadenceFilterCounts["due"]>;
  } = {},
): CadenceFilterCounts => ({
  step: {
    all: 1163,
    "linkedin-invite": 96,
    "linkedin-waiting": 101,
    "linkedin-message": 117,
    "linkedin-breakup": 10,
    email: 887,
    "direct-mail": 0,
    ...o.step,
  },
  due: { any: 1163, overdue: 97, soon: 40, later: 1026, "invite-expiring": 0, ...o.due },
});

const render = (c: CadenceFilterCounts, step = "all", due = "any", totals = c) =>
  renderToStaticMarkup(
    <CadenceFilters
      filter={{ step: step as never, due: due as never }}
      counts={c}
      totals={totals}
      onChange={() => {}}
    />,
  );

describe("CadenceFilters", () => {
  it("shows each step and due chip with its count, the open one pressed", () => {
    const html = render(counts(), "linkedin-message", "overdue");
    expect(html).toContain("LinkedIn message");
    expect(html).toContain("117");
    expect(html).toContain("Waiting for acceptance");
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:<[^>]+>)*LinkedIn message/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:<[^>]+>)*Overdue/);
  });

  it("hides empty step chips and Invite expiring until they hold rows", () => {
    const html = render(counts());
    expect(html).not.toContain("Direct mail");
    expect(html).not.toContain("Invite expiring");
    expect(render(counts({ due: { "invite-expiring": 4 } }))).toContain("Invite expiring");
  });

  it("keeps the open chip even at zero", () => {
    expect(render(counts(), "direct-mail")).toContain("Direct mail");
  });

  it("keeps a step chip the other filter leaves at 0, so the row never jumps", () => {
    const html = render(counts({ step: { "linkedin-breakup": 0 } }), "all", "overdue", counts());
    expect(html).toContain("LinkedIn breakup");
  });
});
