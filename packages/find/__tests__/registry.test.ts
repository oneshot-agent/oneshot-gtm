import type { TriggerRow } from "@oneshot-gtm/core";
import { describe, expect, it } from "vitest";
import {
  checkReadiness,
  evaluateFinderApprovalHealth,
  effectiveIntervalMs,
  freshRunningStartedAtMs,
  listPageSourceErrors,
  listPageSources,
  MAX_RUN_AGE_MS,
  nextSleepMs,
  storedTriggerConfig,
  TRIGGERS,
  type TriggerRunOutcome,
  type TriggerSpec,
} from "../src/registry.ts";

describe("finder approval health", () => {
  it("defaults to a 10% threshold after 100 reviewed prospects", () => {
    const insufficient = evaluateFinderApprovalHealth({ approved: 0, reviewed: 99 });
    expect(insufficient.sufficientData).toBe(false);
    expect(insufficient.deprioritized).toBe(false);

    expect(evaluateFinderApprovalHealth({ approved: 10, reviewed: 100 }).deprioritized).toBe(false);
    expect(evaluateFinderApprovalHealth({ approved: 9, reviewed: 100 }).deprioritized).toBe(true);
  });

  it("does not deprioritize at the threshold boundary, only below it", () => {
    expect(
      evaluateFinderApprovalHealth({ approved: 2, reviewed: 10, threshold: 0.2, minSamples: 10 })
        .deprioritized,
    ).toBe(false);
    const below = evaluateFinderApprovalHealth({
      approved: 1,
      reviewed: 10,
      threshold: 0.2,
      minSamples: 10,
    });
    expect(below.deprioritized).toBe(true);
    expect(below.reason).toBe("low-approval-rate");
  });

  it("applies no penalty when reviewed data is insufficient", () => {
    const health = evaluateFinderApprovalHealth({
      approved: 0,
      reviewed: 9,
      threshold: 0.2,
      minSamples: 10,
    });
    expect(health.rate).toBe(0);
    expect(health.sufficientData).toBe(false);
    expect(health.deprioritized).toBe(false);
    expect(health.reason).toBeNull();
  });
});

describe("nextSleepMs", () => {
  it("defaults to 1h when there are no outcomes", () => {
    expect(nextSleepMs([])).toBe(60 * 60 * 1000);
  });

  it("floors at 60s when a trigger is overdue (negative nextDueInMs)", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: true, nextDueInMs: -5_000 },
      { name: "b", fired: false, nextDueInMs: 10 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(60_000);
  });

  it("ceilings at 1h even when the next-due is far in the future", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: false, nextDueInMs: 24 * 60 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(60 * 60 * 1000);
  });

  it("returns the smallest nextDueInMs inside the [60s, 1h] window", () => {
    const outcomes: TriggerRunOutcome[] = [
      { name: "a", fired: false, nextDueInMs: 10 * 60 * 1000 },
      { name: "b", fired: false, nextDueInMs: 5 * 60 * 1000 },
      { name: "c", fired: false, nextDueInMs: 30 * 60 * 1000 },
    ];
    expect(nextSleepMs(outcomes)).toBe(5 * 60 * 1000);
  });
});

describe("TRIGGERS registry", () => {
  it("exposes the expected built-in triggers", () => {
    const names = TRIGGERS.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "accelerator-batch",
      "breakup-revive",
      "civic-agenda",
      "community-buyer-threads",
      "github-stars",
      "github-topics",
      "gov-solicitation",
      "hiring-signal",
      "job-change",
      "list-page",
      "local-business",
      "local-registry",
      "luma-events",
      "podcast-guest",
      "post-funding-auto",
      "show-hn",
      "x-reposters",
    ]);
  });

  it("each trigger has a positive default interval and a run function", () => {
    for (const t of TRIGGERS) {
      expect(t.defaultIntervalMs).toBeGreaterThan(0);
      expect(typeof t.run).toBe("function");
      expect(t.defaultConfig).toBeTypeOf("object");
    }
  });

  it("opt-in triggers are disabled by default", () => {
    for (const spec of TRIGGERS) {
      expect(spec.enabledByDefault, `${spec.name} should be opt-in`).toBe(false);
    }
  });
});

describe("list-page readiness", () => {
  const spec = TRIGGERS.find((t) => t.name === "list-page")!;
  const ready = {
    sources: [
      {
        url: "https://github.com/backstage/backstage/blob/master/ADOPTERS.md",
        signal: "runs Backstage",
      },
    ],
    play: "design-partner-loi",
    buyerType: "enterprise",
    yourEdge: "For a company that runs Backstage — one paved path",
  };
  it("is ready with a source, the design-partner route and an edge", () => {
    expect(checkReadiness(spec, ready)).toEqual({ ready: true });
  });
  it("needs a usable source, the route and an edge", () => {
    expect(checkReadiness(spec, { ...ready, sources: [] }).ready).toBe(false);
    expect(
      checkReadiness(spec, { ...ready, sources: [{ url: "ftp://x", signal: "s" }] }).ready,
    ).toBe(false);
    expect(
      checkReadiness(spec, { ...ready, sources: [{ url: "https://x.example", signal: "" }] }).ready,
    ).toBe(false);
    expect(checkReadiness(spec, { ...ready, play: "" }).ready).toBe(false);
    expect(checkReadiness(spec, { ...ready, buyerType: "" }).ready).toBe(false);
    expect(checkReadiness(spec, { ...ready, yourEdge: "" }).ready).toBe(false);
  });
});

describe("list-page verify parsing", () => {
  const src = (verify: unknown) =>
    listPageSources({ sources: [{ url: "https://x.example/list", signal: "uses Y", verify }] })[0];

  it("keeps trimmed names and known via kinds, defaulting to subprocessors", () => {
    expect(src({ names: [" Browserbase ", ""] })?.verify).toEqual({
      names: ["Browserbase"],
      via: ["subprocessors"],
    });
    expect(src({ names: ["Backstage"], via: ["mentions", "dns", "mentions"] })?.verify).toEqual({
      names: ["Backstage"],
      via: ["mentions"],
    });
  });

  it("no usable names means no check", () => {
    expect(src(undefined)).not.toHaveProperty("verify");
    expect(src({ names: [" "] })).not.toHaveProperty("verify");
    expect(src("Browserbase")).not.toHaveProperty("verify");
  });
});

/** Luma sources for the readiness cases that test something else. */
const LUMA_SOURCES = { topics: ["dental"], cities: ["Austin"] };

describe("checkReadiness", () => {
  it("returns ready:true for specs without a readiness fn", () => {
    const spec: TriggerSpec = {
      name: "noop",
      defaultIntervalMs: 60_000,
      defaultConfig: {},
      run: async () => ({
        source: "test",
        candidates: 0,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 0,
        costUsd: 0,
      }),
    };
    expect(checkReadiness(spec, {})).toEqual({ ready: true });
  });

  it("returns the spec's readiness verdict when a fn is declared", () => {
    const spec: TriggerSpec = {
      name: "gated",
      defaultIntervalMs: 60_000,
      defaultConfig: { token: "" },
      readiness: (cfg) =>
        typeof cfg["token"] === "string" && cfg["token"].length > 0
          ? { ready: true }
          : { ready: false, reason: "token missing" },
      run: async () => ({
        source: "test",
        candidates: 0,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 0,
        costUsd: 0,
      }),
    };
    expect(checkReadiness(spec, { token: "" })).toEqual({ ready: false, reason: "token missing" });
    expect(checkReadiness(spec, { token: "abc" })).toEqual({ ready: true });
  });

  it("treats a throwing readiness fn as not-ready rather than crashing the caller", () => {
    const spec: TriggerSpec = {
      name: "boom",
      defaultIntervalMs: 60_000,
      defaultConfig: {},
      readiness: () => {
        throw new Error("unexpected");
      },
      run: async () => ({
        source: "test",
        candidates: 0,
        droppedIcp: 0,
        droppedDuplicate: 0,
        droppedEnrichment: 0,
        enqueued: 0,
        costUsd: 0,
      }),
    };
    const out = checkReadiness(spec, {});
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/threw/);
  });

  it("github-stars is not ready with its empty default config (repos required)", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-stars")!;
    expect(spec.readiness).toBeDefined();
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/repos/);
  });

  it("github-stars is not ready when repos lack a valid rel", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-stars")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      repos: [{ repo: "owner/name", rel: "nonsense" }],
      yourEdge: "we help",
    });
    expect(out.ready).toBe(false);
  });

  it("github-stars is not ready without yourEdge even when repos are set", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-stars")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      repos: [{ repo: "owner/name", rel: "adjacent" }],
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  it("github-stars becomes ready with a valid repo + rel + yourEdge", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-stars")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      repos: [{ repo: "apollographql/router", rel: "competitor", label: "Apollo" }],
      yourEdge: "one SDK for the tools they wire up",
    });
    expect(out).toEqual({ ready: true });
  });

  it("luma-events is not ready with its default config (topics required first)", () => {
    const spec = TRIGGERS.find((t) => t.name === "luma-events")!;
    expect(spec.readiness).toBeDefined();
    expect(spec.defaultConfig["topics"]).toEqual([]);
    expect(spec.defaultConfig["cities"]).toEqual([]);
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/topics/);
  });

  it("luma-events is not ready without yourEdge once topics and cities are set", () => {
    const spec = TRIGGERS.find((t) => t.name === "luma-events")!;
    const out = checkReadiness(spec, { ...spec.defaultConfig, ...LUMA_SOURCES });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  it("luma-events is not ready when topics is empty", () => {
    const spec = TRIGGERS.find((t) => t.name === "luma-events")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      topics: [],
      yourEdge: "a teardown",
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/topics/);
  });

  it("luma-events is not ready when cities is empty", () => {
    const spec = TRIGGERS.find((t) => t.name === "luma-events")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      ...LUMA_SOURCES,
      cities: [],
      yourEdge: "a teardown",
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/cities/);
  });

  it("luma-events is ready with calendars and no cities", () => {
    const spec = TRIGGERS.find((t) => t.name === "luma-events")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      ...LUMA_SOURCES,
      cities: [],
      calendars: ["sftw"],
      yourEdge: "a teardown",
    });
    expect(out).toEqual({ ready: true });
  });

  it("luma-events is not ready when a calendar ref can't be parsed", () => {
    const spec = TRIGGERS.find((t) => t.name === "luma-events")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      ...LUMA_SOURCES,
      calendars: ["sftw", "tech week"],
      yourEdge: "a teardown",
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toContain("'tech week'");
  });

  it("luma-events is not ready when a calendar entry is blank, even beside valid sources", () => {
    const spec = TRIGGERS.find((t) => t.name === "luma-events")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      ...LUMA_SOURCES,
      calendars: ["sftw", " "],
      yourEdge: "a teardown",
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toContain("calendars");
  });

  it("luma-events becomes ready with topics + cities + yourEdge", () => {
    const spec = TRIGGERS.find((t) => t.name === "luma-events")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      ...LUMA_SOURCES,
      yourEdge: "a 30-second teardown of how X handles Y",
    });
    expect(out).toEqual({ ready: true });
  });

  it("github-topics is not ready with its empty default config (topics required first)", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    expect(spec.readiness).toBeDefined();
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/topics/);
  });

  it("github-topics is not ready when vendors is empty even with topics set", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      topics: ["llm-agents"],
      vendors: [],
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/vendors/);
  });

  it("github-topics is not ready when fewer distinct vendors are set than minVendors", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    const base = { ...spec.defaultConfig, topics: ["observability"], yourEdge: "an edge" };
    // Default minVendors is 2: one vendor could never match a repo.
    const one = checkReadiness(spec, { ...base, vendors: ["datadog"] });
    expect(one).toEqual({
      ready: false,
      reason: "set at least 2 `vendors` (minVendors is 2; 1 set), or lower `minVendors`",
    });
    // Duplicates and blanks don't count as distinct vendors.
    expect(checkReadiness(spec, { ...base, vendors: ["Datadog", "datadog ", " "] }).ready).toBe(
      false,
    );
    // A numeric string counts as the number it spells, as it does in the run.
    const asText = checkReadiness(spec, {
      ...base,
      vendors: ["datadog", "sentry"],
      minVendors: "3",
    });
    expect(asText.ready).toBe(false);
    if (!asText.ready) expect(asText.reason).toMatch(/at least 3 `vendors`/);
    // Only blanks is the same as no vendors.
    const blanks = checkReadiness(spec, { ...base, vendors: [" ", ""] });
    expect(blanks.ready).toBe(false);
    if (!blanks.ready) expect(blanks.reason).toMatch(/^set `vendors`/);
    // The count follows a configured minVendors, which readiness never changes.
    const three = { ...base, vendors: ["datadog", "sentry"], minVendors: 3 };
    const out = checkReadiness(spec, three);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/at least 3 `vendors`/);
    expect(three.minVendors).toBe(3);
    expect(checkReadiness(spec, { ...base, vendors: ["datadog"], minVendors: 1 })).toEqual({
      ready: true,
    });
    expect(checkReadiness(spec, { ...base, vendors: ["datadog", "sentry"] })).toEqual({
      ready: true,
    });
  });

  it("github-topics is not ready when yourEdge is blank/whitespace", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      topics: ["llm-agents"],
      vendors: ["langchain", "openai"],
      yourEdge: "  \t\n  ",
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  it("github-topics becomes ready with topics, vendors, and yourEdge set", () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      topics: ["llm-agents", "ai-agent"],
      vendors: ["langchain", "openai"],
      yourEdge: "one SDK instead of six dependencies",
    });
    expect(out).toEqual({ ready: true });
  });

  it("hiring-signal is not ready with its default config (roles required first)", () => {
    const spec = TRIGGERS.find((t) => t.name === "hiring-signal")!;
    expect(spec.readiness).toBeDefined();
    expect(spec.defaultConfig["roles"]).toEqual([]);
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/roles/);
  });

  it("hiring-signal is not ready without yourClaim once roles are set", () => {
    const spec = TRIGGERS.find((t) => t.name === "hiring-signal")!;
    const out = checkReadiness(spec, { ...spec.defaultConfig, roles: ["Compliance Analyst"] });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourClaim/);
  });

  it("hiring-signal is not ready when yourClaim is blank/whitespace", () => {
    const spec = TRIGGERS.find((t) => t.name === "hiring-signal")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      roles: ["Compliance Analyst"],
      yourClaim: "  \t\n ",
    });
    expect(out.ready).toBe(false);
  });

  it("hiring-signal becomes ready once roles and yourClaim are set", () => {
    const spec = TRIGGERS.find((t) => t.name === "hiring-signal")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      roles: ["Compliance Analyst"],
      yourClaim: "we cut onboarding time for new compliance hires",
    });
    expect(out).toEqual({ ready: true });
  });

  it("x-reposters ships no lane vocabulary and no dev-signal shortcut", () => {
    const spec = TRIGGERS.find((t) => t.name === "x-reposters")!;
    expect(spec.defaultConfig).toMatchObject({
      founderKeywords: [],
      amplifierKeywords: [],
      requiresDevSignal: false,
    });
    expect(spec.configBrief).toContain("`founderKeywords`");
    expect(spec.configBrief).toContain("`requiresDevSignal`");
  });

  it("podcast-guest is not ready until podcasts are set", () => {
    const spec = TRIGGERS.find((t) => t.name === "podcast-guest")!;
    expect(spec.defaultConfig["podcasts"]).toEqual([]);
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/podcasts/);
    expect(checkReadiness(spec, { ...spec.defaultConfig, podcasts: ["  "] }).ready).toBe(false);
    expect(
      checkReadiness(spec, { ...spec.defaultConfig, podcasts: ["The Practice Owners Show"] }),
    ).toEqual({ ready: true });
  });

  it("every registered trigger is ready with its own default config (incl. opt-in declarers)", () => {
    // Regression guard. Most triggers ship ready out-of-the-box; ones that
    // require founder-supplied config (topics, etc.) ship unready by design
    // and are excluded here.
    const intentionallyUnreadyByDefault = new Set([
      // job-change joined this list once yourEdge reached the email: its
      // trigger carried the field for months while the play never read it,
      // so the Offer beat had only the product one-liner to improvise from.
      "job-change",
      "github-topics",
      "github-stars",
      "hiring-signal",
      "accelerator-batch",
      "luma-events",
      "podcast-guest",
      "local-business",
      "x-reposters",
      "gov-solicitation",
      "civic-agenda",
      "community-buyer-threads",
      "local-registry",
      "gov-solicitation",
      "civic-agenda",
      "list-page",
    ]);
    for (const spec of TRIGGERS) {
      if (intentionallyUnreadyByDefault.has(spec.name)) continue;
      expect(checkReadiness(spec, spec.defaultConfig), `${spec.name} should be ready`).toEqual({
        ready: true,
      });
    }
  });

  it("accelerator-batch is not ready when both `cohorts` and legacy `cohort` are missing", () => {
    const spec = TRIGGERS.find((t) => t.name === "accelerator-batch");
    expect(spec).toBeDefined();
    expect(spec!.readiness).toBeDefined();
    // Explicitly drop the curated default to simulate a manually-emptied config.
    const out = checkReadiness(spec!, { cohorts: [], cohort: "" });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/cohort/);
  });

  it("accelerator-batch is not ready until yourEdge is set (even with cohorts)", () => {
    const spec = TRIGGERS.find((t) => t.name === "accelerator-batch")!;
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  // The gate that USED to stand here demanded the sender's own cohort, so an
  // install with no accelerator behind it had to invent one to run the finder
  // at all, and the email then claimed a batch the founder was never in.
  // Affiliation is optional now and lives in config, never in trigger config.
  it("accelerator-batch never gates on the sender's own cohort", () => {
    const spec = TRIGGERS.find((t) => t.name === "accelerator-batch")!;
    expect(checkReadiness(spec, { ...spec.defaultConfig, yourEdge: "one true thing" })).toEqual({
      ready: true,
    });
  });

  it("accelerator-batch is still ready with the legacy single-cohort shape", () => {
    const spec = TRIGGERS.find((t) => t.name === "accelerator-batch")!;
    expect(
      checkReadiness(spec, { cohort: "yc-w26", cohortLabel: "YC W26", yourEdge: "one true thing" }),
    ).toEqual({ ready: true });
  });

  it("accelerator-batch ships with a multi-incubator default sweep", async () => {
    const spec = TRIGGERS.find((t) => t.name === "accelerator-batch")!;
    const { getAccelerator } = await import("../src/_accelerators.ts");
    const accelerators = spec.defaultConfig["accelerators"] as Array<{
      id: string;
      recent?: number;
    }>;
    expect(Array.isArray(accelerators)).toBe(true);
    // Every default is a known accelerator, resolved to its latest cohort at run time.
    for (const a of accelerators) expect(getAccelerator(a.id)).not.toBeNull();
    // Sweep must cover more than just YC. The whole point is multi-incubator.
    expect(accelerators.some((a) => a.id === "yc")).toBe(true);
    expect(accelerators.filter((a) => a.id !== "yc").length).toBeGreaterThan(0);
    expect(spec.readiness?.({ ...spec.defaultConfig, yourEdge: "e" })).toEqual({ ready: true });
  });

  it("local-registry is not ready with its empty default config (no sources)", () => {
    const spec = TRIGGERS.find((t) => t.name === "local-registry")!;
    expect(spec.readiness).toBeDefined();
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/portals|taxonomies/);
  });

  it("local-registry is not ready with a socrata portal configured but no yourEdge", () => {
    const spec = TRIGGERS.find((t) => t.name === "local-registry")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  it("local-registry becomes ready with a valid socrata portal + yourEdge", () => {
    const spec = TRIGGERS.find((t) => t.name === "local-registry")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      portals: [{ host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC licenses" }],
      yourEdge: "we set it up for free, you keep it if it works",
    });
    expect(out).toEqual({ ready: true });
  });

  it("local-registry becomes ready with taxonomies + states + yourEdge alone (no portals)", () => {
    const spec = TRIGGERS.find((t) => t.name === "local-registry")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      taxonomies: ["Dentist"],
      states: ["NY"],
      yourEdge: "we set it up for free, you keep it if it works",
    });
    expect(out).toEqual({ ready: true });
  });

  it("local-registry stays not ready when taxonomies is set but states is empty", () => {
    const spec = TRIGGERS.find((t) => t.name === "local-registry")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      taxonomies: ["Dentist"],
      states: [],
      yourEdge: "we set it up for free, you keep it if it works",
    });
    expect(out.ready).toBe(false);
  });

  it("local-registry stays not ready when entityTypes carries only an invalid value (matches run's allowlist)", () => {
    // finding: readiness accepted any non-empty string in entityTypes, but
    // `run` filters the same array against validEntityTypes. A config with
    // entityTypes: ["trucking"] (not a valid carrier/broker/freight-forwarder
    // value) and no other fmcsa key passed readiness, then normalized to an
    // empty array and reported the generic "every configured source
    // returned 0 records" instead of pointing at the invalid value.
    const spec = TRIGGERS.find((t) => t.name === "local-registry")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      entityTypes: ["trucking"],
      yourEdge: "we set it up for free, you keep it if it works",
    });
    expect(out.ready).toBe(false);
  });

  it("local-registry becomes ready with a valid entityTypes value", () => {
    const spec = TRIGGERS.find((t) => t.name === "local-registry")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      entityTypes: ["carrier"],
      yourEdge: "we set it up for free, you keep it if it works",
    });
    expect(out).toEqual({ ready: true });
  });
});

describe("gov-solicitation readiness", () => {
  it("is not ready with its default config (naics missing)", () => {
    const spec = TRIGGERS.find((t) => t.name === "gov-solicitation")!;
    expect(spec.readiness).toBeDefined();
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/naics/);
  });

  it("is not ready without yourEdge even with naics set", () => {
    const spec = TRIGGERS.find((t) => t.name === "gov-solicitation")!;
    const out = checkReadiness(spec, { ...spec.defaultConfig, naics: ["541511"] });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  it("becomes ready with naics + yourEdge — no SAM.gov key is involved any more", () => {
    // The SDK's govSolicitations carries the SAM.gov side; a stale
    // SAM_GOV_API_KEY in someone's .env must neither help nor hurt.
    delete process.env["SAM_GOV_API_KEY"];
    const spec = TRIGGERS.find((t) => t.name === "gov-solicitation")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      naics: ["541511"],
      yourEdge: "we cut integration time",
    });
    expect(out).toEqual({ ready: true });
  });

  it("defaults noticeTypes to sources-sought + presolicitation", () => {
    const spec = TRIGGERS.find((t) => t.name === "gov-solicitation")!;
    expect(spec.defaultConfig["noticeTypes"]).toEqual(["r", "p"]);
  });
});

describe("civic-agenda readiness", () => {
  it("is not ready with its default config (cities missing)", () => {
    const spec = TRIGGERS.find((t) => t.name === "civic-agenda")!;
    expect(spec.readiness).toBeDefined();
    const out = checkReadiness(spec, spec.defaultConfig);
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/cities/);
  });

  it("is not ready when keywords is empty even with cities set", () => {
    const spec = TRIGGERS.find((t) => t.name === "civic-agenda")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      cities: ["New York"],
      keywords: [],
      yourEdge: "a free pilot",
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/keywords/);
  });

  it("is not ready without yourEdge even with cities + keywords set", () => {
    const spec = TRIGGERS.find((t) => t.name === "civic-agenda")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      cities: ["New York"],
      keywords: ["AI"],
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  it("becomes ready with cities + keywords + yourEdge", () => {
    const spec = TRIGGERS.find((t) => t.name === "civic-agenda")!;
    const out = checkReadiness(spec, {
      ...spec.defaultConfig,
      cities: ["New York"],
      keywords: ["AI"],
      yourEdge: "a free pilot",
    });
    expect(out).toEqual({ ready: true });
  });
});

const cfgTestRow = (config_json: string | null): TriggerRow => ({
  name: "cfg-test",
  last_polled_at: null,
  last_run_summary: null,
  enabled: 1,
  config_json,
  running_started_at: null,
  company_batch_seq: 0,
});

describe("storedTriggerConfig — corruption fallback", () => {
  const spec: TriggerSpec = {
    name: "cfg-test",
    defaultIntervalMs: 60_000,
    defaultConfig: { limit: 25 },
    run: async () => ({
      source: "test",
      candidates: 0,
      droppedIcp: 0,
      droppedDuplicate: 0,
      droppedEnrichment: 0,
      enqueued: 0,
      costUsd: 0,
    }),
  };
  it("returns defaultConfig when there is no stored row", () => {
    expect(storedTriggerConfig(null, spec)).toEqual({ limit: 25 });
  });

  it("returns defaultConfig when config_json is null", () => {
    expect(storedTriggerConfig(cfgTestRow(null), spec)).toEqual({ limit: 25 });
  });

  it("returns the parsed stored config when valid", () => {
    expect(storedTriggerConfig(cfgTestRow('{"limit":5}'), spec)).toEqual({ limit: 5 });
  });

  it("falls back to defaultConfig on corrupt JSON instead of throwing", () => {
    expect(storedTriggerConfig(cfgTestRow("{not json"), spec)).toEqual({ limit: 25 });
  });

  it("falls back to defaultConfig on valid-but-non-object JSON", () => {
    expect(storedTriggerConfig(cfgTestRow("[1,2,3]"), spec)).toEqual({ limit: 25 });
    expect(storedTriggerConfig(cfgTestRow("42"), spec)).toEqual({ limit: 25 });
    expect(storedTriggerConfig(cfgTestRow("null"), spec)).toEqual({ limit: 25 });
  });
});

describe("effectiveIntervalMs", () => {
  it("uses defaultIntervalMs when no override is supplied", () => {
    const spec = TRIGGERS[0]!;
    expect(effectiveIntervalMs(spec, null)).toBe(spec.defaultIntervalMs);
    expect(effectiveIntervalMs(spec, {})).toBe(spec.defaultIntervalMs);
  });

  it("honors a numeric intervalMs override", () => {
    const spec = TRIGGERS[0]!;
    expect(effectiveIntervalMs(spec, { intervalMs: 90_000 })).toBe(90_000);
  });

  it("ignores a too-small or non-numeric intervalMs", () => {
    const spec = TRIGGERS[0]!;
    expect(effectiveIntervalMs(spec, { intervalMs: 1000 })).toBe(spec.defaultIntervalMs);
    expect(effectiveIntervalMs(spec, { intervalMs: "fast" })).toBe(spec.defaultIntervalMs);
  });
});

describe("freshRunningStartedAtMs — freshness gate", () => {
  const NOW = new Date("2026-04-24T19:00:00Z").getTime();

  it("returns null for null/undefined/empty", () => {
    expect(freshRunningStartedAtMs(null, NOW)).toBeNull();
    expect(freshRunningStartedAtMs(undefined, NOW)).toBeNull();
    expect(freshRunningStartedAtMs("", NOW)).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(freshRunningStartedAtMs("not a date", NOW)).toBeNull();
  });

  it("returns the start epoch when the timestamp is fresh (within window)", () => {
    const startedAt = "2026-04-24T18:55:00Z"; // 5 min before NOW
    expect(freshRunningStartedAtMs(startedAt, NOW)).toBe(new Date(startedAt).getTime());
  });

  it("returns null when the timestamp exceeds MAX_RUN_AGE_MS", () => {
    // 5 hours before NOW: well outside the 4h window.
    const startedAt = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    expect(freshRunningStartedAtMs(startedAt, NOW)).toBeNull();
  });

  it("treats the boundary as fresh (==MAX_RUN_AGE_MS) — only > is stale", () => {
    const exact = NOW - MAX_RUN_AGE_MS;
    const justFresh = new Date(exact).toISOString();
    expect(freshRunningStartedAtMs(justFresh, NOW)).toBe(exact);
    const justStale = new Date(exact - 1).toISOString();
    expect(freshRunningStartedAtMs(justStale, NOW)).toBeNull();
  });

  it("returns the start epoch when the timestamp is in the future (clock skew)", () => {
    // We don't actively defend against future timestamps: better to keep
    // the row visible than to silently hide a real run.
    const future = new Date(NOW + 60_000).toISOString();
    expect(freshRunningStartedAtMs(future, NOW)).toBe(new Date(future).getTime());
  });
});

/** A list-page config with one inline source. */
function inline(companies: unknown, extra: Record<string, unknown> = {}) {
  return { sources: [{ companies, signal: "named target account", ...extra }] };
}

describe("list-page inline companies", () => {
  it("reads companies written in the config, domains normalised", () => {
    const cfg = inline([
      { name: " Alpha ", domain: "https://www.Alpha.example/about?x=1" },
      { name: "Beta", domain: "beta.example", signal: " renewing this quarter " },
    ]);
    expect(listPageSourceErrors(cfg)).toEqual([]);
    expect(listPageSources(cfg)).toEqual([
      {
        signal: "named target account",
        companies: [
          { name: "Alpha", domain: "alpha.example" },
          { name: "Beta", domain: "beta.example", signal: "renewing this quarter" },
        ],
      },
    ]);
  });

  it("is ready with an inline source alone", () => {
    const spec = TRIGGERS.find((t) => t.name === "list-page")!;
    const cfg = {
      ...inline([{ name: "Alpha", domain: "alpha.example" }]),
      play: "design-partner-loi",
      buyerType: "enterprise",
      yourEdge: "For a named account — one paved path",
    };
    expect(checkReadiness(spec, cfg)).toEqual({ ready: true });
  });

  it("needs exactly one of url or companies", () => {
    const both = {
      sources: [
        {
          url: "https://x.example/list",
          companies: [{ name: "Alpha", domain: "alpha.example" }],
          signal: "s",
        },
      ],
    };
    const neither = { sources: [{ signal: "s" }] };
    for (const cfg of [both, neither]) {
      expect(listPageSources(cfg)).toEqual([]);
      expect(listPageSourceErrors(cfg)).toEqual([
        "sources[0]: set exactly one of `url` (a page to read) or `companies` (companies written inline)",
      ]);
    }
  });

  it("reports a company without a name or a usable domain, and runs the rest", () => {
    const cfg = inline([
      { name: "Alpha", domain: "alpha.example" },
      { name: "Beta" },
      { name: "Gamma", domain: "not a domain" },
      { domain: "delta.example" },
    ]);
    expect(listPageSourceErrors(cfg)).toEqual([
      "sources[0].companies[1] (Beta): `domain` is required (the company's own site, e.g. alpha.example)",
      "sources[0].companies[2] (Gamma): `not a domain` is not a domain (e.g. alpha.example)",
      "sources[0].companies[3]: `name` is required",
    ]);
    expect(listPageSources(cfg)[0]?.companies).toEqual([
      { name: "Alpha", domain: "alpha.example" },
    ]);
  });

  it("needs a signal and a non-empty list, and takes no verify", () => {
    expect(listPageSourceErrors({ sources: [{ companies: [], signal: "s" }] })).toEqual([
      "sources[0]: `companies` must be a non-empty list of {name, domain}",
    ]);
    const noSignal = { sources: [{ companies: [{ name: "Alpha", domain: "alpha.example" }] }] };
    expect(listPageSources(noSignal)).toEqual([]);
    expect(listPageSourceErrors(noSignal)[0]).toContain("`signal` is required");
    const verify = inline([{ name: "Alpha", domain: "alpha.example" }], {
      verify: { names: ["Tool"] },
    });
    expect(listPageSourceErrors(verify)[0]).toContain("`verify`");
    expect(listPageSources(verify)[0]).not.toHaveProperty("verify");
  });

  it("still reports a URL source that cannot run, and passes an empty list", () => {
    expect(listPageSourceErrors({ sources: [{ url: "ftp://x", signal: "s" }] })).toEqual([
      "sources[0]: `url` must be an http(s) URL",
    ]);
    expect(listPageSourceErrors({ sources: [] })).toEqual([]);
    expect(listPageSourceErrors({})).toEqual([]);
  });
});
