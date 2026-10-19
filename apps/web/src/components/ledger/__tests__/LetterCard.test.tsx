import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LetterCard } from "../LetterCard.tsx";

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
