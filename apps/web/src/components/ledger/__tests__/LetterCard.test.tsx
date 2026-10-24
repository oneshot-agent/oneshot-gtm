import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftStateLine, LetterCard } from "../LetterCard.tsx";

// While a new letter is being written, the card says what is happening and
// dims the old one; idle, it shows neither.

describe("LetterCard working state", () => {
  it("names the work, marks the card busy and dims the old letter", () => {
    const html = renderToStaticMarkup(
      <LetterCard subject="s" body="b" working="Rotating to the next angle…" />,
    );
    expect(html).toContain("Rotating to the next angle…");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("opacity-50");
  });

  it("shows nothing extra when idle", () => {
    const html = renderToStaticMarkup(<LetterCard subject="s" body="b" />);
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("opacity-50");
  });
});

describe("DraftStateLine held advice", () => {
  const line = (flags: string[], hold: Parameters<typeof DraftStateLine>[0]["hold"] = {}) =>
    renderToStaticMarkup(<DraftStateLine sent={false} flags={flags} hold={hold} />);

  it("points an offer flag at the offer block, never at sending as-is", () => {
    const weak = line(["weak-offer"], { offerHeld: true, review: "regenerate" });
    expect(weak).toContain("the offer was rated a weak fit");
    expect(weak).toContain("approve the offer, pick another or rewrite it");
    expect(weak).not.toContain("send as-is");
    expect(weak.match(/weak fit/g)).toHaveLength(1);
    const none = line(["no-offer"], { offerSkipped: true });
    expect(none).toContain("the writer found no offer to make");
    expect(none).toContain("write the offer or ask for new ones");
    expect(none).not.toContain("send");
  });

  it("asks a draft-lint flag for a regenerate", () => {
    expect(line(["thin-body"])).toContain("· regenerate the draft");
  });

  it("names a writer's skip only when the page passes it (privacy off)", () => {
    expect(line(["no-offer"])).toContain("no offer could be written");
    expect(line(["no-offer"])).not.toContain("the writer found");
  });
});
