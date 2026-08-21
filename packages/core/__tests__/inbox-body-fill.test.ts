import { describe, expect, it } from "vitest";
import { fillInboxBody } from "../src/oneshot.ts";

// The OneShot inbox returns both `body` and `body_html`; an HTML-only mail has
// an empty body and nothing used to read body_html — so /inbox rendered
// "(no body)" and triage prompted the LLM with nothing. fillInboxBody runs in
// listInbox's annotate funnel for every source.
describe("fillInboxBody", () => {
  const base = { id: "e1", from: "a@b.dev", subject: "s", received_at: "2026-08-01T00:00:00Z" };

  it("keeps an existing plain body untouched", () => {
    const e = { ...base, body: "already here", body_html: "<p>ignored</p>" };
    expect(fillInboxBody(e)).toBe(e);
  });

  it("converts body_html when body is missing", () => {
    const out = fillInboxBody({ ...base, body_html: "<p>Thursday works.</p><p>— Jane</p>" });
    expect(out.body).toBe("Thursday works.\n— Jane");
  });

  it("converts body_html when body is blank whitespace", () => {
    const out = fillInboxBody({ ...base, body: "  \n ", body_html: "<b>hi</b>" });
    expect(out.body).toBe("hi");
  });

  it("leaves the email alone when neither field has content", () => {
    const e = { ...base };
    expect(fillInboxBody(e)).toBe(e);
  });
});
