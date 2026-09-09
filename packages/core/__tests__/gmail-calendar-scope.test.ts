import { describe, expect, it } from "vitest";
import {
  clearGmailTokenScope,
  hasCalendarScope,
  loadGmailTokens,
  saveGmailToken,
} from "../src/config.ts";
import { CALENDAR_READONLY_SCOPE } from "../src/gmail.ts";

// vitest.setup.ts redirects ONESHOT_GTM_HOME to a fresh temp dir per test
// file, so gmail-tokens.json here is throwaway and isolated.

describe("GmailTokenEntry.scope (issue #577)", () => {
  it("loadGmailTokens defaults scope to null for a legacy entry with no scope field", () => {
    saveGmailToken("gmail:legacy@x.dev", { refreshToken: "rt", address: "legacy@x.dev" });
    const all = loadGmailTokens();
    expect(all["gmail:legacy@x.dev"]?.scope ?? null).toBeNull();
  });

  it("round-trips a persisted scope string", () => {
    saveGmailToken("gmail:jn@x.dev", {
      refreshToken: "rt",
      address: "jn@x.dev",
      scope: `https://www.googleapis.com/auth/gmail.send ${CALENDAR_READONLY_SCOPE}`,
    });
    const all = loadGmailTokens();
    expect(all["gmail:jn@x.dev"]?.scope).toContain(CALENDAR_READONLY_SCOPE);
  });
});

describe("hasCalendarScope", () => {
  it("is false for an absent entry — never 'unknown, try anyway'", () => {
    expect(hasCalendarScope(null)).toBe(false);
    expect(hasCalendarScope(undefined)).toBe(false);
  });

  it("is false for an entry with no scope recorded (pre-#577 token)", () => {
    expect(hasCalendarScope({ refreshToken: "rt", address: "a@x.dev" })).toBe(false);
  });

  it("is false for a Gmail-only scope string", () => {
    expect(
      hasCalendarScope({
        refreshToken: "rt",
        address: "a@x.dev",
        scope: "https://www.googleapis.com/auth/gmail.send",
      }),
    ).toBe(false);
  });

  it("is true when the scope string contains calendar.readonly", () => {
    expect(
      hasCalendarScope({
        refreshToken: "rt",
        address: "a@x.dev",
        scope: `https://www.googleapis.com/auth/gmail.send ${CALENDAR_READONLY_SCOPE}`,
      }),
    ).toBe(true);
  });
});

describe("clearGmailTokenScope", () => {
  it("clears the scope without touching the refresh token", () => {
    saveGmailToken("gmail:jn@x.dev", {
      refreshToken: "rt-keep-me",
      address: "jn@x.dev",
      scope: CALENDAR_READONLY_SCOPE,
    });
    clearGmailTokenScope("gmail:jn@x.dev");
    const entry = loadGmailTokens()["gmail:jn@x.dev"];
    expect(entry?.refreshToken).toBe("rt-keep-me");
    expect(entry?.scope ?? null).toBeNull();
  });

  it("is a no-op for an identity with no stored token", () => {
    expect(() => clearGmailTokenScope("gmail:never-connected@x.dev")).not.toThrow();
  });
});
