import type { LiveReadSkipView, ReadProfileResult } from "@oneshot-gtm/shared-types";
import { describe, expect, it } from "vitest";
import {
  hasLinkedInSeed,
  liveReadMissing,
  liveReadNotice,
  liveReadSkipCopy,
  shouldReadOnOpen,
} from "../src/lib/liveRead.ts";

// A row opened without a live LinkedIn read is read right then; a read that
// did not happen says why in one line, or nothing when the row is fine.

const NOW = Date.parse("2026-10-20T12:00:00Z");
const PROFILE = "https://www.linkedin.com/in/ada-l";

const row = (over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  status: "pending",
  sentAt: null,
  isSending: false,
  lastDraft: null,
  payload: { name: "Ada", linkedinUrl: PROFILE, ...payload },
  ...over,
});

const research = (liveProfile?: { url: string; readAt: string }) => ({
  version: 1,
  status: "complete",
  researchedAt: "2026-10-01T00:00:00Z",
  seed: { url: PROFILE },
  organizations: [],
  ...(liveProfile ? { liveProfile } : {}),
});

describe("hasLinkedInSeed", () => {
  it("is a LinkedIn profile when the first profile field the row carries is one", () => {
    expect(hasLinkedInSeed({ linkedinUrl: PROFILE })).toBe(true);
    expect(hasLinkedInSeed({ sourceProfileUrl: "https://linkedin.com/in/x" })).toBe(true);
    expect(hasLinkedInSeed({ linkedinUrl: " ", profileUrl: PROFILE })).toBe(true);
    // The server seeds from the first field: a GitHub source wins over a later LinkedIn one.
    expect(
      hasLinkedInSeed({ sourceProfileUrl: "https://github.com/ada", authorUrl: PROFILE }),
    ).toBe(false);
    // Research's own seed is not where the server looks.
    expect(hasLinkedInSeed({ personResearch: { seed: { url: PROFILE } } })).toBe(false);
    expect(hasLinkedInSeed({ githubUrl: "https://github.com/ada" })).toBe(false);
    expect(hasLinkedInSeed({ linkedinUrl: "https://www.linkedin.com/company/acme" })).toBe(false);
    expect(hasLinkedInSeed(null)).toBe(false);
    expect(hasLinkedInSeed([PROFILE])).toBe(false);
  });
});

describe("shouldReadOnOpen", () => {
  it("reads an unsent row with a LinkedIn seed and no live read", () => {
    expect(shouldReadOnOpen(row(), NOW)).toBe(true);
    expect(shouldReadOnOpen(row({ status: "approved" }), NOW)).toBe(true);
    expect(shouldReadOnOpen(row({}, { personResearch: research() }), NOW)).toBe(true);
  });

  it("leaves a fresh live read alone and reads a stale one again", () => {
    const fresh = research({ url: PROFILE, readAt: "2026-10-18T00:00:00Z" });
    expect(shouldReadOnOpen(row({}, { personResearch: fresh }), NOW)).toBe(false);
    const stale = research({ url: PROFILE, readAt: "2026-08-01T00:00:00Z" });
    expect(shouldReadOnOpen(row({}, { personResearch: stale }), NOW)).toBe(true);
    // No usable date: read again, as the server does.
    const undated = { ...research(), liveProfile: { url: PROFILE } };
    expect(shouldReadOnOpen(row({}, { personResearch: undated }), NOW)).toBe(true);
  });

  it("never reads a row that is sent, sending, or past review", () => {
    for (const over of [
      { status: "sent" },
      { status: "rejected" },
      { status: "expired" },
      { sentAt: "2026-10-19T00:00:00Z" },
      { isSending: true },
      { lastDraft: { sent: true } },
    ]) {
      expect(shouldReadOnOpen(row(over), NOW)).toBe(false);
    }
  });

  it("never reads a row without a LinkedIn seed", () => {
    expect(
      shouldReadOnOpen(row({}, { linkedinUrl: null, githubUrl: "https://github.com/ada" }), NOW),
    ).toBe(false);
  });
});

describe("liveReadMissing", () => {
  it("marks an unsent seeded row with no live read, whatever its age", () => {
    expect(liveReadMissing(row())).toBe(true);
    const old = research({ url: PROFILE, readAt: "2026-01-01T00:00:00Z" });
    expect(liveReadMissing(row({}, { personResearch: old }))).toBe(false);
    expect(liveReadMissing(row({ status: "sent" }))).toBe(false);
    expect(liveReadMissing(row({}, { linkedinUrl: undefined }))).toBe(false);
  });
});

describe("liveReadSkipCopy", () => {
  it("says why in one line for a skip worth knowing about", () => {
    expect(liveReadSkipCopy("daily-limit")).toBe(
      "LinkedIn not read: daily limit reached — using provider history",
    );
    const loud: LiveReadSkipView[] = [
      "daily-limit",
      "cost-cap",
      "failed",
      "interrupted",
      "different-person",
      "session-invalid",
      "session-unchecked",
      "not-connected",
    ];
    const lines = loud.map(liveReadSkipCopy);
    for (const line of lines)
      expect(line).toMatch(/^LinkedIn not read: .+ — using provider history$/);
    expect(new Set(lines).size).toBe(loud.length);
  });

  it("says nothing when the row is fine as it is", () => {
    for (const s of ["fresh", "not-live", "no-seed", "not-linkedin", null] as const) {
      expect(liveReadSkipCopy(s)).toBeNull();
    }
  });
});

const result = (over: Partial<ReadProfileResult>): ReadProfileResult => ({
  read: false,
  skipped: null,
  roleChanged: false,
  redrafted: false,
  outcome: "skipped",
  ...over,
});

describe("liveReadNotice", () => {
  it("shows a re-judge reject with its reason", () => {
    expect(
      liveReadNotice(result({ read: true, outcome: "rejected", reason: "now a student" })),
    ).toEqual({ tone: "blocked", text: "Rejected after the LinkedIn read: now a student" });
  });

  it("says the offer and draft were rewritten after a role change", () => {
    expect(
      liveReadNotice(
        result({ read: true, roleChanged: true, redrafted: true, outcome: "patched" }),
      ),
    ).toMatchObject({ tone: "muted", text: expect.stringMatching(/rewritten, not sent/) });
  });

  it("is quiet after a plain read or a skip that needs no word", () => {
    expect(liveReadNotice(result({ read: true, outcome: "patched" }))).toBeNull();
    expect(liveReadNotice(result({ skipped: "fresh" }))).toBeNull();
    expect(liveReadNotice(result({ skipped: "cost-cap" }))).toEqual({
      tone: "muted",
      text: "LinkedIn not read: today's spend cap reached — using provider history",
    });
  });
});
