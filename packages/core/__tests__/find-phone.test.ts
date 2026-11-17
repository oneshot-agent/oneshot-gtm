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
import {
  extractFirstPhone,
  findPhone,
  PHONE_TIMEOUT_SEC,
  phoneOwnerMatches,
} from "../src/oneshot.ts";
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

const li = (slug: string) => `https://www.linkedin.com/in/${slug}`;

describe("phoneOwnerMatches", () => {
  it.each([
    [
      "Kevin Smith answered as Kennedy Smith",
      { linkedinUrl: li("kevin-smith-fcpa-fca-067aa13"), name: "Kevin Smith" },
      { linkedin_url: li("kennedy-smith-306838195"), full_name: "Kennedy Smith" },
    ],
    [
      "April Williams answered as Ashley Williams",
      { linkedinUrl: li("april-williams-66b38127"), name: "April Williams" },
      { linkedin_url: li("ashley-williams-2b55b5154"), full_name: "Ashley Williams" },
    ],
    [
      "another profile and no name asked",
      { linkedinUrl: li("pat-lee-1a2b3c4d") },
      { linkedin_url: li("sam-ray-9z8y7x6w"), full_name: "Sam Ray" },
    ],
    [
      "another profile that names no one",
      { linkedinUrl: li("pat-lee-1a2b3c4d"), name: "Pat Lee" },
      { linkedin_url: li("sam-ray-9z8y7x6w") },
    ],
  ])("rejects %s", (_label, input, profile) => {
    expect(phoneOwnerMatches(input, profile)).toBe(false);
  });

  it.each([
    [
      "the same slug, however the URL is written",
      { linkedinUrl: "https://www.linkedin.com/in/Pat-Lee/?trk=x", name: "Pat Lee" },
      { linkedin_url: "linkedin.com/in/pat-lee", full_name: "Patricia Leigh" },
    ],
    [
      "a name change with the same trailing id",
      { linkedinUrl: li("natasha-rodriguez-a63674108"), name: "Natasha Rodriguez" },
      { linkedin_url: li("natasha-vigo-a63674108"), full_name: "Natasha Vigo" },
    ],
    [
      "a middle initial",
      { linkedinUrl: li("noel-komatz-767758198"), name: "Noel Komatz" },
      { linkedin_url: li("noel-a-komatz-767758198"), full_name: "Noel A. Komatz" },
    ],
    [
      "a vanity URL with the same name",
      { linkedinUrl: li("jonathan-liebling-81174025"), name: "Jonathan Liebling" },
      { linkedin_url: li("jonathan-liebling"), full_name: "Jonathan Liebling" },
    ],
    [
      "a custom slug with the same name",
      { linkedinUrl: li("samanthaladams"), name: "Samantha Adams" },
      { linkedin_url: li("samantha-adams-57253426"), full_name: "Samantha Adams" },
    ],
    [
      "a lowercase name asked",
      { linkedinUrl: li("natalie-melear"), name: "natalie melear" },
      { linkedin_url: li("natalie-melear-0b1c2d3e4"), full_name: "Natalie Melear" },
    ],
    [
      "credentials after the name",
      { linkedinUrl: li("stephanie-zastrow"), name: "Stephanie Zastrow" },
      {
        linkedin_url: li("stephanie-zastrow-dds-mba-facd-32a18526"),
        full_name: "Stephanie Zastrow, DDS, MBA",
      },
    ],
    [
      "trailing credentials without a comma",
      { linkedinUrl: li("stephanie-zastrow"), name: "Stephanie Zastrow" },
      { linkedin_url: li("stephanie-zastrow-32a18526"), name: "Dr. Stephanie Zastrow DDS MBA" },
    ],
    [
      "another profile of the same name",
      { linkedinUrl: li("ann-farmer-55a27a3a3"), name: "Ann Farmer" },
      { linkedin_url: li("ann-farmer-2b96a646"), full_name: "Ann Farmer" },
    ],
    [
      "accents on one side",
      { linkedinUrl: li("jose-munoz-1a2b3c4d"), name: "Jose Munoz" },
      { linkedin_url: li("jose-munoz-5e6f7a8b"), full_name: "José Muñoz" },
    ],
    [
      "a profile that names neither a URL nor a person",
      { linkedinUrl: li("pat-lee-1a2b3c4d"), name: "Pat Lee" },
      { phone: "+15550100" },
    ],
    ["no profile at all", { linkedinUrl: li("pat-lee-1a2b3c4d") }, undefined],
  ])("accepts %s", (_label, input, profile) => {
    expect(phoneOwnerMatches(input, profile)).toBe(true);
  });

  it("does not take a short or digitless last part as an id", () => {
    expect(
      phoneOwnerMatches(
        { linkedinUrl: li("pat-lee-dds") },
        { linkedin_url: li("sam-ray-dds"), full_name: "Sam Ray" },
      ),
    ).toBe(false);
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

  it("keeps no number from another person's profile, cached or not", async () => {
    personProfileMock.mockResolvedValue(
      answer({
        linkedin_url: "https://www.linkedin.com/in/kennedy-smith-306838195",
        full_name: "Kennedy Smith",
        phone: "+15550100",
        phone_lookup: "found",
      }),
    );
    const input = {
      linkedinUrl: "https://www.linkedin.com/in/kevin-smith-fcpa-fca-067aa13",
      name: "Kevin Smith",
    };
    const first = await findPhone(input, ctx);
    expect(first).toMatchObject({ phone: null, lookup: "other_person", cost: 0.1 });
    expect(first.receiptId).toBeGreaterThan(0);
    // The answer stays cached as bought: asking again is free and says the same.
    const again = await findPhone(input, ctx);
    expect(again).toMatchObject({ phone: null, lookup: "other_person", receiptId: 0, cost: 0 });
    expect(personProfileMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the number from the same person's profile", async () => {
    personProfileMock.mockResolvedValue(
      answer({
        linkedin_url: "https://www.linkedin.com/in/pat-lee",
        full_name: "Pat Lee",
        phone: "+15550100",
        phone_lookup: "found",
      }),
    );
    expect(await findPhone({ linkedinUrl: url, name: "Pat Lee" }, ctx)).toMatchObject({
      phone: "+15550100",
      lookup: "found",
    });
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
