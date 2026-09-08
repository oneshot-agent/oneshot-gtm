import { afterEach, describe, expect, it, vi } from "vitest";

// complete() is the seam: triageEmails' own parsing/validation is what this
// suite exercises, so the LLM call itself is mocked to return controlled JSON.
const completeMock = vi.fn();
vi.mock("../src/client.ts", () => ({ complete: completeMock }));
vi.mock("../src/prompts.ts", () => ({ loadPrompt: () => "system prompt" }));

const { triageEmails } = await import("../src/triage.ts");

function inbound(id: string) {
  return {
    id,
    from: "prospect@example.com",
    subject: "Re: hi",
    received_at: "2026-08-25T10:00:00.000Z",
    body: "hello",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("triageEmails category validation (issue #558)", () => {
  it("passes through a valid category unchanged", async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify([
        { id: "e1", category: "interested", next_step: "reply", reasoning: "" },
      ]),
    });
    const [triaged] = await triageEmails([inbound("e1")]);
    expect(triaged?.category).toBe("interested");
  });

  it("falls back to 'other' when the model returns a malformed/hallucinated category", async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify([
        { id: "e1", category: "definitely_positive_vibes", next_step: "reply", reasoning: "" },
      ]),
    });
    const [triaged] = await triageEmails([inbound("e1")]);
    // Never the raw hallucinated string — a `false-not-in-set` value must not
    // leak through and read as positive intent (replyIntentIsPositive treats
    // any unrecognized string as positive, same as null).
    expect(triaged?.category).toBe("other");
  });

  it("falls back to 'other' when the model omits category entirely", async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify([{ id: "e1", next_step: "reply", reasoning: "" }]),
    });
    const [triaged] = await triageEmails([inbound("e1")]);
    expect(triaged?.category).toBe("other");
  });
});
