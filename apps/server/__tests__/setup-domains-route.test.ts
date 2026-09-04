import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainPoolEntry } from "@oneshot-gtm/core";

// The provisioned-domain list rides GET /api/setup only as a quick
// best-effort copy: the platform's listDomains has taken 60–80s, and the
// sectioned /setup page renders nothing until the status call answers. The
// status call must give up on the list fast (and answer with []), while the
// dedicated /api/setup/domains route waits longer.

let listImpl: () => Promise<DomainPoolEntry[]> = () => Promise.resolve([]);

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    listSendingDomains: () => listImpl(),
    identityCapacities: () => new Map(),
  };
});

const { getSetupDomains, getSetupStatus } = await import("../src/api/setup.ts");

const ENTRY: DomainPoolEntry = {
  domain: "mail.acme.dev",
  pool_status: "active",
  warmup_score: 80,
  daily_send_limit: 50,
  daily_sent_count: 3,
} as DomainPoolEntry;

function req(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { host: "127.0.0.1:3030" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("GET /api/setup — provisioned domains are best-effort", () => {
  it("includes the pool when the platform answers promptly", async () => {
    listImpl = () => Promise.resolve([ENTRY]);
    const res = await getSetupStatus(req("/api/setup"));
    const body = (await res.json()) as { provisionedDomains: Array<{ domain: string }> };
    expect(body.provisionedDomains).toEqual([
      {
        domain: "mail.acme.dev",
        poolStatus: "active",
        warmupScore: 80,
        dailySendLimit: 50,
        dailySentCount: 3,
      },
    ]);
  });

  it("answers with [] once the short deadline passes instead of stalling the page", async () => {
    listImpl = () => new Promise(() => {}); // hangs forever, like a slow platform
    const pending = getSetupStatus(req("/api/setup"));
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provisionedDomains: unknown[]; cfg: unknown };
    expect(body.provisionedDomains).toEqual([]);
    expect(body.cfg).toBeTruthy();
  });
});

describe("GET /api/setup/domains — the dedicated, patient route", () => {
  it("still waits past the status call's deadline", async () => {
    let resolve!: (v: DomainPoolEntry[]) => void;
    listImpl = () => new Promise<DomainPoolEntry[]>((r) => (resolve = r));
    const pending = getSetupDomains(req("/api/setup/domains"));
    await vi.advanceTimersByTimeAsync(10_000); // well past 2.5s
    resolve([ENTRY]);
    const body = (await (await pending).json()) as {
      provisionedDomains: Array<{ domain: string }>;
    };
    expect(body.provisionedDomains.map((d) => d.domain)).toEqual(["mail.acme.dev"]);
  });

  it("gives up with [] at its own deadline rather than hanging", async () => {
    listImpl = () => new Promise(() => {});
    const pending = getSetupDomains(req("/api/setup/domains"));
    await vi.advanceTimersByTimeAsync(46_000);
    const body = (await (await pending).json()) as { provisionedDomains: unknown[] };
    expect(body.provisionedDomains).toEqual([]);
  });
});
