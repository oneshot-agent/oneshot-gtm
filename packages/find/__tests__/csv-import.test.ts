import { beforeEach, describe, expect, it, vi } from "vitest";

const qualifyPersonMock = vi.fn(async () => ({ verdict: "pass" as const, reason: "stub" }));

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

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => null,
  qualifyPerson: qualifyPersonMock,
}));

const { importCsv, prepareCsvImport } = await import("../src/csv-import.ts");

beforeEach(() => {
  queue = [];
  qualifyPersonMock.mockClear();
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
    expect(qualifyPersonMock).not.toHaveBeenCalled();
  });

  it("simulates within-file dedupe during a dry run", async () => {
    const result = await importCsv({
      playName: "profile-intro",
      text: [
        "email,name,company,title",
        "same@example.test,First,Acme,Founder",
        "same@example.test,Second,Acme,Founder",
      ].join("\n"),
      dryRun: true,
    });

    expect(result).toMatchObject({ imported: 1, skipped: 1, rowCount: 2 });
    expect(queue).toHaveLength(0);
    expect(qualifyPersonMock).not.toHaveBeenCalled();
  });

  it("limits each invocation to 100 source rows", async () => {
    const rows = Array.from(
      { length: 101 },
      (_, index) => `person-${index}@example.test,Person ${index},Acme,Founder`,
    );
    const result = await importCsv({
      playName: "profile-intro",
      text: ["email,name,company,title", ...rows].join("\n"),
    });

    expect(result).toMatchObject({ imported: 100, skipped: 0, rowCount: 100 });
    expect(queue).toHaveLength(100);
    expect(qualifyPersonMock).toHaveBeenCalledTimes(100);
  });
});
