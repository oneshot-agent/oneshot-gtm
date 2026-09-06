import { afterEach, describe, expect, it } from "vitest";
import { extractBusinessAddress, requireMailAddress } from "../src/mail-address.ts";
import { Ledger } from "../src/ledger.ts";
const address = {
  name: "Jane Smith",
  address_line1: "10 Main St",
  address_city: "Boston",
  address_state: "MA",
  address_zip: "02110",
  address_country: "US" as const,
};
const ledgers: Ledger[] = [];
afterEach(() => {
  for (const l of ledgers.splice(0)) l.close();
});
describe("business mail address capture", () => {
  it("captures structured and registry addresses without confusing a personal location for a street", () => {
    expect(extractBusinessAddress({ businessAddress: address })).toMatchObject(address);
    expect(
      extractBusinessAddress({
        name: "Company",
        address: "10 Main St",
        city: "Boston",
        state: "MA",
        postalCode: "02110",
      }),
    ).toMatchObject({ ...address, name: "Company" });
    expect(extractBusinessAddress({ name: "Jane", location: "Boston, MA" })).toBeNull();
    expect(extractBusinessAddress({ ...address, address_zip: "" })).toBeNull();
    expect(extractBusinessAddress({ ...address, address_country: "AT" })).toBeNull();
  });
  it("requires complete single-line mailing fields", () => {
    expect(() => requireMailAddress({ ...address, name: "" })).toThrow();
    expect(() =>
      requireMailAddress({ ...address, address_line1: "10 Main\nAnother address" }),
    ).toThrow();
  });
  it("carries an imported address from queue to prospect without changing the workspace return address", () => {
    const l = new Ledger(":memory:");
    ledgers.push(l);
    const from = { ...address, name: "Founder", address_line1: "20 Main St" };
    l.setMailAddress("return", from);
    const q = l.enqueueTarget({
      playName: "mail",
      payload: { ...address, email: "jane@example.test" },
      dedupeKey: "jane",
      source: "CSV",
    })!;
    const id = l.upsertProspect({ email: "jane@example.test", name: "Jane Smith" });
    l.setQueueProspectId(q, id);
    expect(l.getMailAddress(`prospect:${id}`)).toMatchObject(address);
    expect(l.getMailAddressMetadata(`prospect:${id}`)?.source).toBe("CSV");
    l.setMailAddress(`prospect:${id}`, { ...address, address_line1: "30 Main St" });
    l.setQueueProspectId(q, id);
    expect(l.getMailAddress(`prospect:${id}`)?.address_line1).toBe("30 Main St");
    expect(l.getMailAddress("return")).toEqual(from);
  });
});
