import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerRow } from "@oneshot-gtm/core";

// A config write must never flip enablement: seeding an opt-in trigger's row
// (e.g. the /setup X card saving an engine choice before the trigger was ever
// enabled) has to respect the spec's default enablement instead of the old
// hardcoded `enabled: true`.

let stored: TriggerRow | null = null;
const upserts: Array<{ name: string; configJson: string; enabled?: boolean }> = [];
const configWrites: Array<{ name: string; json: string }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getTrigger: () => stored,
      upsertTrigger: (input: (typeof upserts)[number]) => {
        upserts.push(input);
      },
      setTriggerConfig: (name: string, json: string) => {
        configWrites.push({ name, json });
      },
    }),
  };
});

const { setTriggerConfigRoute } = await import("../src/api/triggers.ts");

const req = (body: unknown) =>
  new Request("http://localhost/api/triggers/x-reposters/config", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  stored = null;
  upserts.length = 0;
  configWrites.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("setTriggerConfigRoute", () => {
  it("seeding an opt-in trigger's row does NOT enable it", async () => {
    // x-reposters is enabledByDefault: false in the real registry.
    const res = await setTriggerConfigRoute(req({ config: { engine: "xapi" } }), {
      name: "x-reposters",
    });
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.enabled).toBe(false);
  });

  it("saving a startup source config does not enable it automatically", async () => {
    const res = await setTriggerConfigRoute(req({ config: { sinceDays: 2 } }), {
      name: "show-hn",
    });
    expect(res.status).toBe(200);
    expect(upserts[0]!.enabled).toBe(false);
  });

  it("an existing row gets a config UPDATE that leaves enablement alone", async () => {
    stored = {
      name: "x-reposters",
      last_polled_at: null,
      last_run_summary: null,
      enabled: 0,
      config_json: JSON.stringify({ engine: "twitterapiio" }),
      running_started_at: null,
    };
    const res = await setTriggerConfigRoute(req({ config: { engine: "xapi" } }), {
      name: "x-reposters",
    });
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(0);
    expect(configWrites).toEqual([
      { name: "x-reposters", json: JSON.stringify({ engine: "xapi" }) },
    ]);
  });

  it("rejects an unknown trigger and a non-object config", async () => {
    expect((await setTriggerConfigRoute(req({ config: { a: 1 } }), { name: "nope" })).status).toBe(
      404,
    );
    expect(
      (await setTriggerConfigRoute(req({ config: "str" }), { name: "x-reposters" })).status,
    ).toBe(400);
  });
});

describe("setTriggerConfigRoute — edge warnings (issue #585)", () => {
  it("warns on a single flat pitch and still saves", async () => {
    const res = await setTriggerConfigRoute(
      req({ config: { yourEdge: "single SDK + on-chain receipts cuts vendor sprawl" } }),
      { name: "github-topics" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings: string[] };
    expect(body.ok).toBe(true);
    expect(body.warnings.some((w) => w.includes("one angle only"))).toBe(true);
    expect(body.warnings.some((w) => w.includes("who it fits"))).toBe(true);
    expect(upserts).toHaveLength(1); // saved regardless
  });

  it("says nothing about a well-shaped edge, and nothing when there is no edge", async () => {
    const edge = [
      "For a founder selling to clinics and contractors — the data breaks before the copy does: email-finding tools hand back info@ or nothing. What we found: resolve a named person off the listing first.",
      "For someone in a marketing role, outbound dies on the second touch: the follow-up re-sends the first argument with a bump on top. What we found: a follow-up built on one new fact gets read.",
    ].join(" // ");
    const good = await setTriggerConfigRoute(req({ config: { yourEdge: edge } }), {
      name: "github-topics",
    });
    expect(((await good.json()) as { warnings: string[] }).warnings).toEqual([]);
    const none = await setTriggerConfigRoute(req({ config: { sinceDays: 3 } }), {
      name: "show-hn",
    });
    expect(((await none.json()) as { warnings: string[] }).warnings).toEqual([]);
  });
});

describe("setTriggerConfigRoute — design-partner-loi routing warnings (issue #705)", () => {
  it("warns when play routes to design-partner-loi but buyerType is missing", async () => {
    const res = await setTriggerConfigRoute(
      req({ config: { play: "design-partner-loi", yourEdge: "we cut integration time" } }),
      { name: "post-funding-auto" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => w.includes("buyerType must be"))).toBe(true);
  });

  it("warns when play routes to design-partner-loi but buyerType is invalid", async () => {
    const res = await setTriggerConfigRoute(
      req({
        config: {
          play: "design-partner-loi",
          yourEdge: "we cut integration time",
          buyerType: "owner-operator",
        },
      }),
      { name: "post-funding-auto" },
    );
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => w.includes("buyerType must be"))).toBe(true);
  });

  it("warns when play routes to design-partner-loi but yourEdge is missing — finding PRRT_kwDOSKzrBs6mB73_", async () => {
    const res = await setTriggerConfigRoute(
      req({ config: { play: "design-partner-loi", buyerType: "enterprise" } }),
      { name: "post-funding-auto" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings: string[] };
    expect(body.ok).toBe(true); // still saves — never a refusal
    expect(
      body.warnings.some((w) => w.includes("yourEdge is required to route to design-partner-loi")),
    ).toBe(true);
  });

  it("warns on the finder-specific edge key (yourClaim for hiring-signal), not yourEdge", async () => {
    const res = await setTriggerConfigRoute(
      req({ config: { play: "design-partner-loi", buyerType: "enterprise" } }),
      { name: "hiring-signal" },
    );
    const body = (await res.json()) as { warnings: string[] };
    expect(
      body.warnings.some((w) => w.includes("yourClaim is required to route to design-partner-loi")),
    ).toBe(true);
    expect(body.warnings.some((w) => w.includes("yourEdge is required"))).toBe(false);
  });

  it("blank/whitespace-only edge value still warns, not just missing", async () => {
    const res = await setTriggerConfigRoute(
      req({ config: { play: "design-partner-loi", buyerType: "enterprise", yourEdge: "   " } }),
      { name: "post-funding-auto" },
    );
    const body = (await res.json()) as { warnings: string[] };
    expect(
      body.warnings.some((w) => w.includes("yourEdge is required to route to design-partner-loi")),
    ).toBe(true);
  });

  it("says nothing about the edge field when play is not design-partner-loi", async () => {
    const res = await setTriggerConfigRoute(req({ config: { play: "other" } }), {
      name: "post-funding-auto",
    });
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toEqual([]);
  });

  it("no design-partner-loi routing warning once both buyerType and yourEdge are set", async () => {
    const res = await setTriggerConfigRoute(
      req({
        config: { play: "design-partner-loi", buyerType: "enterprise", yourEdge: "our edge" },
      }),
      { name: "post-funding-auto" },
    );
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => w.includes("buyerType must be"))).toBe(false);
    expect(
      body.warnings.some((w) => w.includes("is required to route to design-partner-loi")),
    ).toBe(false);
  });
});
