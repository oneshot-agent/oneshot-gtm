import { beforeEach, expect, it, vi } from "vitest";
const record = vi.fn(),
  completion = vi.fn();
vi.mock("@oneshot-gtm/core", () => ({
  getLedger: () => ({ recordReceipt: (...args: unknown[]) => record(...args) }),
}));
vi.mock("../src/client.ts", () => ({ complete: (...args: unknown[]) => completion(...args) }));
const { completeWithReceipt } = await import("../src/metered.ts");
const context = { playName: "community-reply", memo: "classify", estimatedCostUsd: 0.05 };
beforeEach(() => {
  vi.clearAllMocks();
  record.mockReturnValue(42);
});
it("records actual provider cost and usage, without a signed receipt", async () => {
  completion.mockResolvedValue({
    content: "reply",
    provider: "openrouter",
    model: "model",
    inputTokens: 100,
    outputTokens: 40,
    costUsd: 0.003,
  });
  expect((await completeWithReceipt({ messages: [] }, context)).receiptId).toBe(42);
  expect(record.mock.calls[0]![0]).toMatchObject({
    costUsd: 0.003,
    decisionContext: { costBasis: "provider", inputTokens: 100, outputTokens: 40 },
  });
  expect(record.mock.calls[0]![0].signedReceipt).toBeUndefined();
});
it("labels estimates and retains uncertain attempted-call cost on failure", async () => {
  completion.mockResolvedValueOnce({ content: "reply", provider: "anthropic", model: "model" });
  await completeWithReceipt({ messages: [] }, context);
  expect(record.mock.calls[0]![0]).toMatchObject({
    costUsd: 0.05,
    decisionContext: { costBasis: "estimate" },
  });
  completion.mockImplementationOnce((input: { onAttempt: () => void }) => {
    input.onAttempt();
    throw new Error("network timeout");
  });
  await expect(completeWithReceipt({ messages: [] }, context)).rejects.toThrow("network timeout");
  expect(record.mock.calls[1]![0].decisionContext.outcome).toBe("failed-cost-uncertain");
});
it("does not record spend for local preflight failures", async () => {
  completion.mockRejectedValueOnce(new Error("No key"));
  await expect(completeWithReceipt({ messages: [] }, context)).rejects.toThrow("No key");
  expect(record).not.toHaveBeenCalled();
});
