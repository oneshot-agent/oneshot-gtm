import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";
let ledger: Ledger;
const read = vi.fn(),
  llm = vi.fn(),
  release = vi.fn();
let allowed = true;
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({ directMailMotions: { motion: { position: 2, delayDays: 3 } } }),
    webRead: (...args: unknown[]) => read(...args),
    tryReserveDailySpend: () => (allowed ? { granted: true, release } : { granted: false }),
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, complete: (...args: unknown[]) => llm(...args) };
});
const { researchBusinessAddress, collectQueueBusinessAddress } =
  await import("../src/_mail-research.ts");
const address = {
  address_line1: "10 Main St",
  address_city: "Boston",
  address_state: "MA",
  address_zip: "02110",
  address_country: "US" as const,
};
beforeEach(() => {
  ledger = new Ledger(":memory:");
  vi.clearAllMocks();
  allowed = true;
  read.mockResolvedValue({
    result: { markdown: "Acme headquarters: 10 Main St, Boston, MA 02110, USA", cost: 0.01 },
  });
  llm.mockResolvedValue({ content: JSON.stringify(address) });
});
afterEach(() => ledger.close());
describe("automatic business address collection", () => {
  it("stores source evidence and reuses the address for another contact at that business", async () => {
    const first = await researchBusinessAddress(
      { name: "Jane", email: "jane@acme.test" },
      "motion",
    );
    expect(first.address).toMatchObject({ ...address, name: "Jane" });
    expect(first.source).toBe("https://acme.test/");
    const second = await researchBusinessAddress(
      { name: "John", email: "john@acme.test" },
      "motion",
    );
    expect(second.address?.name).toBe("John");
    expect(second.costUsd).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("does not accept an address invented by the extractor, and backs off failures", async () => {
    llm.mockResolvedValue({
      content: JSON.stringify({ ...address, address_line1: "999 Invented Road" }),
    });
    expect(
      (await researchBusinessAddress({ email: "jane@acme.test" }, "motion")).address,
    ).toBeNull();
    const count = read.mock.calls.length;
    await researchBusinessAddress({ email: "jane@acme.test" }, "motion");
    expect(read).toHaveBeenCalledTimes(count);
  });
  it("tries the contact page when the homepage cannot be read", async () => {
    read.mockRejectedValueOnce(new Error("Homepage unavailable"));
    const result = await researchBusinessAddress(
      { name: "Jane", email: "jane@acme.test" },
      "motion",
    );
    expect(result.address).toMatchObject(address);
    expect(result.source).toBe("https://acme.test/contact");
    expect(read).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("does not rejuvenate an expired cached address after a failed refresh", async () => {
    const collectedAt = new Date(Date.now() - 31 * 86400000).toISOString();
    ledger.setMailAddress(
      "company:acme.test",
      { ...address, name: "Jane" },
      "https://acme.test/old",
    );
    ledger.setMailAddressMetadata("company:acme.test", {
      collectedAt,
      source: "https://acme.test/old",
    });
    read.mockRejectedValue(new Error("Unavailable"));
    expect(
      (await researchBusinessAddress({ email: "jane@acme.test" }, "motion")).address,
    ).toBeNull();
    expect(
      (await researchBusinessAddress({ email: "john@acme.test" }, "motion")).address,
    ).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(ledger.getMailAddressMetadata("company:acme.test")).toMatchObject({
      collectedAt,
      source: "https://acme.test/old",
    });
  });
  it("keeps an address manually corrected while queue research is in flight", async () => {
    const payload = { name: "Jane", email: "jane@acme.test" };
    const id = ledger.enqueueTarget({
      playName: "motion",
      payload,
      dedupeKey: "jane",
      source: "CSV",
    })!;
    const corrected = { ...address, name: "Jane", address_line1: "20 Updated St" };
    read.mockImplementationOnce(async () => {
      ledger.updateQueuePayload({
        id,
        payload: { ...payload, businessAddress: corrected, businessAddressSource: "manual" },
      });
      return {
        result: { markdown: "Acme headquarters: 10 Main St, Boston, MA 02110, USA", cost: 0.01 },
      };
    });
    await collectQueueBusinessAddress(id);
    expect(JSON.parse(ledger.getQueueRow(id)!.payload_json)).toMatchObject({
      businessAddress: corrected,
      businessAddressSource: "manual",
    });
  });
  it("does not research when the run budget or daily ceiling is exhausted", async () => {
    await researchBusinessAddress({ email: "jane@acme.test" }, "motion", 0);
    allowed = false;
    await researchBusinessAddress({ email: "jane@acme.test" }, "motion");
    expect(read).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });
  it("keeps an imported address without buying research", async () => {
    const result = await researchBusinessAddress(
      { name: "Jane", businessAddress: address },
      "motion",
      0,
    );
    expect(result.address).toMatchObject({ ...address, name: "Jane" });
    expect(read).not.toHaveBeenCalled();
  });
});
