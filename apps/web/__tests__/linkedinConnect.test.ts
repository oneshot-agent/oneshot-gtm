import { describe, expect, it } from "vitest";
import { doneFailureCopy, linkedinView } from "../src/lib/linkedinConnect.ts";

// One primary action at a time: the card never shows Connect next to Done,
// and a sign-in in progress (here or on the server) always offers Done.

const verified = {
  linkedinBrowserProfileId: "prof_a",
  linkedinSessionCheckedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  linkedinSessionName: "J. Nicolas",
  linkedinSessionInvalidAt: null,
  linkedinPendingProfileId: null,
};

describe("linkedinView", () => {
  it("connected: a check line with the name and time, only a reconnect link", () => {
    const v = linkedinView(verified, false, false);
    expect(v.phase).toBe("connected");
    expect(v.primary).toBeNull();
    expect(v.ok).toBe(true);
    expect(v.headline).toMatch(/^Connected as J\. Nicolas · checked 3h ago$/);
  });

  it("signing in wins over every other state and keeps the session usable meanwhile", () => {
    expect(linkedinView(verified, false, true)).toMatchObject({
      phase: "signing-in",
      primary: "done",
      ok: true,
    });
    // A reload mid-login: the server's pending id alone is enough to offer Done.
    expect(
      linkedinView({ ...verified, linkedinPendingProfileId: "prof_b" }, false, false),
    ).toMatchObject({ phase: "signing-in", primary: "done" });
    expect(linkedinView({ linkedinPendingProfileId: "prof_b" }, false, false)).toMatchObject({
      phase: "signing-in",
      ok: false,
    });
  });

  it("expired and idle both offer Connect, with a one-line reason", () => {
    const expired = linkedinView(
      { ...verified, linkedinSessionInvalidAt: "2026-09-16T07:38:59.000Z" },
      false,
      false,
    );
    expect(expired).toMatchObject({ phase: "expired", primary: "connect", ok: false });
    expect(expired.headline).toContain("signed you out");
    expect(linkedinView({}, false, false)).toMatchObject({ phase: "idle", primary: "connect" });
    expect(linkedinView({}, true, false).headline).toContain("cookie is saved");
  });
});

describe("doneFailureCopy", () => {
  it("keeps the server's 'not signed in yet' sentence and adds the next step otherwise", () => {
    expect(
      doneFailureCopy("not signed in yet — finish signing in in the LinkedIn tab, then click Done"),
    ).toBe("not signed in yet — finish signing in in the LinkedIn tab, then click Done.");
    expect(doneFailureCopy("LinkedIn showed the login page")).toContain(
      "click Done again, or start over",
    );
    expect(doneFailureCopy(null)).toContain("no signed-in member");
  });
});
