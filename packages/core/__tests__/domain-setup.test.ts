import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ quote: vi.fn(), buy: vi.fn(), receipt: vi.fn(), log: vi.fn() }));
vi.mock("../src/oneshot.ts", () => ({
  getAgent: async () => ({ quoteDomain: h.quote, buyDomain: h.buy }),
  buildAuditOpts: () => ({ memo: "setup", decisionContext: {} }),
}));
vi.mock("../src/ledger.ts", () => ({ getLedger: () => ({ recordReceipt: h.receipt }) }));
vi.mock("../src/events.ts", () => ({ logEvent: h.log }));
const { quoteSendingDomain, buySendingDomain } = await import("../src/domain-setup.ts");
beforeEach(() => vi.resetAllMocks());
it("leaves omitted mode to the server so existing domains keep their mode", async () => {
  h.quote.mockResolvedValue({ purchasable: true, mailbox_mode: "mailbox" });
  await quoteSendingDomain("EXAMPLE.com", { addresses: ["Sales"] });
  expect(h.quote).toHaveBeenCalledWith(
    "example.com",
    expect.objectContaining({ addresses: ["sales"] }),
  );
  expect(h.quote.mock.calls[0]![1]).not.toHaveProperty("mailbox_mode");
});
it("preserves an explicit mode for a new domain", async () => {
  await quoteSendingDomain("example.com", { mailbox_mode: "mailbox" });
  expect(h.quote.mock.calls[0]![1]).toHaveProperty("mailbox_mode", "mailbox");
});
it("returns provider success if receipt persistence fails, without another purchase", async () => {
  const result = {
    domain: "example.com",
    status: "completed",
    request_id: "req",
    receipt_id: "rcpt",
  };
  h.buy.mockResolvedValue(result);
  h.receipt.mockImplementation(() => {
    throw new Error("database locked");
  });
  await expect(buySendingDomain("example.com", "q")).resolves.toEqual(result);
  expect(h.buy).toHaveBeenCalledTimes(1);
  expect(h.log).toHaveBeenCalledWith(
    "domain.setup_receipt_failed",
    expect.objectContaining({ request_id: "req", receipt_id: "rcpt" }),
    "error",
  );
});
