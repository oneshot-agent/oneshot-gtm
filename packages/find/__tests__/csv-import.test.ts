import { beforeEach, describe, expect, it, vi } from "vitest";

const qualifyPersonMock = vi.fn(
  async (): Promise<{ verdict: "pass" | "reject" | "transient"; reason: string }> => ({
    verdict: "pass",
    reason: "stub",
  }),
);

interface QueueInput {
  playName: string;
  payload: Record<string, string>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}
type QueueRow = QueueInput & { status: string; notes?: string };
let queue: QueueRow[] = [];
const ledger = {
  isQueueDuplicate: (playName: string, dedupeKey: string) =>
    queue.some((row) => row.playName === playName && row.dedupeKey === dedupeKey),
  findProspectByEmail: () => null,
  isEmailPendingInQueue: (email: string) =>
    queue.some((row) => row.payload.email?.toLowerCase() === email.toLowerCase()),
  enqueueTarget: (input: QueueInput) => {
    if (ledger.isQueueDuplicate(input.playName, input.dedupeKey)) return null;
    queue.push({ ...input, status: input.initialStatus ?? "pending" });
    return queue.length;
  },
  setQueueStatus: (input: { id: number; status: string; notes?: string }) => {
    const row = queue[input.id - 1];
    if (!row) return;
    row.status = input.status;
    if (input.notes !== undefined) row.notes = input.notes;
  },
  removePendingQueueTarget: (id: number) => {
    if (queue[id - 1]?.status !== "pending") return false;
    return queue.splice(id - 1, 1).length > 0;
  },
  removeExpiredQueueTarget: (id: number) => {
    if (queue[id - 1]?.status !== "expired") return false;
    return queue.splice(id - 1, 1).length > 0;
  },
  setQueueNotes: () => {},
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

  it("maps the exact explicitly named header when normalized headers collide", () => {
    const prepared = prepareCsvImport("E-mail,Email\nselected@example.test,other@example.test", [
      "E-mail=email",
    ]);
    expect(prepared.mapping.email).toBe("E-mail");
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

  it("atomically reserves a candidate before classification", async () => {
    let release!: () => void;
    qualifyPersonMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => (release = () => resolve({ verdict: "pass", reason: "stub" }))),
    );
    const input = {
      playName: "profile-intro",
      text: "email,name,company,title\nsame@example.test,Same,Acme,Founder",
    };

    const first = importCsv(input);
    expect(qualifyPersonMock).toHaveBeenCalledTimes(1);
    const second = await importCsv(input);
    expect(second).toMatchObject({ imported: 0, skipped: 1 });
    expect(qualifyPersonMock).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ imported: 1, skipped: 0 });
  });

  it("removes the expired reservation when classification fails transiently", async () => {
    qualifyPersonMock.mockResolvedValueOnce({ verdict: "transient", reason: "try later" });

    const result = await importCsv({
      playName: "profile-intro",
      text: "email,name,company,title\nretry@example.test,Retry,Acme,Founder",
    });

    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(queue).toHaveLength(0);
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

  it("imports every source row", async () => {
    const rows = Array.from(
      { length: 101 },
      (_, index) => `person-${index}@example.test,Person ${index},Acme,Founder`,
    );
    const result = await importCsv({
      playName: "profile-intro",
      text: ["email,name,company,title", ...rows].join("\n"),
    });

    expect(result).toMatchObject({ imported: 101, skipped: 0, rowCount: 101 });
    expect(queue).toHaveLength(101);
    expect(qualifyPersonMock).toHaveBeenCalledTimes(101);
  });
});
