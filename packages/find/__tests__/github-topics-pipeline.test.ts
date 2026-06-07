import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counters and state shared with the mocks below. Mutate fields per test.
const calls = {
  topicSearch: 0,
  llmIcp: 0,
  detectStack: 0,
  fetchGhUser: 0,
  findEmail: 0,
  verifyEmail: 0,
  deepResearch: 0,
  enqueued: [] as Array<Record<string, unknown>>,
};

interface SearchRepo {
  url: string;
  fullName: string;
  description: string | null;
  stars: number;
  topics: string[];
  language: string | null;
  pushedAt: string;
}
let nextSearchByTopic: Record<string, SearchRepo[]> = {};
const searchTopicCalls: Array<{ topic: string }> = [];

let icpMatchResult = true;
let icpReason = "ok";
let lastIcpUserMsg = "";
/** What `detectRepoStack` should return for any candidate. Tests with mixed
 *  per-repo behavior can override per-call by mutating `nextDetectStackByRepo`. */
let nextDetectedStack: string[] = ["langchain", "twilio"];
let nextManifestsFound: string[] = ["package.json"];
const nextDetectStackByRepo: Record<string, { detected: string[]; manifestsFound: string[] }> = {};

interface MockGhUser {
  login: string;
  name: string | null;
  email: string | null;
  blogDomain: string | null;
  company: string | null;
}
/** Default GitHub user info — has all fields populated so resolveContact's
 *  Path A (extract.companyDomain → findEmail) succeeds out of the box. */
let defaultGhUser: MockGhUser | null = {
  login: "ada",
  name: "Ada Lovelace",
  email: null,
  blogDomain: "acme.dev",
  company: "Acme Agents",
};

let nextFindEmailResult: { found: boolean; email?: string; full_name?: string } = {
  found: true,
  email: "ada@acme.dev",
  full_name: "Ada",
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      telemetryEnabled: false,
      founderName: null,
      founderEmail: null,
      productOneLiner: "TestProduct SDK",
      icpOneLiner: "Engineers building agents",
      clientId: "test",
    }),
    findEmail: async () => {
      calls.findEmail++;
      return { result: { ...nextFindEmailResult, cost: 0.005 }, receiptId: 0 };
    },
    verifyEmail: async () => {
      calls.verifyEmail++;
      return { result: { deliverable: true, cost: 0.01 }, receiptId: 0 };
    },
    deepResearchPerson: async () => {
      calls.deepResearch++;
      return {
        result: {
          status: "completed",
          request_id: "test",
          completed_at: "2026-04-27T00:00:00Z",
          cost: 0.05,
          result: { enrichment: {} },
        },
        receiptId: 0,
      };
    },
    // Path B' (linkedin-via-webSearch → enrichProfile) — default to no-result
    // mocks so the existing tests don't trigger network calls.
    webSearch: async () => ({
      result: { results: [], cost: 0.01 },
      receiptId: 0,
    }),
    enrichProfile: async () => ({
      result: { status: "completed", profile: {}, cost: 0.005 },
      receiptId: 0,
    }),
    getLedger: () => ({
      isQueueDuplicate: () => false,
      isEmailPendingInQueue: () => false,
      enqueueTarget: (row: Record<string, unknown>) => {
        calls.enqueued.push(row);
        return calls.enqueued.length;
      },
      findProspectByEmail: () => null,
      recordReceipt: () => 0,
    }),
    logEvent: () => {},
    startRun: () => {},
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      // The pipeline now only calls `complete` for the ICP filter — the
      // README+LLM extract step is gone.
      const userMsg = input.messages.find((m) => m.role === "user")?.content ?? "";
      calls.llmIcp++;
      lastIcpUserMsg = userMsg;
      return {
        content: JSON.stringify({ match: icpMatchResult, reason: icpReason }),
        provider: "test",
        model: "test",
      };
    },
  };
});

vi.mock("../src/_github-user.ts", () => {
  return {
    fetchGitHubUser: async () => {
      calls.fetchGhUser++;
      return defaultGhUser;
    },
    ownerFromRepoUrl: (url: string) => {
      const m = url.match(/^https?:\/\/github\.com\/([^/]+)/i);
      return m ? (m[1] as string) : null;
    },
    repoNameFromRepoUrl: (url: string) => {
      const m = url.match(/^https?:\/\/github\.com\/[^/]+\/([^/]+)/i);
      return m ? (m[1] as string) : null;
    },
  };
});

vi.mock("../src/_repo-stack.ts", () => {
  return {
    detectRepoStack: async (args: { owner: string; repo: string }) => {
      calls.detectStack++;
      const key = `${args.owner}/${args.repo}`;
      if (key in nextDetectStackByRepo) {
        return nextDetectStackByRepo[key];
      }
      return { detected: nextDetectedStack, manifestsFound: nextManifestsFound };
    },
  };
});

vi.mock("../src/_github-search.ts", () => {
  return {
    searchTopicRepos: async (args: { topic: string }) => {
      calls.topicSearch++;
      searchTopicCalls.push({ topic: args.topic });
      return nextSearchByTopic[args.topic] ?? [];
    },
    isoDateNDaysAgo: () => "2026-01-27",
    githubHeaders: () => ({ Accept: "application/vnd.github+json" }),
  };
});

const { runGitHubTopicsFinder } = await import("../src/github-topics.ts");

beforeEach(() => {
  calls.topicSearch = 0;
  calls.llmIcp = 0;
  calls.detectStack = 0;
  calls.fetchGhUser = 0;
  calls.findEmail = 0;
  calls.verifyEmail = 0;
  calls.deepResearch = 0;
  calls.enqueued = [];
  searchTopicCalls.length = 0;
  nextSearchByTopic = {};
  icpMatchResult = true;
  icpReason = "ok";
  lastIcpUserMsg = "";
  nextDetectedStack = ["langchain", "twilio"];
  nextManifestsFound = ["package.json"];
  for (const k of Object.keys(nextDetectStackByRepo)) delete nextDetectStackByRepo[k];
  defaultGhUser = {
    login: "ada",
    name: "Ada Lovelace",
    email: null,
    blogDomain: "acme.dev",
    company: "Acme Agents",
  };
  nextFindEmailResult = { found: true, email: "ada@acme.dev", full_name: "Ada" };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseOpts = {
  dryRun: false as const,
  topics: ["llm-agents", "ai-agent"],
  vendors: ["langchain", "openai", "anthropic", "twilio", "stripe"],
  yourEdge: "TestProduct bundles every vendor into one signed action.",
  limit: 25,
  maxCostUsd: 5,
};

function makeRepo(url: string, overrides: Partial<SearchRepo> = {}): SearchRepo {
  const fullName = url.replace(/^https?:\/\/github\.com\//i, "");
  return {
    url,
    fullName,
    description: "A real agent repo",
    stars: 50,
    topics: ["llm-agents"],
    language: "Python",
    pushedAt: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

describe("github-topics — unconfigured paths", () => {
  it("halts when topics is empty", async () => {
    const out = await runGitHubTopicsFinder({ ...baseOpts, topics: [] });
    expect(out.halted).toMatch(/unconfigured.*topics/i);
    expect(out.candidates).toBe(0);
  });

  it("halts when vendors is empty", async () => {
    const out = await runGitHubTopicsFinder({ ...baseOpts, vendors: [] });
    expect(out.halted).toMatch(/unconfigured.*vendors/i);
  });

  it("halts when yourEdge is blank/whitespace", async () => {
    const out = await runGitHubTopicsFinder({ ...baseOpts, yourEdge: "  \n\t  " });
    expect(out.halted).toMatch(/unconfigured.*yourEdge/i);
  });
});

describe("github-topics — discovery", () => {
  it("calls searchTopicRepos once per topic", async () => {
    nextSearchByTopic = { "llm-agents": [], "ai-agent": [] };
    await runGitHubTopicsFinder(baseOpts);
    expect(calls.topicSearch).toBe(2);
    expect(searchTopicCalls.map((c) => c.topic)).toEqual(["llm-agents", "ai-agent"]);
  });

  it("dedupes a repo that appears in multiple topics", async () => {
    const repo = makeRepo("https://github.com/ada/agent");
    nextSearchByTopic = {
      "llm-agents": [repo],
      "ai-agent": [repo],
    };
    const out = await runGitHubTopicsFinder(baseOpts);
    // Single ICP + single stack-scan proves discovery dedupe.
    expect(calls.llmIcp).toBe(1);
    expect(calls.detectStack).toBe(1);
    expect(out.candidates).toBe(1);
  });

  it("filters awesome-list / tutorial repos via looksLikeNoiseRepo", async () => {
    nextSearchByTopic = {
      "llm-agents": [
        makeRepo("https://github.com/sindresorhus/awesome-llm"),
        makeRepo("https://github.com/foo/langchain-tutorial"),
        makeRepo("https://github.com/ada/agent"),
      ],
    };
    const out = await runGitHubTopicsFinder({ ...baseOpts, topics: ["llm-agents"] });
    expect(out.candidates).toBe(1); // only ada/agent survives
  });

  it("stops fetching new topics once hits >= limit*2", async () => {
    nextSearchByTopic = {
      "llm-agents": Array.from({ length: 60 }, (_, i) => makeRepo(`https://github.com/repo${i}/x`)),
      "ai-agent": [makeRepo("https://github.com/extra/repo")],
    };
    await runGitHubTopicsFinder({ ...baseOpts, limit: 25 });
    expect(calls.topicSearch).toBe(1);
  });
});

describe("github-topics — pipeline ordering", () => {
  it("rejects an awesome-list candidate via snippet ICP without scanning the stack", async () => {
    nextSearchByTopic = {
      "llm-agents": [makeRepo("https://github.com/realrepo/agent", { topics: ["llm-agents"] })],
    };
    icpMatchResult = false;
    icpReason = "this is a tutorial, not a buyer";
    const out = await runGitHubTopicsFinder({ ...baseOpts, topics: ["llm-agents"] });
    expect(calls.llmIcp).toBe(1);
    expect(calls.detectStack).toBe(0); // ICP-rejected → skip the GitHub API scan
    expect(calls.fetchGhUser).toBe(0);
    expect(out.droppedIcp).toBe(1);
    expect(calls.enqueued[0]?.["initialStatus"]).toBe("rejected");
  });

  it("happy path: ICP → manifest scan + GitHub user → findEmail → verify → enqueue", async () => {
    nextSearchByTopic = {
      "llm-agents": [makeRepo("https://github.com/ada/agent")],
    };
    const out = await runGitHubTopicsFinder({ ...baseOpts, topics: ["llm-agents"] });
    expect(calls.llmIcp).toBe(1);
    expect(calls.detectStack).toBe(1); // manifest scan replaces webRead+LLM extract
    expect(calls.fetchGhUser).toBeGreaterThanOrEqual(1);
    expect(calls.findEmail).toBe(1);
    expect(calls.verifyEmail).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(calls.enqueued[0]?.["notes"]).toMatch(/^github-topic:/);
  });

  it("enqueues a stack-consolidation target — vendorStack, no competitor, no fabricated 'auth surfaces'", async () => {
    nextSearchByTopic = {
      "llm-agents": [makeRepo("https://github.com/ada/agent")],
    };
    nextDetectedStack = ["playwright", "ses", "tavily"];
    const out = await runGitHubTopicsFinder({ ...baseOpts, topics: ["llm-agents"] });
    expect(out.enqueued).toBe(1);
    const row = calls.enqueued[0] ?? {};
    expect(row["playName"]).toBe("stack-consolidation");
    const payload = row["payload"] as Record<string, unknown>;
    expect(payload["vendorStack"]).toBe("playwright, ses, tavily");
    expect(payload).not.toHaveProperty("competitor");
    expect(payload).not.toHaveProperty("evidenceText");
    // The old hardcoded template fabricated "N separate auth surfaces" for
    // every target regardless of what the vendors actually were.
    expect(JSON.stringify(payload)).not.toMatch(/auth surface/i);
  });

  it("routes to competitor-switch when a detected vendor is on directCompetitors", async () => {
    nextSearchByTopic = { "llm-agents": [makeRepo("https://github.com/ada/agent")] };
    nextDetectedStack = ["langchain", "twilio"];
    const out = await runGitHubTopicsFinder({
      ...baseOpts,
      topics: ["llm-agents"],
      directCompetitors: ["twilio"],
    });
    expect(out.enqueued).toBe(1);
    const row = calls.enqueued[0] ?? {};
    expect(row["playName"]).toBe("competitor-switch");
    const payload = row["payload"] as Record<string, unknown>;
    expect(payload["competitor"]).toBe("twilio");
    expect(typeof payload["evidenceText"]).toBe("string");
    expect(payload).not.toHaveProperty("vendorStack");
    expect(JSON.stringify(payload)).not.toMatch(/auth surface/i);
  });

  it("stays stack-consolidation when no detected vendor is on directCompetitors", async () => {
    nextSearchByTopic = { "llm-agents": [makeRepo("https://github.com/ada/agent")] };
    nextDetectedStack = ["langchain", "twilio"];
    const out = await runGitHubTopicsFinder({
      ...baseOpts,
      topics: ["llm-agents"],
      directCompetitors: ["pinecone"],
    });
    expect(out.enqueued).toBe(1);
    expect(calls.enqueued[0]?.["playName"]).toBe("stack-consolidation");
  });

  it("ICP snippet summary embeds the repo's topic tags (not vendors)", async () => {
    nextSearchByTopic = {
      "llm-agents": [
        makeRepo("https://github.com/ada/agent", {
          topics: ["llm-agents", "rag", "openai"],
          description: "An RAG agent.",
        }),
      ],
    };
    icpMatchResult = false; // short-circuit
    await runGitHubTopicsFinder({ ...baseOpts, topics: ["llm-agents"] });
    expect(lastIcpUserMsg).toContain("topics: llm-agents, rag, openai");
    expect(lastIcpUserMsg).not.toMatch(/\bvendors:/);
  });
});

describe("github-topics — minVendors gate", () => {
  it("drops candidates whose detected stack is below minVendors", async () => {
    nextSearchByTopic = { "llm-agents": [makeRepo("https://github.com/ada/agent")] };
    nextDetectedStack = ["langchain"]; // only 1 vendor — below minVendors=2
    const out = await runGitHubTopicsFinder({ ...baseOpts, topics: ["llm-agents"], minVendors: 2 });
    expect(out.droppedEnrichment).toBe(1);
    expect(calls.findEmail).toBe(0); // never reached resolveContact
  });

  it("lets candidates through when stack length >= minVendors", async () => {
    nextSearchByTopic = { "llm-agents": [makeRepo("https://github.com/ada/agent")] };
    nextDetectedStack = ["langchain", "twilio", "openai"];
    const out = await runGitHubTopicsFinder({ ...baseOpts, topics: ["llm-agents"], minVendors: 2 });
    expect(out.enqueued).toBe(1);
  });
});

describe("github-topics — registry exposure", () => {
  it("the github-topics finder is wired through the registry", async () => {
    const { TRIGGERS } = await import("../src/registry.ts");
    const spec = TRIGGERS.find((t) => t.name === "github-topics");
    expect(spec).toBeDefined();
    expect(spec!.enabledByDefault).toBe(false);
  });
});
