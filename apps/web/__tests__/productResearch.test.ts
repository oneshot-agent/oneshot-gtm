import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProductResearch } from "../src/components/queue/ProductResearch.tsx";

const privacy = vi.hoisted(() => ({ masked: false }));
vi.mock("../src/lib/privacy.tsx", () => ({ usePrivacy: () => privacy }));
const payload = {
  productResearch: {
    version: 1,
    status: "partial",
    researchedAt: "2026-09-22T21:45:16Z",
    sources: [
      {
        url: "https://example.test",
        excerpt:
          "Ask Sage\n\nSage answers from your health record.\n\n![Decorative](https://example.test/image.png)",
      },
    ],
  },
};
const render = (value: unknown) =>
  renderToStaticMarkup(createElement(ProductResearch, { payload: value }));

describe("product research evidence", () => {
  it("shows saved product names, excerpts, dates and accessible source links", () => {
    const html = render(payload);
    expect(html).toContain("Ask Sage");
    expect(html).toContain("Sage answers from your health record.");
    expect(html).toContain('href="https://example.test/"');
    expect(html).toContain("opens in a new tab");
    expect(html).toContain('dateTime="2026-09-22T21:45:16.000Z"');
    expect(html).toContain("Research is partial");
    expect(html).not.toContain("Decorative");
  });
  it("hides source content and URLs in privacy mode", () => {
    privacy.masked = true;
    try {
      const html = render(payload);
      expect(html).toContain("Research hidden in privacy mode");
      expect(html).not.toContain("Sage");
      expect(html).not.toContain("example.test");
    } finally {
      privacy.masked = false;
    }
  });
  it.each([null, {}, { productResearch: "legacy" }])(
    "supports absent or malformed legacy research",
    (value) => {
      expect(render(value)).toBe("");
    },
  );
  it("does not make unsafe source URLs clickable or render excerpt HTML", () => {
    const html = render({
      productResearch: {
        sources: [{ url: "javascript:alert(1)", excerpt: "<script>alert(1)</script>" }],
      },
    });
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Source link unavailable");
  });
  it("handles unavailable research, missing excerpts and invalid dates", () => {
    expect(render({ productResearch: { sources: [null], researchedAt: "bad" } })).toContain(
      "No saved product sources available",
    );
    expect(render({ productResearch: { sources: [{ url: "https://example.test" }] } })).toContain(
      "No saved excerpt available",
    );
  });
});
