import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The refresh side of issue #357: `packages/find/src/angle.ts` registers its
// `refreshProspectAngle` implementation onto core's `registerAngleRefreshTrigger`
// seam at module load, so `triggerAngleRefresh` (called from the reply poll /
// tagOutcomeValue in core) reaches this package's synthesis pipeline without
// core importing find back. Mocks mirror angle.test.ts's module boundaries;
// this file additionally captures the registered callback and exercises it.

interface ProspectStub {
  id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  dossier_json: string | null;
  source_profile_url: string | null;
  linkedin_url: string | null;
  angle_json: string | null;
}

let prospect: ProspectStub | null = null;
let setAngleCalls: Array<{ id: number; angle: string | null }> = [];
let registeredTrigger: ((prospectId: number) => void) | null = null;
let demoModeValue = false;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    demoMode: () => demoModeValue,
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
      getQueueRowForProspect: () => null,
      listInboxRepliesForProspect: () => [],
      listChannelEventsForProspect: () => [],
      setProspectAngle: (id: number, angle: string | null) => {
        setAngleCalls.push({ id, angle });
      },
    }),
    webRead: async () => ({ result: { markdown: "", cost: 0 } }),
    logEvent: () => {},
    // Captured instead of delegated to the real module-scoped state, so the
    // test drives the registered callback directly.
    registerAngleRefreshTrigger: (fn: (prospectId: number) => void) => {
      registeredTrigger = fn;
    },
  };
});

vi.mock("../src/_sdk-safe.ts", () => ({
  safeDeepResearchPerson: async () => ({
    result: { status: "completed", result: {}, cost: 0 },
    receiptId: 0,
  }),
}));

vi.mock("../src/_github-user.ts", () => ({
  fetchGitHubUser: async () => null,
  fetchTopRepos: async () => null,
  fetchGitHubOrgs: async () => null,
  fetchGitHubOrgProfile: async () => null,
  fetchFollowNetwork: async () => null,
  ownerFromRepoUrl: () => null,
}));

let isCircuitOpenValue = false;
vi.mock("../src/_breaker.ts", () => ({
  isCircuitOpen: () => isCircuitOpenValue,
}));

let llmResponse = "{}";
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    complete: async () => ({ content: llmResponse, provider: "test", model: "test-model" }),
  };
});

// Importing the module registers refreshProspectAngle onto the (mocked)
// registerAngleRefreshTrigger as a side effect.
await import("../src/angle.ts");

beforeEach(() => {
  prospect = {
    id: 1,
    name: "Pat",
    company: "Acme",
    email: "pat@acme.dev",
    dossier_json: null,
    source_profile_url: null,
    linkedin_url: null,
    angle_json: null,
  };
  setAngleCalls = [];
  demoModeValue = false;
  isCircuitOpenValue = false;
  llmResponse = "{}";
});

afterEach(() => vi.clearAllMocks());

describe("registerAngleRefreshTrigger wiring (issue #357)", () => {
  it("registers a callback at module load", () => {
    expect(registeredTrigger).not.toBeNull();
  });

  it("persists a re-synthesized angle when the LLM returns one", async () => {
    llmResponse = JSON.stringify({
      brief: "Builds agent infra.",
      hook: "Just corrected the record on their role.",
    });

    registeredTrigger!(1);
    // The trigger is fire-and-forget (`void refreshProspectAngle(...)`) —
    // flush the microtask queue so the async pipeline completes.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(setAngleCalls).toHaveLength(1);
    expect(setAngleCalls[0]?.id).toBe(1);
    expect(JSON.parse(setAngleCalls[0]?.angle ?? "{}").hook).toBe(
      "Just corrected the record on their role.",
    );
  });

  it("does not synthesize in demo mode", async () => {
    demoModeValue = true;
    llmResponse = JSON.stringify({ brief: "x", hook: "y" });

    registeredTrigger!(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(setAngleCalls).toHaveLength(0);
  });

  it("does not synthesize while the circuit breaker is open", async () => {
    isCircuitOpenValue = true;
    llmResponse = JSON.stringify({ brief: "x", hook: "y" });

    registeredTrigger!(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(setAngleCalls).toHaveLength(0);
  });

  it("does not persist when the LLM returns nothing usable (no brief/hook)", async () => {
    llmResponse = JSON.stringify({ relationship: "builder" });

    registeredTrigger!(1);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(setAngleCalls).toHaveLength(0);
  });

  it("no-ops for a prospect id that no longer exists", async () => {
    prospect = null;

    registeredTrigger!(999);
    await new Promise((r) => setTimeout(r, 0));

    expect(setAngleCalls).toHaveLength(0);
  });
});
