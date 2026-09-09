import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Evidence gather + synthesis for the per-prospect angle (issue #355).
// Module boundaries mocked: ledger, GitHub fetchers, safeDeepResearchPerson,
// webRead, and the LLM `complete` call. Precedence logic (dossier → research
// → github/webread → replies) and the anti-fabrication parse stay REAL.

interface ProspectStub {
  id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  dossier_json: string | null;
  source_profile_url: string | null;
  linkedin_url: string | null;
}

let prospect: ProspectStub | null = null;
let queueRow: { id: number; payload_json: string } | null = null;
let replies: Array<{ body: string; subject: string | null; received_at: string }> = [];
let channelEvents: Array<{
  event_type: string;
  channel: string;
  body: string | null;
  occurred_at: string;
}> = [];
let deepResearchResult: { status: string; result: unknown; cost: number } = {
  status: "completed",
  result: { enrichment: { title: "Founder" } },
  cost: 0.05,
};
let deepResearchReceiptId = 5;
let webReadResult: { markdown: string; cost: number } = { markdown: "", cost: 0 };
let webReadThrows = false;
const safeDeepResearchCalls: unknown[] = [];
const webReadCalls: string[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      founderName: "Founder",
      productOneLiner: "TestProduct",
      icpOneLiner: "Engineers building agents",
      founderCredentials: null,
      productPortfolio: null,
      founderAdmission: null,
    }),
    getLedger: () => ({
      getProspectById: (id: number) => (prospect?.id === id ? prospect : null),
      getQueueRowForProspect: () => queueRow,
      listInboxRepliesForProspect: () => replies,
      listChannelEventsForProspect: () => channelEvents,
    }),
    webRead: async (input: { url: string }) => {
      webReadCalls.push(input.url);
      if (webReadThrows) throw new Error("webRead failed");
      return { result: webReadResult };
    },
    logEvent: () => {},
  };
});

vi.mock("../src/_sdk-safe.ts", () => ({
  safeDeepResearchPerson: async (input: Record<string, unknown>) => {
    safeDeepResearchCalls.push(input);
    return { result: deepResearchResult, receiptId: deepResearchReceiptId };
  },
}));

let nextGhUser: Record<string, unknown> | null = {
  login: "ada",
  name: "Ada",
  company: null,
  blogDomain: null,
  createdAt: "2026-08-01T00:00:00Z",
  publicRepos: 2,
  followers: 1,
};
let nextTopRepos: unknown[] | null = [
  { name: "agent-loop", description: "self-rewriting", language: "TS" },
];
let nextOrgs: unknown[] | null = [];
let nextOrgProfile: unknown = null;
let nextNetwork: unknown = { following: [], followers: [] };

vi.mock("../src/_github-user.ts", () => ({
  fetchGitHubUser: async () => nextGhUser,
  fetchTopRepos: async () => nextTopRepos,
  fetchGitHubOrgs: async () => nextOrgs,
  fetchGitHubOrgProfile: async () => nextOrgProfile,
  fetchFollowNetwork: async () => nextNetwork,
  ownerFromRepoUrl: (url: string) => {
    const m = url.match(/^https?:\/\/github\.com\/([^/]+)/i);
    return m ? (m[1] as string) : null;
  },
}));

let llmResponse = "{}";
const llmCalls: Array<{ system: string; user: string }> = [];

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const system = input.messages.find((m) => m.role === "system")?.content ?? "";
      const user = input.messages.find((m) => m.role === "user")?.content ?? "";
      llmCalls.push({ system, user });
      return { content: llmResponse, provider: "test", model: "test-model" };
    },
  };
});

const { gatherAngleEvidence, synthesizePersonAngle } = await import("../src/angle.ts");

beforeEach(() => {
  prospect = {
    id: 1,
    name: "Pat",
    company: "Acme",
    email: "pat@acme.dev",
    dossier_json: null,
    source_profile_url: null,
    linkedin_url: null,
  };
  queueRow = null;
  replies = [];
  channelEvents = [];
  deepResearchResult = {
    status: "completed",
    result: { enrichment: { title: "Founder" } },
    cost: 0.05,
  };
  deepResearchReceiptId = 5;
  webReadResult = { markdown: "", cost: 0 };
  webReadThrows = false;
  safeDeepResearchCalls.length = 0;
  webReadCalls.length = 0;
  nextGhUser = {
    login: "ada",
    name: "Ada",
    company: null,
    blogDomain: null,
    createdAt: "2026-08-01T00:00:00Z",
    publicRepos: 2,
    followers: 1,
  };
  nextTopRepos = [{ name: "agent-loop", description: "self-rewriting", language: "TS" }];
  nextOrgs = [];
  nextOrgProfile = null;
  nextNetwork = { following: [], followers: [] };
  llmResponse = "{}";
  llmCalls.length = 0;
});

afterEach(() => vi.clearAllMocks());

describe("gatherAngleEvidence", () => {
  it("returns null for a prospect that does not exist", async () => {
    prospect = null;
    expect(await gatherAngleEvidence(999)).toBeNull();
  });

  it("prefers a stored dossier with real signal over a fresh paid call", async () => {
    prospect!.dossier_json = JSON.stringify({ title: "CTO", company: "Acme" });
    const out = await gatherAngleEvidence(1);
    expect(out?.sources).toContain("dossier");
    expect(out?.dossierResearched).toBe(false);
    expect(safeDeepResearchCalls).toHaveLength(0);
  });

  it("falls through to a paid dossier when the stored one has no signal", async () => {
    prospect!.dossier_json = JSON.stringify({ status: "failed" });
    const out = await gatherAngleEvidence(1);
    expect(safeDeepResearchCalls).toHaveLength(1);
    expect(out?.sources).toContain("dossier:live");
    expect(out?.dossierResearched).toBe(true);
    expect(out?.costUsd).toBeGreaterThan(0);
  });

  it("does not buy paid research when allowPaidResearch is false (--dry-run/--cheap)", async () => {
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(safeDeepResearchCalls).toHaveLength(0);
    expect(out?.dossierText).toBeNull();
  });

  it("does not count a cache-hit dossier call as researched (receiptId 0)", async () => {
    deepResearchReceiptId = 0;
    const out = await gatherAngleEvidence(1);
    expect(out?.dossierResearched).toBe(false);
    expect(out?.costUsd).toBe(0);
  });

  it("fetches live GitHub evidence when the profile URL is a github.com link", async () => {
    prospect!.source_profile_url = "https://github.com/ada";
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(out?.github?.login).toBe("ada");
    expect(out?.github?.profile?.name).toBe("Ada");
    expect(out?.sources).toContain("github:live");
    expect(webReadCalls).toHaveLength(0);
  });

  it("resolves the first org's own profile when orgs are present", async () => {
    prospect!.source_profile_url = "https://github.com/ada";
    nextOrgs = [{ login: "axiomnode", description: "student lab" }];
    nextOrgProfile = {
      login: "axiomnode",
      name: "AxiomNode",
      publicRepos: 2,
      createdAt: "2026-08-01",
    };
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(out?.github?.linkedOrg?.login).toBe("axiomnode");
  });

  it("falls back to webRead for a non-github profile URL", async () => {
    prospect!.source_profile_url = "https://x.com/pat";
    webReadResult = { markdown: "Pat's X profile bio", cost: 0.01 };
    const out = await gatherAngleEvidence(1);
    expect(webReadCalls).toEqual(["https://x.com/pat"]);
    expect(out?.webReadText).toContain("Pat's X profile bio");
    expect(out?.webReadUrl).toBe("https://x.com/pat");
    expect(out?.webReadResearched).toBe(true);
    expect(out?.sources).toContain("webread");
  });

  // Round-1 correction (issue #357): an outcome-triggered refresh threads
  // the value tag through the evidence bundle so the synthesis prompt can
  // actually reflect it, instead of re-running an unchanged gather.
  it("threads an outcome through onto the evidence bundle when passed", async () => {
    const out = await gatherAngleEvidence(1, {
      allowPaidResearch: false,
      outcome: { type: "meeting", label: "meeting booked" },
    });
    expect(out?.outcome).toEqual({ type: "meeting", label: "meeting booked" });
  });

  it("defaults the evidence bundle's outcome to null when none is given", async () => {
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(out?.outcome).toBeNull();
  });

  it("counts a billed webRead's cost even when the markdown comes back empty", async () => {
    prospect!.source_profile_url = "https://x.com/pat";
    // Isolate the webRead cost being asserted below: a cache-hit dossier
    // (receiptId 0) is unbilled, so it doesn't also add its $0.05 on top of
    // webRead's $0.01 — see "does not count a cache-hit dossier call as
    // researched (receiptId 0)" above for the same pattern.
    deepResearchReceiptId = 0;
    webReadResult = { markdown: "   ", cost: 0.01 };
    const out = await gatherAngleEvidence(1);
    expect(out?.webReadText).toBeNull();
    expect(out?.sources).not.toContain("webread");
    expect(out?.costUsd).toBe(0.01);
  });

  it("skips webRead entirely under --cheap for a non-github URL", async () => {
    prospect!.source_profile_url = "https://x.com/pat";
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(webReadCalls).toHaveLength(0);
    expect(out?.webReadText).toBeNull();
  });

  it("degrades gracefully when webRead throws", async () => {
    prospect!.source_profile_url = "https://x.com/pat";
    webReadThrows = true;
    const out = await gatherAngleEvidence(1);
    expect(out?.webReadText).toBeNull();
    expect(out?.sources).not.toContain("webread");
  });

  it("includes the finder's queue signal when a linked row exists", async () => {
    queueRow = { id: 42, payload_json: JSON.stringify({ signal: "starred repo" }) };
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(out?.queueSignal).toContain("starred repo");
  });

  it("includes reply history, capped and marked in sources", async () => {
    replies = [
      { body: "not sure what you mean", subject: "re: hi", received_at: "2026-09-01T00:00:00Z" },
      { body: "ok makes sense now", subject: null, received_at: "2026-09-02T00:00:00Z" },
    ];
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(out?.replies).toHaveLength(2);
    expect(out?.sources).toContain("replies:2");
  });

  it("gathers evidence for a prospect with reply history alone, no URL or paid research", async () => {
    prospect!.email = null;
    replies = [{ body: "reply", subject: null, received_at: "2026-09-01T00:00:00Z" }];
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(out?.replies).toHaveLength(1);
    expect(out?.dossierText).toBeNull();
    expect(out?.github).toBeNull();
  });

  it("includes a LinkedIn reply (channel_events) alongside inbox replies (finding PRRT_kwDOSKzrBs6gUX7P)", async () => {
    replies = [
      { body: "email reply first", subject: "re: hi", received_at: "2026-09-01T00:00:00Z" },
    ];
    channelEvents = [
      {
        event_type: "reply",
        channel: "linkedin",
        body: "linkedin reply second",
        occurred_at: "2026-09-02T00:00:00Z",
      },
    ];
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(out?.replies).toHaveLength(2);
    expect(out?.replies.map((r) => r.body)).toEqual(["email reply first", "linkedin reply second"]);
    expect(out?.sources).toContain("replies:2");
  });

  it("gathers a LinkedIn-only reply with no email/inbox history at all", async () => {
    replies = [];
    channelEvents = [
      {
        event_type: "reply",
        channel: "linkedin",
        body: "only channel event",
        occurred_at: "2026-09-01T00:00:00Z",
      },
    ];
    const out = await gatherAngleEvidence(1, { allowPaidResearch: false });
    expect(out?.replies).toHaveLength(1);
    expect(out?.replies[0]?.body).toBe("only channel event");
    expect(out?.sources).toContain("replies:1");
  });

  it("prefers a researchable linkedin_url over a non-researchable source_profile_url", async () => {
    // Reuses research-prospects.ts's researchUrl: a luma.com/user/<handle> page
    // has no content ("Nothing Here, Yet") while linkedin_url is a real profile.
    prospect!.source_profile_url = "https://luma.com/user/rnq";
    prospect!.linkedin_url = "https://www.linkedin.com/in/raunaqbose";
    webReadResult = { markdown: "LinkedIn bio content", cost: 0.01 };
    const out = await gatherAngleEvidence(1);
    expect(webReadCalls).toEqual(["https://www.linkedin.com/in/raunaqbose"]);
    expect(out?.webReadText).toContain("LinkedIn bio content");
  });
});

describe("synthesizePersonAngle", () => {
  it("parses a valid LLM response into a ProspectAngle", async () => {
    llmResponse = JSON.stringify({
      brief: "Builds agent infra.",
      hook: "Shipped agent-loop yesterday.",
      relationship: "builder",
      evidence: [{ claim: "shipped agent-loop", source: "https://github.com/ada/agent-loop" }],
      valueMode: "advocate",
      buyerStage: "pre-scale",
      qualification: "small team",
    });
    const { angle, costUsd } = await synthesizePersonAngle({
      prospect: { id: 1, name: "Pat", company: "Acme", email: "pat@acme.dev" },
      evidence: {
        dossierText: "Recently shipped https://github.com/ada/agent-loop",
        dossierResearched: false,
        queueSignal: null,
        github: null,
        webReadText: null,
        webReadUrl: null,
        webReadResearched: false,
        replies: [],
        costUsd: 0,
        sources: ["dossier"],
      },
    });
    expect(angle?.hook).toBe("Shipped agent-loop yesterday.");
    expect(angle?.model).toBe("test/test-model");
    // The cited URL appears literally in dossierText, so the anti-fabrication
    // gate (packages/core/src/angle.ts) keeps it grounded rather than dropping it.
    expect(angle?.evidence).toEqual([
      { claim: "shipped agent-loop", source: "https://github.com/ada/agent-loop" },
    ]);
    expect(costUsd).toBe(0);
  });

  // Round-1 correction (issue #357): the outcome-triggered refresh's value
  // tag must actually reach the LLM prompt, not just ride along on the
  // bundle unused.
  it("renders the outcome into the synthesis prompt when the evidence carries one", async () => {
    llmResponse = JSON.stringify({ brief: "x", hook: "y" });
    llmCalls.length = 0;
    await synthesizePersonAngle({
      prospect: { id: 1, name: "Pat", company: "Acme", email: "pat@acme.dev" },
      evidence: {
        dossierText: null,
        dossierResearched: false,
        queueSignal: null,
        github: null,
        webReadText: null,
        webReadUrl: null,
        webReadResearched: false,
        replies: [],
        costUsd: 0,
        sources: [],
        outcome: { type: "revenue", amount: 5000, label: "deal won" },
      },
    });
    expect(llmCalls.at(-1)?.user).toContain("OUTCOME JUST RECORDED: revenue");
    expect(llmCalls.at(-1)?.user).toContain("deal won");
  });

  it("returns a null angle (not a throw) on an LLM failure", async () => {
    const failing = vi.fn();
    vi.doMock("@oneshot-gtm/intel", () => ({
      complete: async () => {
        failing();
        throw new Error("provider down");
      },
      loadPrompt: () => "system prompt",
      tryParseJsonObject: (_raw: string, fallback: unknown) => fallback,
    }));
    vi.resetModules();
    const { synthesizePersonAngle: reloaded } = await import("../src/angle.ts");
    const { angle } = await reloaded({
      prospect: { id: 1, name: "Pat", company: null, email: null },
      evidence: {
        dossierText: null,
        dossierResearched: false,
        queueSignal: null,
        github: null,
        webReadText: null,
        webReadUrl: null,
        webReadResearched: false,
        replies: [],
        costUsd: 0,
        sources: [],
      },
    });
    expect(angle).toBeNull();
    expect(failing).toHaveBeenCalled();
    vi.doUnmock("@oneshot-gtm/intel");
  });

  it("returns a null angle when the LLM output has no brief/hook — never fabricates a placeholder", async () => {
    llmResponse = JSON.stringify({ relationship: "builder" });
    const { angle } = await synthesizePersonAngle({
      prospect: { id: 1, name: "Pat", company: null, email: null },
      evidence: {
        dossierText: null,
        dossierResearched: false,
        queueSignal: null,
        github: null,
        webReadText: null,
        webReadUrl: null,
        webReadResearched: false,
        replies: [],
        costUsd: 0,
        sources: [],
      },
    });
    expect(angle).toBeNull();
  });

  it("includes founder facts and evidence blocks in the user message", async () => {
    await synthesizePersonAngle({
      prospect: { id: 1, name: "Pat", company: "Acme", email: "pat@acme.dev" },
      evidence: {
        dossierText: "some dossier text",
        dossierResearched: false,
        queueSignal: null,
        github: null,
        webReadText: null,
        webReadUrl: null,
        webReadResearched: false,
        replies: [],
        costUsd: 0,
        sources: ["dossier"],
      },
    });
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.user).toContain("FOUNDER: Founder");
    expect(llmCalls[0]!.user).toContain("PRODUCT: TestProduct");
    expect(llmCalls[0]!.user).toContain("some dossier text");
  });

  it("renders the webRead URL alongside the PROFILE PAGE text so a citation of it can ground (issue #569)", async () => {
    await synthesizePersonAngle({
      prospect: { id: 1, name: "Pat", company: null, email: null },
      evidence: {
        dossierText: null,
        dossierResearched: false,
        queueSignal: null,
        github: null,
        webReadText: "Pat's bio, no URL repeated in the markdown itself",
        webReadUrl: "https://x.com/pat",
        webReadResearched: true,
        replies: [],
        costUsd: 0,
        sources: ["webread"],
      },
    });
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.user).toContain("PROFILE PAGE (https://x.com/pat):");
    expect(llmCalls[0]!.user).toContain("https://x.com/pat");
  });

  it("renders actual follow-network logins, not just counts, so a colleague citation is possible (issue #569)", async () => {
    await synthesizePersonAngle({
      prospect: { id: 1, name: "Pat", company: null, email: null },
      evidence: {
        dossierText: null,
        dossierResearched: false,
        queueSignal: null,
        github: {
          login: "ada",
          profile: null,
          topRepos: null,
          orgs: null,
          linkedOrg: null,
          network: {
            following: [{ login: "grace" }, { login: "linus" }],
            followers: [{ login: "margaret" }],
          },
        },
        webReadText: null,
        webReadUrl: null,
        webReadResearched: false,
        replies: [],
        costUsd: 0,
        sources: ["github:live"],
      },
    });
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.user).toContain("grace");
    expect(llmCalls[0]!.user).toContain("linus");
    expect(llmCalls[0]!.user).toContain("margaret");
  });

  it("drops an evidence entry whose source is a hallucinated citation, end to end", async () => {
    // The URL cited here never appears anywhere in the rendered evidence, and
    // "replies:2" is never in `sources` — both must be dropped by the
    // anti-fabrication gate even though both are non-blank strings.
    llmResponse = JSON.stringify({
      brief: "Builds agent infra.",
      hook: "Shipped agent-loop yesterday.",
      evidence: [
        { claim: "made this up", source: "https://not-real.example/nowhere" },
        { claim: "also made up", source: "replies:2" },
      ],
    });
    const { angle } = await synthesizePersonAngle({
      prospect: { id: 1, name: "Pat", company: "Acme", email: "pat@acme.dev" },
      evidence: {
        dossierText: "some real dossier text",
        dossierResearched: false,
        queueSignal: null,
        github: null,
        webReadText: null,
        webReadUrl: null,
        webReadResearched: false,
        replies: [],
        costUsd: 0,
        sources: ["dossier"],
      },
    });
    expect(angle?.evidence).toEqual([]);
  });
});
