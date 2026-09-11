import { beforeEach, describe, expect, it, vi } from "vitest";

// A draft that comes back over the play's body cap earns exactly one redraft
// with a tighter budget stated in the message; the shorter draft wins; a
// failed redraft returns the original. Motivated by kimi-k3/k2.6 writing
// ~135-160 words against a 150 cap where gemini wrote ~106 (2026-09-11).

const responses: string[] = [];
const calls: Array<Array<{ role: string; content: string }>> = [];
const events: Array<{ kind: string; ctx: Record<string, unknown> }> = [];

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
      founderCohort: null,
      mobileSignature: false,
      clientId: "test",
    }),
    logEvent: (kind: string, ctx: Record<string, unknown>) => {
      events.push({ kind, ctx });
    },
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "write an email",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      calls.push(input.messages.map((m) => ({ ...m })));
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      if (next === "THROW") throw new Error("provider down");
      return { content: next, provider: "t", model: "t" };
    },
  };
});

const { draftEmailFromPrompt, LENGTH_RETRY_RATIO } = await import("../src/_lib.ts");

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const json = (body: string): string => JSON.stringify({ subject: "subject", body });

beforeEach(() => {
  responses.length = 0;
  calls.length = 0;
  events.length = 0;
});

describe("draftEmailFromPrompt length retry", () => {
  it("makes no second call when the body is within the cap", async () => {
    responses.push(json(words(120)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(d.body.split(" ")).toHaveLength(120);
    expect(calls).toHaveLength(1);
    expect(events.map((e) => e.kind)).not.toContain("email.draft.too_long_retry");
  });

  it("makes no second call at all when no cap is given (legacy callers)", async () => {
    responses.push(json(words(400)));
    await draftEmailFromPrompt({ promptName: "p", inputBlock: "x" });
    expect(calls).toHaveLength(1);
  });

  it("over the cap: one redraft asking for three quarters of it, in the same conversation", async () => {
    responses.push(json(words(163)), json(words(118)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(calls).toHaveLength(2);
    expect(d.body.split(" ")).toHaveLength(118);
    const second = calls[1]!;
    // The first draft is on the record as the assistant turn, then the ask.
    expect(second.at(-2)?.role).toBe("assistant");
    expect(second.at(-2)?.content).toContain("w162");
    const ask = second.at(-1)!;
    expect(ask.role).toBe("user");
    expect(ask.content).toContain("163 words");
    expect(ask.content).toContain(`at most ${Math.floor(150 * LENGTH_RETRY_RATIO)} words`);
    expect(ask.content).toMatch(/Cut whole sentences/);
    const ev = events.find((e) => e.kind === "email.draft.too_long_retry")!;
    expect(ev.ctx).toMatchObject({ words: 163, cap: 150, retry_words: 118, kept: "retry" });
  });

  it("keeps the shorter draft even when the redraft is still over the cap — lint decides", async () => {
    responses.push(json(words(170)), json(words(155)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(d.body.split(" ")).toHaveLength(155);
    expect(calls).toHaveLength(2);
  });

  it("keeps the original when the redraft is not shorter", async () => {
    responses.push(json(words(160)), json(words(165)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(d.body.split(" ")).toHaveLength(160);
    const ev = events.find((e) => e.kind === "email.draft.too_long_retry")!;
    expect(ev.ctx.kept).toBe("original");
  });

  it("a failed redraft returns the original draft, never throws", async () => {
    responses.push(json(words(160)), "THROW");
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(d.body.split(" ")).toHaveLength(160);
    expect(events.map((e) => e.kind)).toContain("email.draft.too_long_retry_failed");
  });

  it("never runs more than one redraft", async () => {
    responses.push(json(words(160)), json(words(158)), json(words(50)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(calls).toHaveLength(2);
    expect(d.body.split(" ")).toHaveLength(158);
  });
});
