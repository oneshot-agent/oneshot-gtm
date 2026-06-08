import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Routing is the crux: a stargazer of a `competitor` repo → competitor-switch,
// of an `adjacent` repo → repo-interest. Mock the module boundaries the finder
// calls (stargazer fetch, user resolution, ICP, enrich, SDK, ledger).

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}
const enqueued: EnqueuedRow[] = [];
let icpMatch = true;
let stargazersByRepo: Record<
  string,
  Array<{ login: string; userUrl: string; starredAt: string }>
> = {};
let newestSeenByRepo: Record<string, string | null> = {};
// Per-test override of what fetchTopRepos returns. `null` simulates an API
// failure / rate-limit; `[]` simulates a user with no public repos. The call
// tracker doubles as a regression guard: candidate-repo fetching is for the
// repo-interest branch only, never for competitor-switch.
let nextFetchTopReposResult: Array<{
  name: string;
  description: string | null;
  language: string | null;
}> | null = [{ name: "agent-loop", description: "self-rewriting skills", language: "Python" }];
const fetchTopReposCalls: string[] = [];

vi.mock("../src/_stargazers.ts", () => ({
  recentStargazers: async (repo: string) => ({
    stargazers: stargazersByRepo[repo] ?? [],
    newestSeen: newestSeenByRepo[repo] ?? null,
  }),
}));
vi.mock("../src/_github-user.ts", () => ({
  fetchGitHubUser: async (login: string) => ({
    login,
    name: login,
    email: `${login}@acme.dev`,
    blogDomain: "acme.dev",
    company: "Acme",
  }),
  fetchTopRepos: async (login: string) => {
    fetchTopReposCalls.push(login);
    return nextFetchTopReposResult;
  },
}));
vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => ({ match: icpMatch, reason: icpMatch ? "fits" : "nope" }),
}));
vi.mock("../src/_enrich.ts", () => ({
  enrichVerifiedContact: async () => ({
    phone: null,
    linkedinUrl: null,
    costUsd: 0.005,
    receiptId: 1,
  }),
}));
vi.mock("../src/_dedupe.ts", () => ({ isDuplicate: () => false }));
vi.mock("../src/_findemail-prescreen.ts", () => ({ shouldSkipFindEmail: () => ({ ok: true }) }));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    findEmail: async () => ({
      result: { found: true, email: "x@acme.dev", cost: 0.01 },
      receiptId: 1,
    }),
    verifyEmail: async () => ({ result: { deliverable: true, cost: 0.005 }, receiptId: 1 }),
    getLedger: () => ({
      isQueueDuplicate: () => false,
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

const { runGitHubStarsFinder } = await import("../src/github-stars.ts");

beforeEach(() => {
  enqueued.length = 0;
  icpMatch = true;
  newestSeenByRepo = {};
  fetchTopReposCalls.length = 0;
  nextFetchTopReposResult = [
    { name: "agent-loop", description: "self-rewriting skills", language: "Python" },
  ];
  stargazersByRepo = {
    "apollographql/router": [
      { login: "alice", userUrl: "https://github.com/alice", starredAt: "2026-06-01T00:00:00Z" },
    ],
    "modelcontextprotocol/servers": [
      { login: "bob", userUrl: "https://github.com/bob", starredAt: "2026-06-01T00:00:00Z" },
    ],
  };
});
afterEach(() => vi.clearAllMocks());

describe("runGitHubStarsFinder — per-repo rel routing", () => {
  it("routes a competitor repo's stargazer to competitor-switch and an adjacent repo's to repo-interest", async () => {
    const out = await runGitHubStarsFinder({
      dryRun: false,
      yourEdge: "one SDK for the tools they wire up",
      repos: [
        { repo: "apollographql/router", rel: "competitor", label: "Apollo" },
        { repo: "modelcontextprotocol/servers", rel: "adjacent", label: "MCP" },
      ],
    });

    expect(out.candidates).toBe(2);
    expect(out.enqueued).toBe(2);

    const comp = enqueued.find((r) => r.playName === "competitor-switch");
    expect(comp).toBeDefined();
    expect(comp?.payload["competitor"]).toBe("Apollo");
    expect(String(comp?.payload["evidenceText"])).toContain(
      "Starred Apollo's repo (apollographql/router)",
    );
    expect(comp?.payload["yourEdge"]).toBe("one SDK for the tools they wire up");

    const adj = enqueued.find((r) => r.playName === "repo-interest");
    expect(adj).toBeDefined();
    expect(adj?.payload["repo"]).toBe("modelcontextprotocol/servers");
    expect(adj?.payload["repoLabel"]).toBe("MCP");
    // candidate-repo enrichment: present on repo-interest payloads, never on
    // competitor-switch (the head-on pitch leans on the starred repo alone).
    expect(adj?.payload["candidateLogin"]).toBeTruthy();
    expect(adj?.payload["candidateRepos"]).toEqual([
      { name: "agent-loop", description: "self-rewriting skills", language: "Python" },
    ]);
    expect(comp?.payload["candidateLogin"]).toBeUndefined();
    expect(comp?.payload["candidateRepos"]).toBeUndefined();
    // Call-count guard: only the adjacent stargazer (bob) triggers fetchTopRepos.
    // alice (competitor) must not — repo enrichment is repo-interest-only.
    expect(fetchTopReposCalls).toEqual(["bob"]);
  });

  it("enqueues the repo-interest row without candidateRepos when fetchTopRepos returns null (rate-limited)", async () => {
    nextFetchTopReposResult = null;
    await runGitHubStarsFinder({
      dryRun: false,
      yourEdge: "x",
      repos: [{ repo: "modelcontextprotocol/servers", rel: "adjacent", label: "MCP" }],
    });
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("repo-interest");
    expect(row.payload["candidateLogin"]).toBeTruthy();
    expect("candidateRepos" in row.payload).toBe(false);
  });

  it("keeps an empty candidateRepos array on the payload when the user has no public repos", async () => {
    nextFetchTopReposResult = [];
    await runGitHubStarsFinder({
      dryRun: false,
      yourEdge: "x",
      repos: [{ repo: "modelcontextprotocol/servers", rel: "adjacent", label: "MCP" }],
    });
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.payload["candidateRepos"]).toEqual([]);
  });

  it("enqueues an ICP-rejected row instead of a target when the filter misses", async () => {
    icpMatch = false;
    await runGitHubStarsFinder({
      dryRun: false,
      yourEdge: "x",
      repos: [{ repo: "apollographql/router", rel: "competitor", label: "Apollo" }],
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.initialStatus).toBe("rejected");
    expect(enqueued[0]?.playName).toBe("competitor-switch");
  });

  it("respects the enqueue limit", async () => {
    stargazersByRepo = {
      "o/r": Array.from({ length: 5 }, (_, i) => ({
        login: `u${i}`,
        userUrl: `https://github.com/u${i}`,
        starredAt: "2026-06-01T00:00:00Z",
      })),
    };
    const out = await runGitHubStarsFinder({
      dryRun: false,
      yourEdge: "x",
      limit: 2,
      concurrency: 1, // deterministic cap (parallel runs allow soft-cap overshoot)
      repos: [{ repo: "o/r", rel: "adjacent" }],
    });
    expect(out.enqueued).toBe(2);
  });

  it("halts with the newest-star age when the window is empty", async () => {
    stargazersByRepo = { "o/r": [] };
    newestSeenByRepo = { "o/r": new Date(Date.now() - 55 * 86_400_000).toISOString() };
    const out = await runGitHubStarsFinder({
      dryRun: false,
      yourEdge: "x",
      sinceDays: 30,
      repos: [{ repo: "o/r", rel: "adjacent" }],
    });
    expect(out.candidates).toBe(0);
    expect(out.halted).toMatch(/no stars in last 30d — newest was 5[45]d ago/);
  });
});
