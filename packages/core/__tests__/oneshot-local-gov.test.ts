import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The three SDK 0.32 wrappers gov-solicitation / local-registry / local-business
// run on. Each forwards its camelCase input as the SDK's snake_case option bag
// (plus the audit memo/decisionContext every paid call carries) and records a
// receipt under its own callType, so spend shows up per tool on /receipts.
// SDK + ledger singleton are mocked so no wallet/network/real ~/.oneshot-gtm.

const govSolicitationsMock = vi.hoisted(() =>
  vi.fn(async (opts: Record<string, unknown>) => ({
    status: "completed",
    results: [],
    total_found: 0,
    truncated: false,
    description_fetches: 0,
    vendor_calls: 1,
    request_id: "req_gov",
    cost: 0.03,
    _opts: opts,
  })),
);
const localSearchMock = vi.hoisted(() =>
  vi.fn(async (opts: Record<string, unknown>) => ({
    status: "completed",
    results: [],
    total_found: 0,
    truncated: false,
    vendor_calls: 1,
    request_id: "req_ls",
    cost: 0.02,
    _opts: opts,
  })),
);
const localResolveMock = vi.hoisted(() =>
  vi.fn(async (opts: Record<string, unknown>) => ({
    status: "completed",
    found: true,
    confidence: 0.91,
    result: {
      id: "loc_1",
      name: String(opts["name"]),
      domain: "franklinbbq.com",
      website: "https://franklinbbq.com",
      phone: "+1 512 555 0100",
      operating_status: "open",
      category: "bbq restaurant",
      is_chain: null,
      address: "900 E 11th St, Austin, TX 78702",
      socials: {},
      review_count: 100,
      rating: 4.8,
      latitude: null,
      longitude: null,
    },
    candidates_considered: 3,
    request_id: "req_lr",
    cost: 0.005,
    _opts: opts,
  })),
);
const h = vi.hoisted(() => ({ ledger: null as unknown as import("../src/ledger.ts").Ledger }));

vi.mock("@oneshot-agent/sdk", () => ({
  OneShot: class {
    govSolicitations = govSolicitationsMock;
    localSearch = localSearchMock;
    localResolve = localResolveMock;
  },
}));

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return { ...actual, getLedger: () => h.ledger };
});

import { Ledger } from "../src/ledger.ts";
import { govSolicitations, localResolve, localSearch } from "../src/oneshot.ts";

let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-local-gov-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  h.ledger = new Ledger(dbPath);
  process.env["AGENT_PRIVATE_KEY"] = "0xtest";
  govSolicitationsMock.mockClear();
  localSearchMock.mockClear();
  localResolveMock.mockClear();
});

afterEach(() => {
  h.ledger.close();
  delete process.env["AGENT_PRIVATE_KEY"];
  rmSync(dbPath, { force: true });
});

describe("govSolicitations", () => {
  it("forwards camelCase input as the SDK's snake_case options with the audit blob", async () => {
    await govSolicitations(
      {
        naics: ["541511", "541512"],
        noticeTypes: ["r", "p"],
        sinceDays: 45,
        agencies: ["gsa"],
        hasContact: true,
        activeOnly: true,
        includeDescription: true,
        limit: 200,
      },
      { playName: "gov-solicitation" },
    );
    expect(govSolicitationsMock).toHaveBeenCalledTimes(1);
    expect(govSolicitationsMock.mock.calls[0]![0]).toMatchObject({
      naics: ["541511", "541512"],
      notice_types: ["r", "p"],
      since_days: 45,
      agencies: ["gsa"],
      has_contact: true,
      active_only: true,
      include_description: true,
      limit: 200,
      memo: "gov-solicitation gov.solicitations",
      decisionContext: { playName: "gov-solicitation", callType: "gov.solicitations" },
    });
  });

  it("records a receipt under gov.solicitations carrying the SDK's cost and request id", async () => {
    const { receiptId, result } = await govSolicitations(
      { naics: ["541511"] },
      { playName: "gov-solicitation" },
    );
    expect(result.cost).toBe(0.03);
    const receipt = h.ledger.getReceipt(receiptId);
    expect(receipt?.call_type).toBe("gov.solicitations");
    expect(receipt?.cost_usd).toBe(0.03);
    expect(receipt?.oneshot_request_id).toBe("req_gov");
    expect(receipt?.play_name).toBe("gov-solicitation");
  });
});

describe("localSearch", () => {
  it("forwards category × location and the contactability filters as snake_case", async () => {
    await localSearch(
      {
        category: ["dental practice"],
        location: ["Austin, TX"],
        hasDomain: true,
        isChain: false,
        operatingStatus: "open",
        minRating: 4,
        limit: 500,
      },
      { playName: "free-pilot" },
    );
    expect(localSearchMock.mock.calls[0]![0]).toMatchObject({
      category: ["dental practice"],
      location: ["Austin, TX"],
      has_domain: true,
      is_chain: false,
      operating_status: "open",
      min_rating: 4,
      limit: 500,
      memo: "free-pilot local.search",
    });
  });

  it("records a receipt under local.search", async () => {
    const { receiptId } = await localSearch(
      { category: ["hvac contractor"], location: ["Denver, CO"] },
      { playName: "free-pilot" },
    );
    const receipt = h.ledger.getReceipt(receiptId);
    expect(receipt?.call_type).toBe("local.search");
    expect(receipt?.cost_usd).toBe(0.02);
  });
});

describe("localResolve", () => {
  it("forwards the name plus every locating field it was given", async () => {
    await localResolve(
      {
        name: "Franklin Barbecue",
        address: "900 E 11th St",
        city: "Austin",
        region: "TX",
        postalCode: "78702",
        phone: "+1 512 555 0100",
      },
      { playName: "new-business" },
    );
    expect(localResolveMock.mock.calls[0]![0]).toMatchObject({
      name: "Franklin Barbecue",
      address: "900 E 11th St",
      city: "Austin",
      region: "TX",
      postal_code: "78702",
      phone: "+1 512 555 0100",
      memo: "new-business local.resolve",
    });
  });

  it("records a receipt under local.resolve and returns the SDK's found/result contract untouched", async () => {
    const { receiptId, result } = await localResolve(
      { name: "Franklin Barbecue", city: "Austin" },
      { playName: "new-business" },
    );
    expect(result.found).toBe(true);
    expect(result.result?.domain).toBe("franklinbbq.com");
    expect(result.result?.operating_status).toBe("open");
    const receipt = h.ledger.getReceipt(receiptId);
    expect(receipt?.call_type).toBe("local.resolve");
    expect(receipt?.cost_usd).toBe(0.005);
  });
});
