import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
let ledger: Ledger;
vi.mock("../src/ledger.ts", async () => ({
  ...(await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts")),
  getLedger: () => ledger,
}));
const { captureSdkBusinessAddress, extractSdkBusinessAddress } =
  await import("../src/mail-enrichment.ts");
const address = {
  name: "Acme",
  address_line1: "1 Main St",
  address_city: "Boston",
  address_state: "MA",
  address_zip: "02110",
  address_country: "US" as const,
};
beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => ledger.close());
it("saves SDK company addresses for the company and prospect without overwriting corrections", () => {
  const id = ledger.upsertProspect({ name: "Jane", email: "jane@acme.test" });
  const context = {
    companyDomain: "acme.test",
    email: "jane@acme.test",
    source: "sdk:enrich.company",
  };
  captureSdkBusinessAddress({ company: { address } }, context);
  expect(ledger.getMailAddress(`prospect:${id}`)).toMatchObject({ ...address, name: "Jane" });
  expect(ledger.getMailAddressMetadata(`prospect:${id}`)?.source).toBe(context.source);
  expect(ledger.getMailAddress("company:acme.test")).toMatchObject(address);
  ledger.setMailAddress(`prospect:${id}`, { ...address, address_line1: "2 Updated St" });
  captureSdkBusinessAddress({ company: { address } }, context);
  expect(ledger.getMailAddress(`prospect:${id}`)?.address_line1).toBe("2 Updated St");
});
it("accepts business fields and rejects person addresses and free-text locations", () => {
  expect(extractSdkBusinessAddress({ profile: { company_address: address } })).toMatchObject(
    address,
  );
  expect(extractSdkBusinessAddress({ profile: { address, location: "Boston, MA" } })).toBeNull();
  expect(extractSdkBusinessAddress({ company: { location: "Boston, MA" } })).toBeNull();
  expect(
    extractSdkBusinessAddress({ company: { address: { ...address, address_country: "GB" } } }),
  ).toBeNull();
});
