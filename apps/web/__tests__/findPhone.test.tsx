import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FindPhone } from "../src/components/queue/FindPhone.tsx";
import {
  latestPhoneLookup,
  PHONE_LOOKUP_STALE_MS,
  phoneLookupState,
} from "../src/lib/phoneLookup.ts";

// The case view's phone line: a button on an approved or sent row with a
// LinkedIn URL and no number, "Looking up…" while a lookup runs, and how the
// last one ended. A row with no LinkedIn URL says so instead of a button.

const now = Date.parse("2026-11-17T12:00:00.000Z");
const linkedinUrl = "https://www.linkedin.com/in/pat-lee";
const at = (msAgo: number) => new Date(now - msAgo).toISOString();
const state = (status: QueueRowView["status"], payload: Record<string, unknown>) =>
  phoneLookupState({ status, payload, now });

describe("latestPhoneLookup", () => {
  it("lets the server's finished read replace the running mark the server stamped", () => {
    // Both times are the server's: the page keeps the `at` the start route answered.
    const mark = { status: "running" as const, at: "2026-11-17T12:00:00.000Z" };
    const done = { status: "done" as const, at: "2026-11-17T12:01:30.000Z" };
    expect(latestPhoneLookup(mark, done)).toBe(done);
    expect(latestPhoneLookup(done, mark)).toBe(done);
    expect(latestPhoneLookup(null, mark)).toBe(mark);
  });

  it("lets a result beat a running mark stamped in the same millisecond", () => {
    const mark = { status: "running" as const, at: "2026-11-17T12:00:00.000Z" };
    const none = { status: "none" as const, at: mark.at };
    expect(latestPhoneLookup(mark, none)).toBe(none);
    expect(latestPhoneLookup(none, mark)).toBe(none);
  });
});

describe("phoneLookupState", () => {
  it("offers a lookup on approved and sent rows only", () => {
    expect(state("approved", { linkedinUrl })).toEqual({ kind: "idle" });
    expect(state("sent", { linkedinUrl })).toEqual({ kind: "idle" });
    expect(state("pending", { linkedinUrl })).toEqual({ kind: "hidden" });
    expect(state("rejected", { linkedinUrl })).toEqual({ kind: "hidden" });
  });

  it("asks for a LinkedIn URL instead of offering a lookup without one", () => {
    expect(state("approved", { email: "pat@acme.example" })).toEqual({ kind: "needs-linkedin" });
  });

  it("needs nothing for a row that already has a number", () => {
    expect(state("approved", { linkedinUrl, phone: "+15550100" })).toEqual({ kind: "hidden" });
    expect(
      state("approved", {
        linkedinUrl,
        phone: "+15550100",
        phoneLookup: { status: "done", at: at(1000) },
      }),
    ).toEqual({ kind: "found", at: at(1000) });
  });

  it("reads a running lookup as running, and one cut off long ago as worth asking again", () => {
    expect(
      state("approved", { linkedinUrl, phoneLookup: { status: "running", at: at(60_000) } }),
    ).toEqual({ kind: "running" });
    expect(
      state("approved", {
        linkedinUrl,
        phoneLookup: { status: "running", at: at(PHONE_LOOKUP_STALE_MS + 1) },
      }),
    ).toMatchObject({ kind: "retry", label: "Lookup interrupted" });
  });

  it("says how a lookup ended", () => {
    expect(
      state("approved", { linkedinUrl, phoneLookup: { status: "none", at: at(0) } }),
    ).toMatchObject({ kind: "none" });
    expect(
      state("approved", { linkedinUrl, phoneLookup: { status: "unavailable", at: at(0) } }),
    ).toMatchObject({ kind: "retry", label: "Unavailable, try again" });
    expect(
      state("approved", {
        linkedinUrl,
        phoneLookup: { status: "error", at: at(0), message: "Bad input" },
      }),
    ).toMatchObject({ kind: "retry", label: "Lookup failed: Bad input" });
  });
});

const render = (status: QueueRowView["status"], payload: Record<string, unknown>) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <FindPhone row={{ id: 7, status, payload } as unknown as QueueRowView} />
    </QueryClientProvider>,
  );

describe("FindPhone", () => {
  it("shows the button, the LinkedIn note, or nothing", () => {
    expect(render("approved", { linkedinUrl })).toContain("Find phone");
    const noLinkedin = render("approved", {});
    expect(noLinkedin).toContain("This row needs a LinkedIn URL before a phone lookup");
    expect(noLinkedin).not.toContain("Find phone");
    expect(render("pending", { linkedinUrl })).toBe("");
  });

  it("shows a lookup in progress without a button", () => {
    const html = render("approved", {
      linkedinUrl,
      phoneLookup: { status: "running", at: new Date().toISOString() },
    });
    expect(html).toContain("Looking up a phone number");
    expect(html).not.toContain("Find phone");
  });

  it("offers another try when the provider did not answer", () => {
    const html = render("approved", {
      linkedinUrl,
      phoneLookup: { status: "unavailable", at: new Date().toISOString() },
    });
    expect(html).toContain("Unavailable, try again");
    expect(html).toContain("Find phone");
  });
});
