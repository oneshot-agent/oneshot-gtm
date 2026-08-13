import { describe, expect, it, vi } from "vitest";

// A per-target failure surfaces on the queue row as errorDraft's 80-char slice
// of err.message — for an SDK ToolError that's the generic "Tool request
// failed". The 2026-08-13 luma-events drain failed all 8 of its sends that way
// and left NOTHING in events.jsonl to diagnose from. logTargetError is what
// keeps the status code + response body, which is where the real reason lives.

const logged: Array<{ kind: string; ctx: Record<string, unknown>; level?: string }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: (kind: string, ctx: Record<string, unknown>, level?: string) => {
      logged.push({ kind, ctx, ...(level ? { level } : {}) });
    },
  };
});

const { logTargetError, errorDraft } = await import("../src/_lib.ts");

/** Shape of the OneShot SDK's ToolError: generic message, real detail alongside. */
function toolError(): Error {
  const e = new Error("Tool request failed") as Error & {
    statusCode: number;
    responseBody: string;
  };
  e.statusCode = 403;
  e.responseBody = JSON.stringify({
    error: "domain_not_owned",
    message: "Domain is owned by a different agent.",
    domain: "oneshotagent.com",
  });
  return e;
}

describe("logTargetError", () => {
  it("keeps the status code and response body the row throws away", () => {
    logged.length = 0;
    logTargetError({ playName: "luma-events", to: "a@b.dev", err: toolError() });

    expect(logged).toHaveLength(1);
    const [entry] = logged;
    expect(entry?.kind).toBe("play.target_error");
    expect(entry?.level).toBe("error");
    expect(entry?.ctx).toMatchObject({
      play: "luma-events",
      to: "a@b.dev",
      message_200: "Tool request failed",
      status_code: 403,
    });
    // The reason the founder actually needs — absent from the queue row.
    expect(String(entry?.ctx["response_body_400"])).toContain("domain_not_owned");

    // Contrast: this is all the row itself carries.
    expect(errorDraft(toolError().message).flags).toEqual(["error: Tool request failed"]);
  });

  it("records a plain Error without inventing SDK fields", () => {
    logged.length = 0;
    logTargetError({ playName: "show-hn", to: "c@d.dev", err: new Error("boom") });
    expect(logged[0]?.ctx).toMatchObject({
      play: "show-hn",
      message_200: "boom",
      status_code: null,
      response_body_400: null,
      cause_200: null,
    });
  });

  it("unwraps a nested cause", () => {
    logged.length = 0;
    const err = new Error("outer", { cause: new Error("the real reason") });
    logTargetError({ playName: "show-hn", err });
    expect(logged[0]?.ctx["cause_200"]).toBe("the real reason");
    // No recipient supplied → the key is omitted rather than logged as null.
    expect(logged[0]?.ctx).not.toHaveProperty("to");
  });

  it("truncates a huge response body instead of dumping it into the log", () => {
    logged.length = 0;
    const e = new Error("Tool request failed") as Error & { responseBody: string };
    e.responseBody = "x".repeat(5000);
    logTargetError({ playName: "luma-events", err: e });
    expect(String(logged[0]?.ctx["response_body_400"])).toHaveLength(400);
  });
});
