import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IntentBadge } from "../src/components/IntentBadge.tsx";

describe("IntentBadge", () => {
  it("renders the table title, and a check-label marker only under review", () => {
    const plain = renderToStaticMarkup(<IntentBadge intent="meeting" confidence={0.84} />);
    expect(plain).toContain("Meeting");
    expect(plain).toContain("confidence 0.84");
    expect(plain).not.toContain("check label");

    const review = renderToStaticMarkup(
      <IntentBadge intent="interested" review confidence={0.38} />,
    );
    expect(review).toContain("check label");
  });

  it("renders nothing for an untriaged reply and the raw string for an unknown label", () => {
    expect(renderToStaticMarkup(<IntentBadge intent={null} />)).toBe("");
    expect(renderToStaticMarkup(<IntentBadge intent="some_future_label" />)).toContain(
      "some_future_label",
    );
  });
});
