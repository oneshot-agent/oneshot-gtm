import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AngleUsagePanel } from "../src/components/queue/AngleUsagePanel.tsx";

// Under `messageOpening: "mixed"` the angle editor shows how first emails
// opened next to their replies. Static render of the line the founder reads.

const usage = (sent: number, replied: number) => ({
  open: 0,
  regenerated: 0,
  rotated: 0,
  sent,
  autoSent: 0,
  replied,
});

const render = (openingUsage: Record<string, ReturnType<typeof usage>> | null) =>
  renderToStaticMarkup(
    createElement(AngleUsagePanel, {
      angleUsage: { angles: [], generated: { text: "", ...usage(0, 0) } } as never,
      draftUsage: null,
      openingUsage: openingUsage as never,
    }),
  );

describe("AngleUsagePanel opening line", () => {
  it("lists each opening with its sends and replies", () => {
    const html = render({ bet: usage(12, 1), question: usage(11, 2) });
    expect(html).toContain("opening · bet 12 sent");
    expect(html).toContain("question 11 sent");
  });

  it("is absent outside a mixed workspace", () => {
    expect(render(null)).not.toContain("opening ·");
    expect(render({})).not.toContain("opening ·");
  });
});
