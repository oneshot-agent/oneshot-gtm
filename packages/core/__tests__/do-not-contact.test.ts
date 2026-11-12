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

const LIST = { domains: ["dental.example"], companies: ["Example Dental"] };

describe("doNotContactOf", () => {
  it("reduces domains to bare hosts and drops blanks and repeats", () => {
    expect(
      doNotContactOf({
        doNotContact: {
          domains: ["https://www.Dental.Example/about", "dental.example", " ", 7],
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

  it("bareDomain cuts the path before reading an `@`", () => {
    expect(bareDomain("https://www.dental.example/@team")).toBe("dental.example");
    expect(bareDomain("www.dental.example/@team")).toBe("dental.example");
    expect(bareDomain("https://user@dental.example/x")).toBe("dental.example");
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

  it("keeps the last list while the file does not parse", () => {
    writeList({ companies: ["Example Dental"] });
    expect(currentDoNotContact().companies).toEqual(["Example Dental"]);
    writeFileSync(configFile(), '{"doNotContact": {"companies": [');
    expect(currentDoNotContact().companies).toEqual(["Example Dental"]);
    writeList({ companies: ["Other Group"] });
    expect(currentDoNotContact().companies).toEqual(["Other Group"]);
  });
});

describe("doNotContactMatch", () => {
  it("matches the email's domain and any subdomain of a listed one", () => {
    expect(doNotContactMatch({ email: "dana@dental.example" }, LIST)).toEqual({
      kind: "domain",
      entry: "dental.example",
    });
    expect(doNotContactMatch({ email: "dana@mail.dental.example" }, LIST)?.kind).toBe("domain");
    expect(doNotContactMatch({ website: "https://www.dental.example/team" }, LIST)?.kind).toBe(
      "domain",
    );
    expect(doNotContactMatch({ email: "dana@notdental.example" }, LIST)).toBeNull();
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

  it("keeps the form words of an entry made only of them", () => {
    const list = { domains: [], companies: ["The Limited"] };
    expect(doNotContactMatch({ company: "The Limited, Inc." }, list)?.kind).toBe("company");
    expect(doNotContactMatch({ company: "Limited Brands" }, list)).toBeNull();
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
      doNotContactMatch({ email: "dana@dental.example", company: "Example Dental" }, empty),
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

  it("finds a prospect's company through the website their queue row names", () => {
    rmSync(configFile(), { force: true });
    ledger.enqueueTarget({
      playName: "design-partner-loi",
      payload: { name: "Dana Lee", email: "dana@gmail.example", website: "https://dental.example" },
      dedupeKey: "dana",
      source: "test",
    });
    const id = ledger.upsertProspect({ name: "Dana Lee", email: "dana@gmail.example" });
    writeList(LIST);
    expect(doNotContactMatch(ledger.contactIdentityFor({ prospectId: id }), LIST)?.kind).toBe(
      "domain",
    );
    expect(
      canInviteOnLinkedIn(
        {
          prospectId: id,
          name: "Dana Lee",
          email: "dana@gmail.example",
          linkedinUrl: "https://www.linkedin.com/in/dana-lee",
        },
        { ledger, shared, inbox: { hasConversationWith: () => false } },
      ),
    ).toMatchObject({ ok: false, reason: "do-not-contact" });
  });

  it("rejects an unsent row and leaves a sent one", () => {
    rmSync(configFile(), { force: true });
    const unsent = ledger.enqueueTarget({
      playName: "p",
      payload: { email: "a@dental.example" },
      dedupeKey: "a",
      source: "test",
    })!;
    const sent = ledger.enqueueTarget({
      playName: "p",
      payload: { email: "b@dental.example" },
      dedupeKey: "b",
      source: "test",
    })!;
    ledger.setQueueStatus({ id: sent, status: "sent" });
    expect(ledger.rejectUnsentForDoNotContact(unsent, "auto: do-not-contact — x")).toBe(true);
    expect(ledger.rejectUnsentForDoNotContact(sent, "auto: do-not-contact — x")).toBe(false);
    expect(ledger.getQueueRow(sent)!.status).toBe("sent");
  });

  it("refuses an invite by the website the row names", () => {
    const verdict = canInviteOnLinkedIn(
      {
        name: "Dana Lee",
        company: "Acme",
        email: "dana@gmail.example",
        identity: { website: "https://www.dental.example" },
        linkedinUrl: "https://www.linkedin.com/in/dana-lee",
      },
      { ledger, shared, inbox: { hasConversationWith: () => false } },
    );
    expect(verdict).toMatchObject({ ok: false, reason: "do-not-contact" });
  });

  it("refuses a LinkedIn invite to someone at a listed company", () => {
    const verdict = canInviteOnLinkedIn(
      {
        name: "Dana Lee",
        company: "Acme",
        email: "dana@dental.example",
        linkedinUrl: "https://www.linkedin.com/in/dana-lee",
      },
      { ledger, shared, inbox: { hasConversationWith: () => false } },
    );
    expect(verdict).toMatchObject({ ok: false, reason: "do-not-contact" });
  });
});
