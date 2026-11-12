import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareDomain, configDir, currentDoNotContact, doNotContactOf } from "../src/config.ts";
import { doNotContactMatch, queuePayloadIdentity } from "../src/do-not-contact.ts";
import { Ledger } from "../src/ledger.ts";
import { canInviteOnLinkedIn } from "../src/linkedin-guard.ts";
import { SharedDb } from "../src/shared-db.ts";

const configFile = () => join(configDir(), "config.json");
function writeList(doNotContact: unknown): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ doNotContact }));
}

const LIST = { domains: ["example-dental.com"], companies: ["Example Dental"] };

describe("doNotContactOf", () => {
  it("reduces domains to bare hosts and drops blanks and repeats", () => {
    expect(
      doNotContactOf({
        doNotContact: {
          domains: ["https://www.Example-Dental.com/about", "example-dental.com", " ", 7],
          companies: ["  Example   Dental ", "Example Dental", ""],
        },
      }),
    ).toEqual(LIST);
  });

  it("reads a lone string as one entry and anything else as none", () => {
    expect(doNotContactOf({ doNotContact: { companies: "Example Dental" } }).companies).toEqual([
      "Example Dental",
    ]);
    expect(doNotContactOf({})).toEqual({ domains: [], companies: [] });
    expect(doNotContactOf({ doNotContact: "example.com" })).toEqual({ domains: [], companies: [] });
  });

  it("bareDomain reads an address, a URL or a host", () => {
    expect(bareDomain("Dana@Mail.Example.com")).toBe("mail.example.com");
    expect(bareDomain("http://www.example.com:8080/x?y")).toBe("example.com");
    expect(bareDomain("localhost")).toBeNull();
  });
});

describe("currentDoNotContact", () => {
  afterEach(() => rmSync(configFile(), { force: true }));

  it("reads none with no config file, then sees a hand edit", () => {
    rmSync(configFile(), { force: true });
    expect(currentDoNotContact()).toEqual({ domains: [], companies: [] });
    writeList({ companies: ["Example Dental"] });
    expect(currentDoNotContact().companies).toEqual(["Example Dental"]);
  });
});

describe("doNotContactMatch", () => {
  it("matches the email's domain and any subdomain of a listed one", () => {
    expect(doNotContactMatch({ email: "dana@example-dental.com" }, LIST)).toEqual({
      kind: "domain",
      entry: "example-dental.com",
    });
    expect(doNotContactMatch({ email: "dana@mail.example-dental.com" }, LIST)?.kind).toBe("domain");
    expect(doNotContactMatch({ website: "https://www.example-dental.com/team" }, LIST)?.kind).toBe(
      "domain",
    );
    expect(doNotContactMatch({ email: "dana@notexample-dental.com" }, LIST)).toBeNull();
  });

  it("matches the company name with its legal form or a place added", () => {
    for (const company of [
      "Example Dental",
      "Example Dental, PLLC",
      "The Example Dental Group",
      "Example Dental of Springfield",
      "EXAMPLE-DENTAL DDS",
    ]) {
      expect(doNotContactMatch({ company }, LIST), company).toEqual({
        kind: "company",
        entry: "Example Dental",
      });
    }
  });

  it("does not match a company that only shares some of the words", () => {
    expect(doNotContactMatch({ company: "Example Family Dental" }, LIST)).toBeNull();
    expect(doNotContactMatch({ company: "Example" }, LIST)).toBeNull();
    expect(doNotContactMatch({ company: "Dental Example" }, LIST)).toBeNull();
  });

  it("checks every value a field holds", () => {
    expect(
      doNotContactMatch({ company: ["Acme", "Example Dental"], email: [null, "a@acme.com"] }, LIST)
        ?.kind,
    ).toBe("company");
  });

  it("blocks nobody with an empty list", () => {
    const empty = { domains: [], companies: [] };
    expect(
      doNotContactMatch({ email: "dana@example-dental.com", company: "Example Dental" }, empty),
    ).toBeNull();
  });

  it("reads the identity keys finders write", () => {
    const identity = queuePayloadIdentity({
      founderEmail: "x@acme.com",
      companyName: "Acme",
      newCompany: "Example Dental",
      companyDomain: "acme.com",
      websiteUrl: "https://acme.com",
    });
    expect(doNotContactMatch(identity, LIST)?.kind).toBe("company");
    expect(queuePayloadIdentity(null)).toEqual({});
  });
});

describe("the gates", () => {
  let dir: string;
  let ledger: Ledger;
  let shared: SharedDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "do-not-contact-"));
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    shared = new SharedDb(join(dir, "shared.sqlite"));
    writeList(LIST);
  });
  afterEach(() => {
    ledger.close();
    shared.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(configFile(), { force: true });
  });

  it("queues a listed company's row as rejected, with the reason", () => {
    const id = ledger.enqueueTarget({
      playName: "design-partner-loi",
      payload: { name: "Dana Lee", email: "dana@other.com", company: "Example Dental, PLLC" },
      dedupeKey: "dana",
      source: "test",
      notes: "fit: ops lead",
    });
    const row = ledger.getQueueRow(id!)!;
    expect(row.status).toBe("rejected");
    expect(row.decision).toBe("auto_reject");
    expect(row.notes).toMatch(/^auto: do-not-contact — the company "Example Dental"/);
    expect(row.notes).toContain("fit: ops lead");
  });

  it("queues anyone else as pending", () => {
    const id = ledger.enqueueTarget({
      playName: "design-partner-loi",
      payload: { name: "Sam Roe", email: "sam@acme.com", company: "Acme Dental" },
      dedupeKey: "sam",
      source: "test",
    });
    expect(ledger.getQueueRow(id!)!.status).toBe("pending");
  });

  it("refuses a LinkedIn invite to someone at a listed company", () => {
    const verdict = canInviteOnLinkedIn(
      {
        name: "Dana Lee",
        company: "Acme",
        email: "dana@example-dental.com",
        linkedinUrl: "https://www.linkedin.com/in/dana-lee",
      },
      { ledger, shared, inbox: { hasConversationWith: () => false } },
    );
    expect(verdict).toMatchObject({ ok: false, reason: "do-not-contact" });
  });
});
