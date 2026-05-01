import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coverage for the shared `_repo-pipeline.ts` module: snippet-ICP-first
 * ordering, GitHub user fallback paths, deepResearchPerson last-resort,
 * concurrency. Driven through `runGitHubTopicsFinder` as the entry point —
 * the only repo finder we have today.
 *
 * Discovery-shape concerns specific to github-topics live in
 * `github-topics-pipeline.test.ts`. This file deliberately does NOT re-test
 * those — focus stays on the per-candidate body.
 */

const calls = {
  topicSearch: 0,
  detectStack: 0,
  fetchGhUser: 0,
  llmIcp: 0,
  findEmail: 0,
  verifyEmail: 0,
  deepResearch: 0,
  enqueued: [] as Array<Record<string, unknown>>,
};

// Per-iteration overlap instrumentation for the concurrency tests. We slow
// down `detectRepoStack` since that's the new "expensive" pipeline step.
const inflight = { current: 0, peak: 0 };
let detectStackDelayMs = 0;

interface SearchRepo {
  url: string;
  fullName: string;
  description: string | null;
  stars: number;
  topics: string[];
  language: string | null;
  pushedAt: string;
}
let nextSearchHits: SearchRepo[] = [];

let icpMatchResult = true;
let icpReason = "ok";
let nextDetectedStack: string[] = ["langchain", "twilio"];
const fetchGhUserCalls: string[] = [];

interface MockGhUser {
  login: string;
  name: string | null;
  email: string | null;
  blogDomain: string | null;
  company: string | null;
}
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
// When non-empty, each findEmail call shifts one off the front. Lets a test
// stage "first call fails, second succeeds" without per-call branching.
let nextFindEmailQueue: Array<{ found: boolean; email?: string; full_name?: string }> = [];
const findEmailInputs: Array<{ companyDomain: string }> = [];

interface DeepResearchEnrichment {
  best_work_email?: string;
  best_personal_email?: string;
  altemails?: string[];
  firstname?: string;
  lastname?: string;
  displayname?: string;
  fullphone?: Array<{ fullphone: string; type?: string }>;
}
let nextDeepResearch: DeepResearchEnrichment | null = null;
const deepResearchInputs: Array<{
  socialMediaUrl?: string;
  name?: string;
  company?: string;
}> = [];

interface MockProfile {
  email?: string;
  full_name?: string;
  company?: string;
  company_domain?: string;
  phone?: string;
  fullphone?: Array<{ fullphone: string }>;
}
/** Path B' webSearch results — array of result URLs returned to the pipeline. */
let nextWebSearchUrls: string[] = [];
/** Path B' enrichProfile result — what the SDK returns when called with a linkedinUrl. */
let nextEnrichProfile: MockProfile | null = null;
const calls2 = { webSearch: 0, enrichProfile: 0 };

vi.mock("@oneshot-gtm/core", async () => {
  const actual =
    await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      telemetryEnabled: false,
      founderName: null,
      founderEmail: null,
      productOneLiner: "OneShot SDK",
      icpOneLiner: "Engineers building agents",
      clientId: "test",
    }),
    findEmail: async (input: { companyDomain: string }) => {
      calls.findEmail++;
      findEmailInputs.push(input);
      const next = nextFindEmailQueue.shift() ?? nextFindEmailResult;
      return { result: { ...next, cost: 0.005 }, receiptId: 0 };
    },
    verifyEmail: async () => {
      calls.verifyEmail++;
      return { result: { deliverable: true, cost: 0.01 }, receiptId: 0 };
    },
    deepResearchPerson: async (input: {
      socialMediaUrl?: string;
      name?: string;
      company?: string;
    }) => {
      calls.deepResearch++;
      deepResearchInputs.push(input);
      return {
        result: {
          status: "completed",
          request_id: "test",
          completed_at: "2026-04-27T00:00:00Z",
          cost: 0.05,
          result: { enrichment: nextDeepResearch ?? {} },
        },
        receiptId: 0,
      };
    },
    webSearch: async () => {
      calls2.webSearch++;
      return {
        result: {
          results: nextWebSearchUrls.map((url) => ({ url, title: "", description: "" })),
          cost: 0.01,
        },
        receiptId: 0,
      };
    },
    enrichProfile: async () => {
      calls2.enrichProfile++;
      return {
        result: { status: "completed", profile: nextEnrichProfile ?? {}, cost: 0.005 },
        receiptId: 0,
      };
    },
    getLedger: () => ({
      isQueueDuplicate: () => false,
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
  const actual =
    await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    complete: async () => {
      // Pipeline only calls complete() for ICP now — README+LLM extract is gone.
      calls.llmIcp++;
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
    fetchGitHubUser: async (login: string) => {
      calls.fetchGhUser++;
      fetchGhUserCalls.push(login);
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
    detectRepoStack: async () => {
      calls.detectStack++;
      inflight.current++;
      inflight.peak = Math.max(inflight.peak, inflight.current);
      if (detectStackDelayMs > 0) {
        await new Promise((r) => setTimeout(r, detectStackDelayMs));
      }
      inflight.current--;
      return { detected: nextDetectedStack, manifestsFound: ["package.json"] };
    },
  };
});

vi.mock("../src/_github-search.ts", () => {
  return {
    searchTopicRepos: async () => {
      calls.topicSearch++;
      return nextSearchHits;
    },
    isoDateNDaysAgo: () => "2026-01-27",
    githubHeaders: () => ({ Accept: "application/vnd.github+json" }),
  };
});

const { runGitHubTopicsFinder } = await import("../src/github-topics.ts");
const { _resetLinkedInCache } = await import("../src/_linkedin.ts");

beforeEach(() => {
  _resetLinkedInCache();
  calls.topicSearch = 0;
  calls.detectStack = 0;
  calls.fetchGhUser = 0;
  calls.llmIcp = 0;
  calls.findEmail = 0;
  calls.verifyEmail = 0;
  calls.deepResearch = 0;
  calls.enqueued = [];
  calls2.webSearch = 0;
  calls2.enrichProfile = 0;
  fetchGhUserCalls.length = 0;
  nextDeepResearch = null;
  deepResearchInputs.length = 0;
  nextWebSearchUrls = [];
  nextEnrichProfile = null;
  inflight.current = 0;
  inflight.peak = 0;
  detectStackDelayMs = 0;
  icpMatchResult = true;
  icpReason = "ok";
  nextSearchHits = [];
  nextDetectedStack = ["langchain", "twilio"];
  defaultGhUser = {
    login: "ada",
    name: "Ada Lovelace",
    email: null,
    blogDomain: "acme.dev",
    company: "Acme Agents",
  };
  nextFindEmailResult = { found: true, email: "ada@acme.dev", full_name: "Ada" };
  nextFindEmailQueue = [];
  findEmailInputs.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseOpts = {
  dryRun: false as const,
  topics: ["llm-agents"],
  vendors: ["langchain", "twilio"],
  yourEdge: "OneShot bundles every vendor into one signed action.",
  limit: 25,
  maxCostUsd: 5,
};

function makeRepo(url: string, overrides: Partial<SearchRepo> = {}): SearchRepo {
  const fullName = url.replace(/^https?:\/\/github\.com\//i, "");
  return {
    url,
    fullName,
    description: "An agent stitching langchain + twilio",
    stars: 50,
    topics: ["llm-agents"],
    language: "Python",
    pushedAt: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

describe("repo pipeline — ICP-first ordering", () => {
  it("rejects an awesome-list candidate WITHOUT scanning the stack", async () => {
    nextSearchHits = [makeRepo("https://github.com/realrepo/agent")];
    icpMatchResult = false;
    icpReason = "snippet shows tutorial repo, not a buyer";
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.llmIcp).toBe(1);
    expect(calls.detectStack).toBe(0); // ICP rejected before stack scan
    expect(calls.fetchGhUser).toBe(0);
    expect(calls.findEmail).toBe(0);
    expect(out.droppedIcp).toBe(1);
    expect(calls.enqueued).toHaveLength(1);
    expect(calls.enqueued[0]?.["initialStatus"]).toBe("rejected");
  });

  it("happy path: ICP → stack scan + user fetch → findEmail → verify → enqueue", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.llmIcp).toBe(1);
    expect(calls.detectStack).toBe(1);
    expect(calls.findEmail).toBe(1);
    expect(calls.verifyEmail).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(calls.enqueued[0]?.["initialStatus"]).toBeUndefined();
  });
});

describe("repo pipeline — GitHub user fallback in resolveContact", () => {
  it("uses GitHub blog domain when extract.companyDomain is null", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    // blog domain only — no other companyDomain available
    defaultGhUser = { login: "ada", name: "Ada", email: null, blogDomain: "ada.dev", company: null };
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.findEmail).toBe(1);
    expect(out.enqueued).toBe(1);
  });

  it("when GitHub returns email directly, skips findEmail entirely", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    defaultGhUser = {
      login: "ada",
      name: "Ada",
      email: "ada@personal.dev",
      blogDomain: null,
      company: null,
    };
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.findEmail).toBe(0); // skip-and-verify
    expect(calls.verifyEmail).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(calls.enqueued[0]?.["payload"]).toMatchObject({ email: "ada@personal.dev" });
  });

  it("when extract has a domain but findEmail fails, GitHub email rescues the candidate", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    nextFindEmailQueue = [{ found: false }]; // first findEmail returns no result
    defaultGhUser = {
      login: "ada",
      name: "Ada",
      email: "ada@personal.dev",
      blogDomain: "acme.dev", // same as extract — but we'll fall back to direct email
      company: null,
    };
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.findEmail).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(calls.enqueued[0]?.["payload"]).toMatchObject({ email: "ada@personal.dev" });
  });

  it("drops the candidate when extract has no domain AND GitHub has nothing AND deep-research returns nothing", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    // Name + company present so deepResearch passes the gate AND fires.
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: "Acme Agents",
    };
    nextDeepResearch = null; // deep research returns no enrichment
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.findEmail).toBe(0); // no domain to query with
    expect(calls.deepResearch).toBe(1);
    expect(out.droppedEnrichment).toBe(1);
    expect(out.enqueued).toBe(0);
  });
});

describe("repo pipeline — deepResearchPerson last-resort", () => {
  it("rescues when both findEmail paths fail and GitHub has nothing", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    nextFindEmailQueue = [{ found: false }];
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: "acme.dev",
      company: "Acme Agents",
    };
    nextDeepResearch = {
      best_work_email: "ada@deep.dev",
      firstname: "Ada",
      lastname: "Lovelace",
    };
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.findEmail).toBe(1);
    expect(calls.deepResearch).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(calls.enqueued[0]?.["payload"]).toMatchObject({
      email: "ada@deep.dev",
      name: "Ada Lovelace",
    });
  });

  it("passes repo URL + author name + company to deepResearchPerson", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    defaultGhUser = { login: "ada", name: "Ada Lovelace", email: null, blogDomain: null, company: "Acme Agents" };
    nextDeepResearch = { best_personal_email: "ada@personal.dev" };
    await runGitHubTopicsFinder(baseOpts);
    expect(deepResearchInputs).toHaveLength(1);
    expect(deepResearchInputs[0]).toEqual({
      socialMediaUrl: "https://github.com/ada/agent",
      name: "Ada Lovelace",
      company: "Acme Agents",
    });
  });

  it("falls back to altemails[0] when best_work_email and best_personal_email are missing", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    // Need name + company to clear the deep-research gate.
    defaultGhUser = {
      login: "ada",
      name: "Ada",
      email: null,
      blogDomain: null,
      company: "Acme Agents",
    };
    nextDeepResearch = { altemails: ["ada+work@alt.dev", "ada@old.dev"] };
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(out.enqueued).toBe(1);
    expect(calls.enqueued[0]?.["payload"]).toMatchObject({ email: "ada+work@alt.dev" });
  });

  it("does NOT call deepResearchPerson when name OR company is missing (would-be a $0.05 guaranteed-miss)", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    // Has name but NOT company → fails the (name && company) gate.
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: null,
    };
    nextDeepResearch = { best_work_email: "should@not.be.called" };
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.deepResearch).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
    expect(out.enqueued).toBe(0);
  });

  it("does NOT call deepResearchPerson when useDeepResearch=false", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: "Acme Agents",
    };
    nextDeepResearch = { best_work_email: "should@not.be.used" };
    const out = await runGitHubTopicsFinder({ ...baseOpts, useDeepResearch: false });
    expect(calls.deepResearch).toBe(0);
    expect(out.enqueued).toBe(0);
    expect(out.droppedEnrichment).toBe(1);
  });

  it("does NOT call deepResearchPerson on the happy path (extract domain → findEmail succeeds)", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls.findEmail).toBe(1);
    expect(calls.deepResearch).toBe(0);
    expect(out.enqueued).toBe(1);
  });
});

describe("repo pipeline — Path B' (linkedin discovery via webSearch + enrichProfile)", () => {
  it("rescues directly when enrichProfile returns an email", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    // Name present but no company — exactly the Path B' trigger condition.
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: null,
    };
    nextWebSearchUrls = ["https://www.linkedin.com/in/ada-lovelace"];
    nextEnrichProfile = {
      email: "ada@enriched.dev",
      full_name: "Ada Lovelace",
      company: "EnrichedCorp",
      company_domain: "enriched.dev",
    };
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls2.webSearch).toBe(1);
    expect(calls2.enrichProfile).toBe(1);
    // enrichProfile gave us the email directly — no further findEmail / deep-research.
    expect(calls.findEmail).toBe(0);
    expect(calls.deepResearch).toBe(0);
    expect(out.enqueued).toBe(1);
    expect(calls.enqueued[0]?.["payload"]).toMatchObject({ email: "ada@enriched.dev" });
  });

  it("opens the deep-research gate when enrichProfile only returns a company name", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: null,
    };
    nextWebSearchUrls = ["https://www.linkedin.com/in/ada-lovelace"];
    // No email + no company_domain on the profile — but a company name.
    nextEnrichProfile = { full_name: "Ada Lovelace", company: "Stealth Agents" };
    nextDeepResearch = { best_work_email: "ada@stealth.dev", firstname: "Ada", lastname: "Lovelace" };
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls2.enrichProfile).toBe(1);
    // Path C now fires because companyForGate was populated by Path B'.
    expect(calls.deepResearch).toBe(1);
    expect(deepResearchInputs[0]).toMatchObject({ company: "Stealth Agents" });
    expect(out.enqueued).toBe(1);
  });

  it("falls through cleanly when no LinkedIn URL is found in webSearch results", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: null,
    };
    nextWebSearchUrls = ["https://example.com/not-linkedin"]; // no /in/ URL
    const out = await runGitHubTopicsFinder(baseOpts);
    expect(calls2.webSearch).toBe(1);
    expect(calls2.enrichProfile).toBe(0); // never called — no URL to feed it
    expect(calls.deepResearch).toBe(0); // gate stays closed without company
    expect(out.droppedEnrichment).toBe(1);
  });

  it("SKIPS Path B' entirely when extract.companyName is already known", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: "Acme Agents",
    };
    // findEmail will fail in this scenario (default companyDomain is null in extract too).
    // We just want to verify the pipeline does NOT spend a webSearch when company is set.
    nextDeepResearch = null;
    await runGitHubTopicsFinder(baseOpts);
    expect(calls2.webSearch).toBe(0);
    expect(calls2.enrichProfile).toBe(0);
    expect(calls.deepResearch).toBe(1); // Path C fires directly with extract.companyName
  });

  it("persists linkedinUrl + phone from Path B' enrichProfile onto the target", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: null,
    };
    nextWebSearchUrls = ["https://www.linkedin.com/in/ada-lovelace"];
    // PersonResult exposes phone (string) AND fullphone array; assert we read either.
    nextEnrichProfile = {
      email: "ada@enriched.dev",
      full_name: "Ada Lovelace",
      company: "EnrichedCorp",
      company_domain: "enriched.dev",
      phone: "+15551234567",
    };
    await runGitHubTopicsFinder(baseOpts);
    expect(calls.enqueued[0]?.["payload"]).toMatchObject({
      email: "ada@enriched.dev",
      linkedinUrl: "https://www.linkedin.com/in/ada-lovelace",
      phone: "+15551234567",
    });
  });

  it("persists phone from Path C deepResearch enrichment onto the target", async () => {
    nextSearchHits = [makeRepo("https://github.com/ada/agent")];
    defaultGhUser = {
      login: "ada",
      name: "Ada Lovelace",
      email: null,
      blogDomain: null,
      company: "Stealth Agents",
    };
    nextDeepResearch = {
      best_work_email: "ada@stealth.dev",
      firstname: "Ada",
      lastname: "Lovelace",
      fullphone: [{ fullphone: "+15559998888", type: "mobile" }],
    };
    await runGitHubTopicsFinder(baseOpts);
    expect(calls.enqueued[0]?.["payload"]).toMatchObject({
      email: "ada@stealth.dev",
      phone: "+15559998888",
    });
  });
});

describe("repo pipeline — concurrency", () => {
  it("processes multiple candidates in parallel under the concurrency cap", async () => {
    nextSearchHits = [
      makeRepo("https://github.com/a/x"),
      makeRepo("https://github.com/b/y"),
      makeRepo("https://github.com/c/z"),
    ];
    detectStackDelayMs = 8;
    await runGitHubTopicsFinder({ ...baseOpts, concurrency: 3 });
    expect(inflight.peak).toBeGreaterThanOrEqual(2);
    expect(inflight.peak).toBeLessThanOrEqual(3);
  });

  it("concurrency: 1 serializes (peak inflight stays at 1)", async () => {
    nextSearchHits = [makeRepo("https://github.com/a/x"), makeRepo("https://github.com/b/y")];
    detectStackDelayMs = 4;
    await runGitHubTopicsFinder({ ...baseOpts, concurrency: 1 });
    expect(inflight.peak).toBe(1);
  });
});
