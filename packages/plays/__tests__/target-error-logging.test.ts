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
      // Domain only — events.jsonl is a PII-free sink.
      to_domain: "b.dev",
      message_200: "Tool request failed",
      status_code: 403,
    });
    expect(JSON.stringify(entry?.ctx)).not.toContain("a@b.dev");
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
    expect(logged[0]?.ctx).not.toHaveProperty("to_domain");
  });

  it("truncates a huge response body instead of dumping it into the log", () => {
    logged.length = 0;
    const e = new Error("Tool request failed") as Error & { responseBody: string };
    e.responseBody = "x".repeat(5000);
    logTargetError({ playName: "luma-events", err: e });
    expect(String(logged[0]?.ctx["response_body_400"])).toHaveLength(400);
  });
});

describe("logTargetError redaction", () => {
  // Asserts on the address itself, not on "@" — stack_300 legitimately carries
  // node_modules paths like `@vitest+runner@4.1.5`.
  it("keeps the domain and drops the local part, whatever the caller passes", () => {
    for (const [to, domain] of [
      ["pat@acme.io", "acme.io"],
      ["ODD@Example.CO", "Example.CO"],
    ] as const) {
      logged.length = 0;
      logTargetError({ playName: "show-hn", to, err: new Error("x") });
      expect(logged[0]?.ctx["to_domain"], to).toBe(domain);
      expect(String(logged[0]?.ctx["to_domain"]), to).not.toContain(to.split("@")[0]);
    }
  });

  it("omits the key entirely for a value that isn't an address", () => {
    logged.length = 0;
    logTargetError({ playName: "show-hn", to: "not-an-email", err: new Error("x") });
    expect(logged[0]?.ctx).not.toHaveProperty("to_domain");
  });
});

describe("logTargetError never throws", () => {
  // It runs inside the per-target catch. A TypeError raised while logging
  // would escape that catch and abort the whole drain — the exact failure the
  // catch exists to prevent. A thrown value is `unknown`, so nothing about its
  // shape can be assumed.
  const nasty: Array<[string, unknown]> = [
    ["non-string message", { message: 500, stack: 42 }],
    ["thrown string", "just a string"],
    ["thrown number", 500],
    ["null", null],
    ["undefined", undefined],
    [
      "object with throwing getter",
      {
        get message() {
          throw new Error("boom");
        },
      },
    ],
    ["non-Error cause", new Error("outer", { cause: { code: 7 } })],
  ];

  for (const [label, err] of nasty) {
    it(`survives ${label}`, () => {
      logged.length = 0;
      expect(() => logTargetError({ playName: "show-hn", err })).not.toThrow();
      // A hostile getter costs us the log entry, never the run.
      if (label !== "object with throwing getter") {
        expect(logged).toHaveLength(1);
        expect(typeof logged[0]?.ctx["message_200"]).toBe("string");
        expect(typeof logged[0]?.ctx["stack_300"]).toBe("string");
      }
    });
  }

  it("coerces a non-string message instead of crashing", () => {
    logged.length = 0;
    logTargetError({ playName: "show-hn", err: { message: 500, stack: 42 } });
    expect(logged[0]?.ctx["message_200"]).toBe("500");
    expect(logged[0]?.ctx["stack_300"]).toBe("42");
  });

  it("tolerates a non-string recipient", () => {
    logged.length = 0;
    logTargetError({ playName: "show-hn", to: 42 as unknown as string, err: new Error("x") });
    expect(logged[0]?.ctx).not.toHaveProperty("to_domain");
  });
});
