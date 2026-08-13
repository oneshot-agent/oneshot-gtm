import { beforeEach, describe, expect, it, vi } from "vitest";

// The suppression backstop in sendEmail. A OneShot send is BILLED BEFORE
// dispatch, so a send to a known-dead address costs money and sending
// reputation for a message that cannot possibly arrive. This asserts the gate
// fires before any routing, billing or network work happens.

const getSenderAssignment = vi.fn(() => null);
const assignSender = vi.fn((_email: string, id: string) => id);
const recordReceipt = vi.fn().mockReturnValue(1);
/** Set per test: what suppressionFor returns for the recipient. */
let suppression: { status_code: string | null; bounced_at: string } | null = null;

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      emailProvider: "oneshot",
      emailIdentities: null,
      sendingDomain: "corp.example",
      founderName: "Jane Doe",
    }),
  };
});

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return {
    ...actual,
    getLedger: () => ({
      suppressionFor: () => suppression,
      getSenderAssignment,
      assignSender,
      recordReceipt,
      hasPriorEmailSend: () => false,
      countEmailSendsSince: () => 0,
      firstEmailSendAt: () => null,
    }),
  };
});

const { sendEmail } = await import("../src/oneshot.ts");
const { isSuppressedRecipient } = await import("../src/send-routing.ts");

const CTX = { playName: "post-funding", memo: "test" };
const INPUT = { to: "jane@dead.example", subject: "s", body: "b" };

beforeEach(() => {
  suppression = null;
  getSenderAssignment.mockClear();
  assignSender.mockClear();
  recordReceipt.mockClear();
});

describe("sendEmail suppression backstop", () => {
  it("refuses a recipient that previously hard-bounced", async () => {
    suppression = { status_code: "5.1.1", bounced_at: "2026-08-01T10:00:00.000Z" };
    await expect(sendEmail(INPUT, CTX)).rejects.toThrow(/hard-bounced/);
  });

  it("throws a SuppressedRecipientError, not a deferral", async () => {
    // Callers distinguish the two: a deferral leaves work queued for tomorrow,
    // a suppression is permanent and must not be retried.
    suppression = { status_code: "5.1.1", bounced_at: "2026-08-01T10:00:00.000Z" };
    const err = await sendEmail(INPUT, CTX).catch((e: unknown) => e);
    expect(isSuppressedRecipient(err)).toBe(true);
  });

  it("names the address, the code and the date so the refusal is diagnosable", async () => {
    suppression = { status_code: "5.1.1", bounced_at: "2026-08-01T10:00:00.000Z" };
    const err = (await sendEmail(INPUT, CTX).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("jane@dead.example");
    expect(err.message).toContain("5.1.1");
    expect(err.message).toContain("2026-08-01");
  });

  it("gates BEFORE sender routing, so no identity is pinned and nothing is billed", async () => {
    suppression = { status_code: "5.1.1", bounced_at: "2026-08-01T10:00:00.000Z" };
    await sendEmail(INPUT, CTX).catch(() => undefined);
    expect(getSenderAssignment).not.toHaveBeenCalled();
    expect(assignSender).not.toHaveBeenCalled();
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("still tolerates a missing status code", async () => {
    suppression = { status_code: null, bounced_at: "2026-08-01T10:00:00.000Z" };
    await expect(sendEmail(INPUT, CTX)).rejects.toThrow(/not sending/);
  });

  it("lets an address with no bounce history through to routing", async () => {
    suppression = null;
    // Routing runs (and then the real SDK call fails, which is fine) — the
    // point is that the pre-flight didn't short-circuit it.
    await sendEmail(INPUT, CTX).catch(() => undefined);
    expect(getSenderAssignment).toHaveBeenCalled();
  });
});
