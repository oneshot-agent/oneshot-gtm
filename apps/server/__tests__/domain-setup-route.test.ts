import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ quote: vi.fn(), buy: vi.fn(), invalidate: vi.fn() }));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual("@oneshot-gtm/core")),
  quoteSendingDomain: mocks.quote,
  buySendingDomain: mocks.buy,
}));
vi.mock("../src/api/setup.ts", async () => ({
  ...(await vi.importActual("../src/api/setup.ts")),
  invalidateDomainViews: mocks.invalidate,
}));
const { quoteDomainRoute, buyDomainRoute } = await import("../src/api/domains.ts");
function req(body: unknown) {
  return new Request("http://localhost/api/domains/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => vi.resetAllMocks());
it.each(["relay", "mailbox"])("quotes %s without buying or sending", async (mailboxMode) => {
  mocks.quote.mockResolvedValue({
    domain: "example.com",
    purchasable: true,
    quote_id: "q",
    total_cost: 12,
    mailbox_mode: mailboxMode,
    addresses: ["sales"],
  });
  const res = await quoteDomainRoute(
    req({ domain: "example.com", mailboxMode, addresses: ["sales"] }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ quote_id: "q", total_cost: 12 });
  expect(mocks.quote).toHaveBeenCalledWith("example.com", {
    mailbox_mode: mailboxMode,
    addresses: ["sales"],
  });
  expect(mocks.buy).not.toHaveBeenCalled();
});
it("returns unavailable quotes without a purchase", async () => {
  mocks.quote.mockResolvedValue({
    domain: "example.com",
    purchasable: false,
    reason: "unavailable",
  });
  expect(await (await quoteDomainRoute(req({ domain: "example.com" }))).json()).toMatchObject({
    purchasable: false,
  });
});
it.each([
  {},
  null,
  { domain: "https://example.com" },
  { domain: "example.com", addresses: [] },
  { domain: "example.com", mailboxMode: "bad" },
])("rejects invalid setup input %j", async (body) => {
  expect((await quoteDomainRoute(req(body))).status).toBe(400);
  expect(mocks.quote).not.toHaveBeenCalled();
});
it("buys exactly the accepted quote and invalidates cached provisioning", async () => {
  mocks.buy.mockResolvedValue({
    status: "queued",
    domain: "example.com",
    setup: "domain_addresses",
  });
  const res = await buyDomainRoute(req({ domain: "example.com", quoteId: "q" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "queued" });
  expect(mocks.buy).toHaveBeenCalledWith("example.com", "q");
  expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  expect(mocks.quote).not.toHaveBeenCalled();
});
it("preserves expired-quote errors and unresolved-payment identifiers", async () => {
  mocks.buy.mockRejectedValueOnce(Object.assign(new Error("quote expired"), { statusCode: 409 }));
  expect((await buyDomainRoute(req({ domain: "example.com", quoteId: "old" }))).status).toBe(409);
  mocks.buy.mockRejectedValueOnce(
    Object.assign(new Error("payment unresolved"), {
      name: "PaymentHeldError",
      settlementId: "st",
      holdKey: "key",
    }),
  );
  const res = await buyDomainRoute(req({ domain: "example.com", quoteId: "q" }));
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: "payment_held",
    settlementId: "st",
    holdKey: "key",
  });
});
