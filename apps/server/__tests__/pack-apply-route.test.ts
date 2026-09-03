import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerRow } from "@oneshot-gtm/core";

// Apply must MERGE each trigger patch over the stored config (not replace it)
// so a pre-existing hand-tuned key survives; an unknown trigger in the pack is
// skipped with a named reason rather than failing the whole apply; an unknown
// pack id is a 404; icpOneLiner in config.json is never touched.

const stored = new Map<string, TriggerRow>();
const configWrites: Array<{ name: string; json: string }> = [];
const enabledWrites: Array<{ name: string; enabled: boolean }> = [];
const upserts: Array<{ name: string; configJson: string; enabled?: boolean }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getTrigger: (name: string) => stored.get(name) ?? null,
      upsertTrigger: (input: (typeof upserts)[number]) => {
        upserts.push(input);
        stored.set(input.name, {
          name: input.name,
          last_polled_at: null,
          last_run_summary: null,
          enabled: input.enabled === false ? 0 : 1,
          config_json: input.configJson,
          running_started_at: null,
        });
      },
      setTriggerConfig: (name: string, json: string) => {
        configWrites.push({ name, json });
        const row = stored.get(name);
        if (row) row.config_json = json;
      },
      setTriggerEnabled: (name: string, enabled: boolean) => {
        enabledWrites.push({ name, enabled });
        const row = stored.get(name);
        if (row) row.enabled = enabled ? 1 : 0;
      },
    }),
  };
});

// A patch naming a trigger absent from the registry (typo, retired finder)
// must be skipped with a named reason, not fail the whole apply — inject a
// synthetic pack alongside the real ones to exercise that path without
// depending on packs.ts ever shipping a deliberately-broken entry.
vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  const brokenPack = {
    id: "broken-pack-test",
    label: "Broken Pack (test-only)",
    buyerBrief: "test",
    icpOneLiner: "test",
    triggers: {
      "show-hn": { minPoints: 1 },
      "totally-not-a-real-trigger": { foo: "bar" },
    },
    requires: [],
  };
  return {
    ...actual,
    PACKS: [...actual.PACKS, brokenPack],
    getPack: (id: string) => (id === brokenPack.id ? brokenPack : (actual.getPack(id) ?? null)),
  };
});

const { applyPackRoute, listPacksRoute } = await import("../src/api/packs.ts");

const req = () => new Request("http://localhost/api/packs/x/apply", { method: "POST" });

beforeEach(() => {
  stored.clear();
  configWrites.length = 0;
  enabledWrites.length = 0;
  upserts.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("listPacksRoute", () => {
  it("lists the placeholder pack with its trigger names and requires", async () => {
    const res = listPacksRoute(new Request("http://localhost/api/packs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packs: Array<{ id: string; triggers: string[] }> };
    expect(body.packs.length).toBeGreaterThan(0);
    const pack = body.packs.find((p) => p.id === "devtools-early-adopters");
    expect(pack).toBeDefined();
    expect(pack?.triggers).toContain("show-hn");
    expect(pack?.triggers).toContain("hiring-signal");
  });
});

describe("applyPackRoute", () => {
  it("404s on an unknown pack id", async () => {
    const res = await applyPackRoute(req(), { id: "nope" });
    expect(res.status).toBe(404);
  });

  it("merges the pack patch OVER a hand-tuned stored config, not replacing it", async () => {
    stored.set("show-hn", {
      name: "show-hn",
      last_polled_at: null,
      last_run_summary: null,
      enabled: 1,
      config_json: JSON.stringify({ maxCostUsd: 42, sinceDays: 3 }),
      running_started_at: null,
    });
    const res = await applyPackRoute(req(), { id: "devtools-early-adopters" });
    expect(res.status).toBe(200);
    const write = configWrites.find((w) => w.name === "show-hn");
    expect(write).toBeDefined();
    const merged = JSON.parse(write!.json) as Record<string, unknown>;
    // The pack's patch (minPoints) is applied…
    expect(merged["minPoints"]).toBe(1);
    // …and the founder's pre-existing hand-tuned key survives the merge.
    expect(merged["maxCostUsd"]).toBe(42);
    expect(merged["sinceDays"]).toBe(3);
  });

  it("enables every trigger the pack touches and reports readiness per trigger", async () => {
    const res = await applyPackRoute(req(), { id: "devtools-early-adopters" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: Array<{
        name: string;
        enabled: boolean;
        ready: boolean;
        notReadyReason: string | null;
      }>;
    };
    const showHn = body.applied.find((a) => a.name === "show-hn");
    expect(showHn?.enabled).toBe(true);
    expect(showHn?.ready).toBe(true);
    expect(showHn?.notReadyReason).toBeNull();

    // hiring-signal's readiness fn requires `yourClaim`, which this pack
    // deliberately leaves unset (see packs.ts `requires`) — enabled but not
    // ready is the intended end state, named plainly for the UI.
    const hiring = body.applied.find((a) => a.name === "hiring-signal");
    expect(hiring?.enabled).toBe(true);
    expect(hiring?.ready).toBe(false);
    expect(hiring?.notReadyReason).toContain("yourClaim");
  });

  it("never writes icpOneLiner into a trigger's config_json; proposes it in the response instead", async () => {
    const res = await applyPackRoute(req(), { id: "devtools-early-adopters" });
    const body = (await res.json()) as { proposedIcpOneLiner: string };
    expect(body.proposedIcpOneLiner.length).toBeGreaterThan(0);
    for (const write of configWrites) {
      expect(JSON.parse(write.json)).not.toHaveProperty("icpOneLiner");
    }
    for (const up of upserts) {
      expect(JSON.parse(up.configJson)).not.toHaveProperty("icpOneLiner");
    }
  });

  it("skips a patch naming an unknown trigger with a named reason, applies the rest", async () => {
    const res = await applyPackRoute(req(), { id: "broken-pack-test" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: Array<{ name: string }>;
      skipped: Array<{ name: string; reason: string }>;
    };
    expect(body.applied.map((a) => a.name)).toEqual(["show-hn"]);
    expect(body.skipped).toEqual([
      { name: "totally-not-a-real-trigger", reason: expect.stringContaining("unknown trigger") },
    ]);
  });
});
