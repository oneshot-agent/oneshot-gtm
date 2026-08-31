import { beforeEach, describe, expect, it, vi } from "vitest";

interface QueueInput {
  playName: string;
  payload: Record<string, string>;
  dedupeKey: string;
  source: string;
}
let queue: QueueInput[] = [];
const ledger = {
  isQueueDuplicate: (playName: string, dedupeKey: string) =>
    queue.some((row) => row.playName === playName && row.dedupeKey === dedupeKey),
  findProspectByEmail: () => null,
  isEmailPendingInQueue: (email: string) =>
    queue.some((row) => row.payload.email?.toLowerCase() === email.toLowerCase()),
  enqueueTarget: (input: QueueInput) => {
    if (ledger.isQueueDuplicate(input.playName, input.dedupeKey)) return null;
    queue.push(input);
    return queue.length;
  },
};

vi.mock("@oneshot-gtm/core", () => ({
  getLedger: () => ledger,
  llmApiKey: () => null,
  loadConfig: () => ({ icpOneLiner: null }),
  logEvent: () => {},
}));

const { importCsv, prepareCsvImport } = await import("../src/csv-import.ts");

beforeEach(() => {
  queue = [];
});

describe("bulk CSV import", () => {
  it("auto-detects headers and imports well-formed rows while skipping malformed rows", async () => {
    const result = await importCsv({
      playName: "profile-intro",
      text: [
        "Work Email,Full Name,Company Name,Job Title",
        'ada@example.test,"Ada, Lovelace",Analytical Engines,Founder',
        "not-an-email,Bad Row,Acme,CEO",
        "grace@example.test,Grace Hopper,Compiler Co,CTO",
      ].join("\n"),
    });

    expect(result.mapping).toEqual({
      email: "Work Email",
      name: "Full Name",
      company: "Company Name",
      title: "Job Title",
    });
    expect(result).toMatchObject({ imported: 2, skipped: 1 });
    expect(result.errors).toEqual([{ row: 3, message: "missing or invalid email" }]);
  });

  it("reports a header mismatch and accepts an explicit mapping override", () => {
    const csv = "Mailbox,Person,Account,Seniority\nada@example.test,Ada,Acme,Founder";
    expect(() => prepareCsvImport(csv)).toThrow(/detect an email column/);
    const prepared = prepareCsvImport(csv, [
      "Mailbox=email",
      "Person=name",
      "Account=company",
      "Seniority=title",
    ]);
    expect(prepared.mapping).toEqual({
      email: "Mailbox",
      name: "Person",
      company: "Account",
      title: "Seniority",
    });
  });

  it("dedupes against an existing queue entry", async () => {
    const email = "queued-existing@example.test";
    ledger.enqueueTarget({
      playName: "profile-intro",
      payload: { email, name: "Already Queued" },
      dedupeKey: "some-finder-specific-key",
      source: "find:test",
    });

    const result = await importCsv({
      playName: "profile-intro",
      text: `email,name,company,title\n${email},Duplicate,Acme,Founder`,
    });
    expect(result).toMatchObject({ imported: 0, skipped: 1, errors: [] });
  });

  it("applies deduplication during a dry run without enqueueing", async () => {
    const email = "queued-existing@example.test";
    ledger.enqueueTarget({
      playName: "profile-intro",
      payload: { email, name: "Already Queued" },
      dedupeKey: "some-finder-specific-key",
      source: "find:test",
    });

    const result = await importCsv({
      playName: "profile-intro",
      text: [
        "email,name,company,title",
        `${email},Duplicate,Acme,Founder`,
        "new@example.test,New Lead,Acme,Founder",
      ].join("\n"),
      dryRun: true,
    });

    expect(result).toMatchObject({ imported: 1, skipped: 1, errors: [] });
    expect(queue).toHaveLength(1);
  });
});
