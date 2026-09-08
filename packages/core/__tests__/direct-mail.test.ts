import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import type { DirectMailDraft } from "../src/direct-mail.ts";
let ledger: Ledger;
let stopped = false;
let replies = false;
const calls = {
  send: vi.fn(),
  recover: vi.fn(),
  getOrder: vi.fn(),
  approve: vi.fn(),
  cancel: vi.fn(),
};
vi.mock("../src/oneshot.ts", () => ({
  getAgent: async () => ({ physicalMail: calls }),
  cadenceGoalId: (_play: string, email: string) => email,
}));
vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return { ...actual, getLedger: () => ledger };
});
const {
  sendDirectMail,
  approveDirectMail,
  refreshDirectMail,
  cancelDirectMail,
  refreshPendingDirectMail,
} = await import("../src/direct-mail.ts");
const input = {
  to: {
    name: "A",
    address_line1: "1 Main",
    address_city: "City",
    address_state: "CA",
    address_zip: "90001",
  },
  from: {
    name: "B",
    address_line1: "2 Main",
    address_city: "City",
    address_state: "CA",
    address_zip: "90001",
  },
  artwork: { kind: "letter" as const, file: "asset" },
};
function draft(): DirectMailDraft {
  return {
    id: "draft",
    prospectId: 1,
    playName: "play",
    enrollment: "2026-01-01",
    stepIndex: 1,
    input,
    quote: {
      quote_id: "q",
      input,
      input_hash: "hash",
      status: "ready",
      preview: { url: "https://example.com/proof", thumbnails: [] },
      total_usdc: "1.05",
      service_fee_usdc: ".05",
      expires_at: "2099-01-01",
      approval_id: null,
      delivery_proves_readership: false,
    },
    sendKey: "durable",
  };
}
beforeEach(() => {
  ledger = new Ledger(":memory:");
  stopped = false;
  replies = false;
  vi.clearAllMocks();
  vi.spyOn(ledger, "getCadence").mockImplementation(
    () =>
      ({
        status: stopped ? "stopped" : "active",
        enrolled_at: "2026-01-01",
        current_step: 0,
        replied_at: replies ? "2026-01-02" : null,
      }) as any,
  );
  vi.spyOn(ledger, "getProspectById").mockReturnValue({ email: null } as any);
  calls.approve.mockResolvedValue({ approval_id: "approved" });
  calls.send.mockResolvedValue({
    order_id: "o",
    receipt_id: "r",
    payment_status: "settled",
    order_status: "accepted",
    total_usdc: "1.05",
    events: [],
    signed_receipt: { signature: "sig" },
  });
  calls.recover.mockImplementation(async () => calls.send.mock.results[0]?.value);
  ledger.saveDirectMail(draft());
});
describe("direct mail durable approval", () => {
  it("refuses absent or changed approval", async () => {
    await expect(sendDirectMail("draft")).rejects.toThrow("approval");
    expect(calls.send).not.toHaveBeenCalled();
    await expect(
      approveDirectMail("draft", { input_hash: "changed", total_usdc: "1.05", approved: true }),
    ).rejects.toThrow("current proof");
  });
  it("persists key before sending and recovers instead of resending after restart", async () => {
    await approveDirectMail("draft", { input_hash: "hash", total_usdc: "1.05", approved: true });
    const first = await sendDirectMail("draft");
    expect(calls.send.mock.calls[0]![0].idempotencyKey).toBe("durable");
    expect(ledger.getDirectMail("draft")!.started).toBe(true);
    calls.getOrder.mockResolvedValue(first.order);
    const second = await sendDirectMail("draft");
    expect(calls.send).toHaveBeenCalledTimes(1);
    expect(second.receiptId).toBe(first.receiptId);
  });
  it("stops new submissions on reply or stopped cadence", async () => {
    await approveDirectMail("draft", { input_hash: "hash", total_usdc: "1.05", approved: true });
    replies = true;
    await expect(sendDirectMail("draft")).rejects.toThrow("stopped");
    replies = false;
    stopped = true;
    await expect(sendDirectMail("draft")).rejects.toThrow("stopped");
    expect(calls.send).not.toHaveBeenCalled();
  });
  it("rejects stale writes so a re-preview cannot overwrite a started order", () => {
    const old = ledger.getDirectMail("draft")!;
    const current = ledger.getDirectMail("draft")!;
    current.started = true;
    ledger.saveDirectMail(current);
    expect(() => ledger.saveDirectMail(old)).toThrow("changed");
  });
  it("delivery refresh adds no spend or readership claim", async () => {
    await approveDirectMail("draft", { input_hash: "hash", total_usdc: "1.05", approved: true });
    const first = await sendDirectMail("draft");
    calls.getOrder.mockResolvedValue({
      ...first.order,
      signed_receipt: { signature: "final-signature" },
      fulfillment_status: "delivered",
      events: [{ event_id: "e", event_type: "letter.delivered" }],
      delivery_proves_readership: false,
    });
    const refreshed = await refreshDirectMail("draft");
    expect(refreshed.receiptId).toBe(first.receiptId);
    expect(refreshed.order!.delivery_proves_readership).toBe(false);
    expect(ledger.listReceipts()).toHaveLength(1);
    expect(ledger.listReceipts()[0]!.signed_receipt).toContain("final-signature");
  });
});

afterEach(() => ledger.close());
it("retries the exact persisted envelope when prospect data changes after a timeout", async () => {
  await approveDirectMail("draft", { input_hash: "hash", total_usdc: "1.05", approved: true });
  calls.send.mockRejectedValueOnce(new Error("timeout"));
  await expect(sendDirectMail("draft")).rejects.toThrow("timeout");
  const sent = structuredClone(calls.send.mock.calls[0]![0]);
  expect(ledger.getDirectMail("draft")!.sendInput).toEqual(sent);
  vi.mocked(ledger.getProspectById).mockReturnValue({ email: "changed@example.com" } as any);
  calls.recover.mockRejectedValueOnce(Object.assign(new Error("not found"), { statusCode: 404 }));
  await sendDirectMail("draft");
  expect(calls.send.mock.calls[1]![0]).toEqual(sent);
});
it("persists cancellation intent while acceptance is unknown and cancels on later recovery", async () => {
  await approveDirectMail("draft", { input_hash: "hash", total_usdc: "1.05", approved: true });
  calls.send.mockRejectedValueOnce(new Error("timeout"));
  await expect(sendDirectMail("draft")).rejects.toThrow();
  calls.recover.mockRejectedValueOnce(Object.assign(new Error("not found"), { statusCode: 404 }));
  await cancelDirectMail("draft");
  expect(ledger.getDirectMail("draft")!.cancelRequested).toBe(true);
  const order = {
    order_id: "recovered",
    order_status: "accepted",
    payment_status: "settled",
    receipt_id: "recovered_receipt",
    total_usdc: "1.05",
  };
  calls.recover.mockResolvedValue(order);
  calls.cancel.mockResolvedValue({
    ...order,
    order_status: "canceled",
    cancellation_requested: true,
  });
  const result = await refreshDirectMail("draft");
  expect(calls.cancel).toHaveBeenCalledWith("recovered");
  expect(result.order!.order_status).toBe("canceled");
  expect(calls.send).toHaveBeenCalledTimes(1);
});

it("continues refreshing a canceled paid order until its refund is recorded", async () => {
  const d = ledger.getDirectMail("draft")!;
  d.started = true;
  d.order = {
    order_id: "o",
    receipt_id: "r",
    payment_status: "settled",
    order_status: "canceled",
    total_usdc: "1.05",
    events: [],
  } as any;
  ledger.saveDirectMail(d);
  calls.getOrder.mockResolvedValue({ ...d.order, refunded_at: "2026-09-05T00:00:00Z" });
  expect(await refreshPendingDirectMail()).toEqual({ refreshed: 1, failed: 0 });
  expect(ledger.getDirectMail("draft")!.order!.refunded_at).toBeTruthy();
  expect(await refreshPendingDirectMail()).toEqual({ refreshed: 0, failed: 0 });
  expect(calls.getOrder).toHaveBeenCalledTimes(1);
});

describe("mail proof freshness", () => {
  it("does not send a proof after the founder changes the return address", async () => {
    const d = ledger.getDirectMail("draft")!;
    d.addressInputs = { to: input.to, from: input.from };
    ledger.setMailAddress("prospect:1", input.to);
    ledger.setMailAddress("return", { ...input.from, address_line1: "A new office" });
    d.approvalId = "approved";
    ledger.saveDirectMail(d);
    await expect(sendDirectMail("draft")).rejects.toThrow("Addresses changed");
    expect(calls.send).not.toHaveBeenCalled();
  });
  it("refuses expired proofs before approval or submission", async () => {
    const d = ledger.getDirectMail("draft")!;
    d.quote.expires_at = "2000-01-01";
    d.approvalId = "approved";
    ledger.saveDirectMail(d);
    await expect(
      approveDirectMail("draft", { input_hash: "hash", total_usdc: "1.05", approved: true }),
    ).rejects.toThrow("fresh print proof");
    await expect(sendDirectMail("draft")).rejects.toThrow("expired");
    expect(calls.approve).not.toHaveBeenCalled();
    expect(calls.send).not.toHaveBeenCalled();
  });
});
