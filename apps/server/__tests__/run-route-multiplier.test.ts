import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLedger } from "@oneshot-gtm/core";
import type { RunPlayEvent } from "@oneshot-gtm/shared-types";

// The multiplier play (#883) on the public /api/run route: a run without a
// member offer is refused before the route's paid email verification, and a
// batch loaded from the queue pitches each row's own trigger offer. The real
// play runs against the per-file ledger; the SDK and the model are stubbed.

const calls = { verify: 0, enrich: 0, blocks: [] as string[] };
let memberOffer: string | null = null;
const OFFER = "Up to $150 in credit for each member company, earned at milestones.";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      founderName: "Founder",
      productOneLiner: "thing",
      productDomain: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: "test",
      memberOffer,
    }),
    enrichProfile: async () => {
      calls.enrich++;
      return { result: { profile: {} }, receiptId: 1 };
    },
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const block = input.messages.find((m) => m.role === "user")?.content ?? "";
      calls.blocks.push(block);
      const offer = /^MEMBER OFFER: (.*)$/m.exec(block)?.[1] ?? "";
      return {
        content: JSON.stringify({
          subject: "for your members",
          body: `Here is what I would offer: ${offer} Any use to them?`,
        }),
        provider: "t",
        model: "t",
      };
    },
  };
});

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    // The route's paid step. Counted, never reached by a refused run.
    verifyAndFilterTargets: async (targets: unknown[]) => {
      calls.verify++;
      return { verified: targets, dropped: [], receiptIds: [], costUsd: 0 };
    },
  };
});

const { runPlay, targetMatchesQueueRow } = await import("../src/api/run.ts");

const target = (organization: string, email: string) => ({
  organization,
  orgType: "accelerator",
  name: "Jordan Lee",
  email,
  role: "Head of Partnerships",
  memberDescription: "Forty pre-seed B2B software companies a year.",
  whyFit: "Each cohort company has to find its first twenty customers in six months.",
});

function post(body: unknown): Promise<Response> {
  return runPlay(
    new Request("http://127.0.0.1:3030/api/run/multiplier", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3030" },
      body: JSON.stringify(body),
    }),
    { playName: "multiplier" },
  );
}

async function frames(res: Response): Promise<RunPlayEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as RunPlayEvent);
}

const block = (org: string): string =>
  calls.blocks.find((b) => b.includes(`ORGANIZATION: ${org}`)) ?? "";

beforeEach(() => {
  calls.verify = 0;
  calls.enrich = 0;
  calls.blocks = [];
  memberOffer = OFFER;
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/run/multiplier", () => {
  it("refuses a run without a member offer before the route's paid verification", async () => {
    memberOffer = "  ";
    const res = await post({
      dryRun: false,
      targets: [target("Harbor Founders Program", "jordan@harbor.example")],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/memberOffer is empty/);
    expect(calls).toEqual({ verify: 0, enrich: 0, blocks: [] });
  });

  it("a batch loaded from the queue pitches each row's own trigger offer, a manual row the workspace's", async () => {
    const ledger = getLedger();
    ledger.upsertTrigger({
      name: "orgA",
      configJson: JSON.stringify({ memberOffer: "Offer A: two seats free for each member." }),
    });
    ledger.upsertTrigger({
      name: "orgB",
      configJson: JSON.stringify({ memberOffer: "Offer B: a free month for each member." }),
    });
    const a = target("Org A", "a@a.example");
    const b = target("Org B", "b@b.example");
    const manual = target("Manual Org", "m@m.example");
    ledger.enqueueTarget({
      playName: "multiplier",
      payload: a,
      dedupeKey: "row-a",
      source: "find:orgA:1",
    });
    ledger.enqueueTarget({
      playName: "multiplier",
      payload: b,
      dedupeKey: "row-b",
      source: "find:orgB:1",
    });

    const res = await post({
      dryRun: true,
      targets: [a, b, manual],
      dedupeKeys: ["row-a", "row-b", null],
    });
    expect(res.status).toBe(200);
    const events = await frames(res);
    expect(events.find((f) => f.kind === "done")).toMatchObject({ total: 3 });
    expect(block("Org A")).toContain("MEMBER OFFER: Offer A: two seats free for each member.");
    expect(block("Org B")).toContain("MEMBER OFFER: Offer B: a free month for each member.");
    expect(block("Manual Org")).toContain(`MEMBER OFFER: ${OFFER}`);
    // Each draft quoted its own row's offer: none is held for missing it.
    const drafts = events.filter((f) => f.kind === "draft");
    expect(drafts).toHaveLength(3);
    for (const d of drafts) expect(d.flags).not.toContain("multiplier:offer-missing");
  });

  it("refuses a target paired with another row's key before verification or drafting", async () => {
    const ledger = getLedger();
    ledger.upsertTrigger({
      name: "orgB",
      configJson: JSON.stringify({ memberOffer: "Offer B: a free month for each member." }),
    });
    const a = { ...target("Org A", "a@a.example"), name: "Ada Quill" };
    const b = { ...target("Org B", "b@b.example"), name: "Bo Reyes" };
    ledger.enqueueTarget({
      playName: "multiplier",
      payload: b,
      dedupeKey: "row-b",
      source: "find:orgB:1",
    });
    const res = await post({ dryRun: false, targets: [a], dedupeKeys: ["row-b"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /target 1 does not match the queue row/,
    );
    expect(calls).toEqual({ verify: 0, enrich: 0, blocks: [] });
  });

  it("with only a trigger offer set, a queue-loaded row runs and a batch with a manual row refuses before verification", async () => {
    memberOffer = null;
    const ledger = getLedger();
    ledger.upsertTrigger({
      name: "orgT",
      configJson: JSON.stringify({ memberOffer: "Offer T: a free month for each member." }),
    });
    const t = target("Org T", "t@t.example");
    ledger.enqueueTarget({
      playName: "multiplier",
      payload: t,
      dedupeKey: "row-t",
      source: "find:orgT:1",
    });

    const ok = await post({ dryRun: true, targets: [t], dedupeKeys: ["row-t"] });
    expect(ok.status).toBe(200);
    await frames(ok);
    expect(block("Org T")).toContain("MEMBER OFFER: Offer T: a free month for each member.");

    const refused = await post({
      dryRun: false,
      targets: [t, target("Manual Org", "m2@m.example")],
      dedupeKeys: ["row-t", null],
    });
    expect(refused.status).toBe(400);
    expect(calls.verify).toBe(0);
  });
});

describe("targetMatchesQueueRow", () => {
  const row = {
    organization: "Org A",
    name: "Ada Quill",
    email: "ada@a.example",
    linkedinUrl: "https://www.linkedin.com/in/ada-quill/",
  };
  it("matches when any identity field agrees, so an edited email still belongs", () => {
    expect(targetMatchesQueueRow({ ...row, email: "ada.quill@a.example" }, row)).toBe(true);
    expect(
      targetMatchesQueueRow({ ...row, linkedinUrl: "https://www.linkedin.com/in/ada-quill" }, row),
    ).toBe(true);
  });
  it("refuses another person, and another organization even with the same contact name", () => {
    expect(
      targetMatchesQueueRow(
        { name: "Bo Reyes", email: "bo@b.example", organization: "Org A" },
        row,
      ),
    ).toBe(false);
    expect(targetMatchesQueueRow({ ...row, organization: "Org B" }, row)).toBe(false);
  });
  it("accepts a pair with nothing to compare", () => {
    expect(targetMatchesQueueRow({ company: "Acme" }, { repo: "acme/x" })).toBe(true);
  });
});
