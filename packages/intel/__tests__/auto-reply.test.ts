import { describe, expect, it, vi } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { classifyAutoReply } from "../src/auto-reply.ts";
import type { LlmCompleteInput } from "../src/client.ts";

// The model extraction behind the rules: only asked when the rules leave
// something open, checked against the reply, and skipped without a model.

const cfg = { llmProvider: "openrouter", llmModel: "test/model" } as OneShotConfig;
const RECEIVED = "2026-11-04T09:00:00.000Z";
const base = { kind: "auto", fromEmail: "dana@halyard.example", receivedAt: RECEIVED };

function model(json: unknown) {
  return vi.fn(async (_input: LlmCompleteInput) => ({
    content: JSON.stringify(json),
    provider: "openrouter",
    model: "test/model",
  }));
}

describe("classifyAutoReply", () => {
  it("does not ask the model when the rules settle it", async () => {
    const completeImpl = model({ reason: "other" });
    const out = await classifyAutoReply(
      { ...base, subject: "Out of office", body: "Out of office until 14th December." },
      { cfg, completeImpl },
    );
    expect(out).toMatchObject({
      reason: "out_of_office",
      returnDate: "2026-12-14",
      classifier: "rules",
    });
    expect(completeImpl).not.toHaveBeenCalled();
  });

  it("takes the model's reason and date when the rules have none", async () => {
    const completeImpl = model({
      reason: "out_of_office",
      return_date: "2026-11-23",
      successor: null,
    });
    const out = await classifyAutoReply(
      {
        ...base,
        subject: "Automatic reply",
        body: "Thanks! I'll reply after Thanksgiving week, from the 23rd.",
      },
      { cfg, completeImpl },
    );
    expect(out).toEqual({
      reason: "out_of_office",
      returnDate: "2026-11-23",
      successor: null,
      classifier: "llm:test/model",
    });
    const prompt = completeImpl.mock.calls[0]![0].messages;
    expect(prompt[1]!.content).toContain("Received: 2026-11-04");
  });

  it("drops a successor the reply does not contain, and a date far from the reply", async () => {
    const completeImpl = model({
      reason: "left_company",
      return_date: "2031-01-01",
      successor: { name: "Lee Park", email: "lee.park@halyard.example" },
    });
    const out = await classifyAutoReply(
      {
        ...base,
        subject: "Automatic reply",
        body: "I have moved on. Please get in touch with my colleague in sales.",
      },
      { cfg, completeImpl },
    );
    expect(out.reason).toBe("left_company");
    expect(out.successor).toBeNull();
    expect(out.returnDate).toBeNull();
  });

  it("keeps the rules' verdict when the model fails", async () => {
    const completeImpl = vi.fn(async () => {
      throw new Error("provider down");
    });
    const out = await classifyAutoReply(
      { ...base, subject: "Automatic reply", body: "We received your message." },
      { cfg, completeImpl },
    );
    expect(out).toMatchObject({ reason: "other", classifier: "rules" });
  });

  it("skips the model when no LLM key is configured", async () => {
    const saved = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    try {
      const out = await classifyAutoReply(
        { ...base, subject: "Automatic reply", body: "We received your message." },
        { cfg },
      );
      expect(out).toMatchObject({ reason: "other", classifier: "rules" });
    } finally {
      if (saved !== undefined) process.env["OPENROUTER_API_KEY"] = saved;
    }
  });
});
