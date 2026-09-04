import { describe, expect, it } from "vitest";
import {
  buildIdentityPoolRequest,
  CAP_ERROR,
  capText,
  parseCap,
  parseSpendCeiling,
  validateBareDomain,
  validateEmail,
  validateRequired,
  validateTimeZone,
  type IdentityPoolStaging,
} from "../src/lib/setupValidation.ts";

describe("validateEmail", () => {
  it("is optional", () => {
    expect(validateEmail("")).toBeNull();
    expect(validateEmail("   ")).toBeNull();
  });
  it("accepts a plain address and trims", () => {
    expect(validateEmail(" jane@acme.com ")).toBeNull();
    expect(validateEmail("jane+gtm@sub.acme.co.uk")).toBeNull();
  });
  it.each(["jane", "jane@", "@acme.com", "jane@acme", "jane @acme.com", "a@b@c.com"])(
    "rejects %s",
    (v) => {
      expect(validateEmail(v)).toMatch(/enter an email/);
    },
  );
});

describe("validateBareDomain", () => {
  it("is optional", () => {
    expect(validateBareDomain("")).toBeNull();
  });
  it("accepts bare hosts", () => {
    expect(validateBareDomain("acme.com")).toBeNull();
    expect(validateBareDomain(" mail.acme-corp.io ")).toBeNull();
    expect(validateBareDomain("ACME.COM")).toBeNull();
  });
  it("names the scheme as the problem when one is present", () => {
    expect(validateBareDomain("https://acme.com")).toMatch(/drop the https/);
  });
  it.each(["acme.com/", "acme.com:8080", "jane@acme.com", "acme com"])(
    "rejects path/port/mailbox/whitespace: %s",
    (v) => {
      expect(validateBareDomain(v)).toMatch(/no path, port or mailbox/);
    },
  );
  it("rejects a bare word with no dot", () => {
    expect(validateBareDomain("localhost")).toMatch(/like acme.com/);
  });
});

describe("parseCap", () => {
  it("blank → null (uncapped) for identity rows", () => {
    expect(parseCap("", { blank: "uncapped" })).toEqual({ ok: true, value: null });
    expect(parseCap("  ", { blank: "uncapped" })).toEqual({ ok: true, value: null });
  });
  it("blank → undefined (omit → warm-up ramp) for the add-sender form", () => {
    expect(parseCap("", { blank: "omit" })).toEqual({ ok: true, value: undefined });
  });
  it("digits → integer, including 0", () => {
    expect(parseCap("40", { blank: "uncapped" })).toEqual({ ok: true, value: 40 });
    expect(parseCap(" 0 ", { blank: "omit" })).toEqual({ ok: true, value: 0 });
  });
  // The fail-open bug: every one of these used to become "uncapped".
  it.each(["abc", "-1", "1.5", "40/day", "∞", "1e3", "0x10", "99999999999999999999"])(
    "rejects %s instead of treating it as uncapped",
    (v) => {
      expect(parseCap(v, { blank: "uncapped" })).toEqual({ ok: false, error: CAP_ERROR });
    },
  );
});

describe("parseSpendCeiling", () => {
  it("blank → null (unlimited)", () => {
    expect(parseSpendCeiling("")).toEqual({ ok: true, value: null });
  });
  it("accepts a positive decimal", () => {
    expect(parseSpendCeiling(" 12.5 ")).toEqual({ ok: true, value: 12.5 });
  });
  it.each(["0", "-5", "abc", "2usd", "$2", "Infinity", "NaN"])("rejects %s", (v) => {
    expect(parseSpendCeiling(v).ok).toBe(false);
  });
});

describe("validateTimeZone", () => {
  it("is optional", () => {
    expect(validateTimeZone("")).toBeNull();
  });
  it("accepts IANA zones", () => {
    expect(validateTimeZone("Europe/Vienna")).toBeNull();
    expect(validateTimeZone(" America/New_York ")).toBeNull();
    expect(validateTimeZone("UTC")).toBeNull();
  });
  it("rejects made-up zones", () => {
    expect(validateTimeZone("Mars/Olympus")).toMatch(/unknown time zone/);
    expect(validateTimeZone("CEST")).toMatch(/unknown time zone/);
  });
});

describe("validateRequired", () => {
  it("names what is missing", () => {
    expect(validateRequired("  ", "a model")).toBe("enter a model");
    expect(validateRequired("gpt-4o-mini", "a model")).toBeNull();
  });
});

describe("capText", () => {
  it("renders null as blank and numbers verbatim", () => {
    expect(capText(null)).toBe("");
    expect(capText(0)).toBe("0");
    expect(capText(40)).toBe("40");
  });
});

describe("buildIdentityPoolRequest", () => {
  const base: IdentityPoolStaging = {
    identities: [
      { id: "oneshot:jane@mail.acme.dev", maxPerDay: 40 },
      { id: "gmail:jane@gmail.com", maxPerDay: null },
    ],
    capEdits: {},
    removedIds: [],
    pendingAdds: [],
    pendingSmartleadAdds: [],
  };

  it("nothing staged → an empty request", () => {
    expect(buildIdentityPoolRequest(base)).toEqual({ ok: true, request: {}, empty: true });
  });

  it("a cap edit equal to the stored cap is not an update", () => {
    const r = buildIdentityPoolRequest({
      ...base,
      capEdits: { "oneshot:jane@mail.acme.dev": " 40 ", "gmail:jane@gmail.com": "" },
    });
    expect(r).toEqual({ ok: true, request: {}, empty: true });
  });

  it("cap edits: number → cap, blank → null (uncapped)", () => {
    const r = buildIdentityPoolRequest({
      ...base,
      capEdits: { "oneshot:jane@mail.acme.dev": "", "gmail:jane@gmail.com": "25" },
    });
    expect(r).toEqual({
      ok: true,
      empty: false,
      request: {
        identityUpdates: [
          { id: "oneshot:jane@mail.acme.dev", maxPerDay: null },
          { id: "gmail:jane@gmail.com", maxPerDay: 25 },
        ],
      },
    });
  });

  it("a garbage cap fails the whole build with a per-row error", () => {
    const r = buildIdentityPoolRequest({
      ...base,
      capEdits: { "oneshot:jane@mail.acme.dev": "lots", "gmail:jane@gmail.com": "25" },
      removedIds: [],
    });
    expect(r).toEqual({
      ok: false,
      errors: { caps: { "oneshot:jane@mail.acme.dev": CAP_ERROR }, adds: {} },
    });
  });

  it("drops edits and removals for ids that no longer exist, and edits on removed rows", () => {
    const r = buildIdentityPoolRequest({
      ...base,
      capEdits: { "oneshot:gone@x.dev": "5", "gmail:jane@gmail.com": "nonsense" },
      removedIds: ["gmail:jane@gmail.com", "oneshot:gone@x.dev"],
    });
    // The nonsense edit is on a removed row, so it neither errors nor ships.
    expect(r).toEqual({
      ok: true,
      empty: false,
      request: { removeIdentityIds: ["gmail:jane@gmail.com"] },
    });
  });

  it("OneShot adds: blank cap omits maxPerDay (ramp), a number sets it, mailbox optional", () => {
    const r = buildIdentityPoolRequest({
      ...base,
      pendingAdds: [
        { sendingDomain: "acme.email", mailbox: "", maxPerDay: "" },
        { sendingDomain: "acme.email", mailbox: " jane ", maxPerDay: "10" },
      ],
    });
    expect(r).toEqual({
      ok: true,
      empty: false,
      request: {
        addIdentities: [
          { provider: "oneshot", sendingDomain: "acme.email" },
          { provider: "oneshot", sendingDomain: "acme.email", mailbox: "jane", maxPerDay: 10 },
        ],
      },
    });
  });

  it("a bad add cap is reported under its address", () => {
    const r = buildIdentityPoolRequest({
      ...base,
      pendingAdds: [{ sendingDomain: "acme.email", mailbox: "", maxPerDay: "ramp" }],
    });
    expect(r).toEqual({ ok: false, errors: { caps: {}, adds: { "agent@acme.email": CAP_ERROR } } });
  });

  it("Smartlead adds carry the provider cap for the server-side clamp", () => {
    const r = buildIdentityPoolRequest({
      ...base,
      pendingSmartleadAdds: [
        { address: "jane@acme.com", label: " Jane ", providerMessagePerDay: 30 },
        { address: "ops@acme.com", label: "", providerMessagePerDay: null },
      ],
    });
    expect(r).toEqual({
      ok: true,
      empty: false,
      request: {
        addIdentities: [
          {
            provider: "smartlead",
            address: "jane@acme.com",
            label: "Jane",
            providerMessagePerDay: 30,
          },
          { provider: "smartlead", address: "ops@acme.com", providerMessagePerDay: null },
        ],
      },
    });
  });

  it("everything staged ships in ONE request (atomic section save)", () => {
    const r = buildIdentityPoolRequest({
      ...base,
      capEdits: { "oneshot:jane@mail.acme.dev": "30" },
      removedIds: ["gmail:jane@gmail.com"],
      pendingAdds: [{ sendingDomain: "acme.email", mailbox: "", maxPerDay: "" }],
      pendingSmartleadAdds: [{ address: "x@y.com", label: "", providerMessagePerDay: null }],
      emailProvider: "gmail",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.request).toSorted()).toEqual([
      "addIdentities",
      "emailProvider",
      "identityUpdates",
      "removeIdentityIds",
    ]);
    expect(r.request.addIdentities).toHaveLength(2);
  });
});
