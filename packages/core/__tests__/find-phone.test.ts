import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A phone lookup is a profile read with the phone add-on, cached as its own
// type: an enrich.profile hit carries no number. Only an answer (a number, or
// "none") is kept; an outage or a reveal still pending is asked again. The
// SDK and the ledger singleton are mocked; the shared DB is vitest.setup.ts's
// per-file temp one.

const personProfileMock = vi.hoisted(() => vi.fn());
const h = vi.hoisted(() => ({ ledger: null as unknown as import("../src/ledger.ts").Ledger }));

vi.mock("@oneshot-agent/sdk", () => ({
  OneShot: class {
    address = "0x-test-wallet";
    personProfile = personProfileMock;
  },
  ValidationError: class extends Error {},
}));

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return { ...actual, getLedger: () => h.ledger };
});

import { Ledger } from "../src/ledger.ts";
import { extractFirstPhone, findPhone, PHONE_TIMEOUT_SEC } from "../src/oneshot.ts";
import { _resetPaidCache, paidCacheKey } from "../src/paid-cache.ts";

const ctx = { playName: "test-play" };
const url = "https://www.linkedin.com/in/pat-lee/";
let path: string;

function answer(profile: Record<string, unknown>) {
  return { status: "completed", profile, request_id: "req_phone", cost: 0.1 };
}

beforeEach(() => {
  path = join(tmpdir(), `oneshot-gtm-find-phone-${Date.now()}-${Math.random()}.sqlite`);
  h.ledger = new Ledger(path);
  process.env["AGENT_PRIVATE_KEY"] = "0xtest";
  personProfileMock.mockReset();
  _resetPaidCache();
});

afterEach(() => {
  h.ledger.close();
  delete process.env["AGENT_PRIVATE_KEY"];
  rmSync(path, { force: true });
});

describe("extractFirstPhone", () => {
  it("reads fullphone before phone, and skips blanks", () => {
    expect(
      extractFirstPhone({ phone: "+1 555 0100", fullphone: [{ fullphone: "+15550199" }] }),
    ).toBe("+15550199");
    expect(extractFirstPhone({ phone: " +1 555 0100 ", fullphone: [{ fullphone: " " }] })).toBe(
      "+1 555 0100",
    );
    expect(extractFirstPhone({ fullphone: [] })).toBeNull();
  });

  it("reads deepResearch enrichment.fullphone[0].fullphone shape", () => {
    const enrichment = {
      fullphone: [{ fullphone: "+15551234567" }, { fullphone: "+15557654321" }],
    };
    expect(extractFirstPhone(enrichment)).toBe("+15551234567");
  });

  it("reads enrichProfile profile.phone shape", () => {
    expect(extractFirstPhone({ phone: "+447700900123" })).toBe("+447700900123");
  });

  it("returns null on missing shapes", () => {
    expect(extractFirstPhone(null)).toBeNull();
    expect(extractFirstPhone(undefined)).toBeNull();
    expect(extractFirstPhone({})).toBeNull();
    expect(extractFirstPhone({ phone: "" })).toBeNull();
  });

  it("trims whitespace from the returned phone", () => {
    expect(extractFirstPhone({ phone: "  +12025551212  " })).toBe("+12025551212");
  });
});

describe("the enrich.phone cache key", () => {
  it("differs from enrich.profile's for the same person", () => {
    expect(paidCacheKey("enrich.phone", { linkedinUrl: url })).not.toBe(
      paidCacheKey("enrich.profile", { linkedinUrl: url }),
    );
  });

  it("names the person by LinkedIn URL, whatever else is sent", () => {
    expect(paidCacheKey("enrich.phone", { linkedinUrl: url, email: "pat@acme.com" })).toBe(
      paidCacheKey("enrich.phone", { linkedinUrl: "https://linkedin.com/in/Pat-Lee" }),
    );
  });
});

describe("findPhone", () => {
  it("asks for the phone add-on and waits for it", async () => {
    personProfileMock.mockResolvedValue(answer({ phone: "+15550100", phone_lookup: "found" }));
    const out = await findPhone({ linkedinUrl: url }, ctx);
    expect(out).toMatchObject({ phone: "+15550100", lookup: "found", cost: 0.1 });
    expect(out.receiptId).toBeGreaterThan(0);
    const opts = personProfileMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({
      linkedin_url: url,
      includePhone: true,
      waitForPhones: true,
      phoneTimeoutSec: PHONE_TIMEOUT_SEC,
    });
    expect(opts["idempotencyKey"]).toBeUndefined();
    expect(h.ledger.listReceipts({ limit: 5 }).map((r) => r.call_type)).toEqual(["enrich.phone"]);
  });

  it.each([
    ["a number", { fullphone: [{ fullphone: "+15550100" }], phone: "+15550100" }, "found"],
    ["a number in the string-list shape", { fullphone: ["+15550100"] }, "found"],
    ["none", { phone_lookup: "none" }, "none"],
  ])("keeps %s: the second lookup is free", async (_label, profile, lookup) => {
    personProfileMock.mockResolvedValue(answer(profile));
    await findPhone({ linkedinUrl: url }, ctx);
    const again = await findPhone({ linkedinUrl: url }, ctx);
    expect(personProfileMock).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ lookup, receiptId: 0, cost: 0 });
  });

  it.each(["unavailable", "pending", "not_attempted"])(
    "does not keep %s: the second lookup asks again",
    async (said) => {
      personProfileMock.mockResolvedValue(answer({ phone_lookup: said }));
      const first = await findPhone({ linkedinUrl: url }, ctx);
      expect(first).toMatchObject({ phone: null, lookup: said });
      await findPhone({ linkedinUrl: url }, ctx);
      expect(personProfileMock).toHaveBeenCalledTimes(2);
    },
  );

  it("reads 'found' with no number on the row as no answer", async () => {
    personProfileMock.mockResolvedValue(answer({ phone_lookup: "found" }));
    expect(await findPhone({ linkedinUrl: url }, ctx)).toMatchObject({
      phone: null,
      lookup: "unavailable",
    });
    await findPhone({ linkedinUrl: url }, ctx);
    expect(personProfileMock).toHaveBeenCalledTimes(2);
  });

  it("never remembers the tool being down", async () => {
    // The SDK reports a failed job as a JobError: a definite outcome, no payment hold.
    const down = Object.assign(new Error("Job failed: This tool is temporarily unavailable"), {
      name: "JobError",
    });
    personProfileMock.mockRejectedValueOnce(down);
    await expect(findPhone({ linkedinUrl: url }, ctx)).rejects.toThrow(/temporarily unavailable/);
    personProfileMock.mockResolvedValue(answer({ phone: "+15550100", phone_lookup: "found" }));
    expect(await findPhone({ linkedinUrl: url }, ctx)).toMatchObject({ phone: "+15550100" });
  });

  it("is not answered by a cached profile read", async () => {
    personProfileMock.mockResolvedValue(answer({ full_name: "Pat Lee" }));
    const { enrichProfile } = await import("../src/oneshot.ts");
    await enrichProfile({ linkedinUrl: url }, ctx);
    personProfileMock.mockResolvedValue(answer({ phone: "+15550100", phone_lookup: "found" }));
    expect(await findPhone({ linkedinUrl: url }, ctx)).toMatchObject({ phone: "+15550100" });
    expect(personProfileMock).toHaveBeenCalledTimes(2);
  });
});
