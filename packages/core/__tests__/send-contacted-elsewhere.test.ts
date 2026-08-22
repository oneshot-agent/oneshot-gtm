import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cross-workspace hold in sendEmail. Another workspace (another product of
// the same founder) emailed this recipient inside the window → auto paths must
// not stack a second motion into the same inbox; the manual queue send passes
// `allowContactedElsewhere` and goes through. Like the bounce backstop it fires
// BEFORE routing/billing. The shared DB is real (isolated by vitest.setup.ts).

const assignSender = vi.fn((_email: string, id: string) => id);

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
      suppressionFor: () => null,
      getSenderAssignment: () => null,
      assignSender,
      recordReceipt: () => 1,
      hasPriorEmailSend: () => false,
      countEmailSendsSince: () => 0,
      firstEmailSendAt: () => null,
    }),
  };
});

const { sendEmail } = await import("../src/oneshot.ts");
const { isRecentlyContacted, isSuppressedRecipient } = await import("../src/send-routing.ts");
const { getSharedDb } = await import("../src/shared-db.ts");

const CTX = { playName: "show-hn", memo: "test" };
const TO = "founder@startup.example";

beforeEach(() => {
  process.env["ONESHOT_GTM_WORKSPACE"] = "gtm";
  assignSender.mockClear();
});
afterEach(() => {
  delete process.env["ONESHOT_GTM_WORKSPACE"];
});

describe("sendEmail cross-workspace hold", () => {
  it("refuses when another workspace emailed the recipient this week", async () => {
    getSharedDb().recordTouch({ email: TO, workspace: "sdk", playName: "post-funding" });
    const err = await sendEmail({ to: TO, subject: "s", body: "b" }, CTX).catch((e: unknown) => e);
    expect(isRecentlyContacted(err)).toBe(true);
    expect(isSuppressedRecipient(err)).toBe(false);
    expect((err as Error).message).toContain("workspace 'sdk'");
    expect((err as Error).message).toContain("post-funding");
    // Before routing: nothing pinned, nothing billed.
    expect(assignSender).not.toHaveBeenCalled();
  });

  it("is not triggered by this workspace's own prior touch", async () => {
    getSharedDb().recordTouch({ email: "own@startup.example", workspace: "gtm", playName: "x" });
    const err = await sendEmail({ to: "own@startup.example", subject: "s", body: "b" }, CTX).catch(
      (e: unknown) => e,
    );
    // Gets past the gate and fails later on the (absent) wallet — proof the
    // hold did not fire.
    expect(isRecentlyContacted(err)).toBe(false);
    expect((err as Error).message).toMatch(/wallet credentials/i);
  });

  it("the manual override passes the gate", async () => {
    getSharedDb().recordTouch({ email: TO, workspace: "sdk", playName: "post-funding" });
    const err = await sendEmail(
      { to: TO, subject: "s", body: "b", allowContactedElsewhere: true },
      CTX,
    ).catch((e: unknown) => e);
    expect(isRecentlyContacted(err)).toBe(false);
    expect((err as Error).message).toMatch(/wallet credentials/i);
  });
});

describe("reservation lifecycle around dispatch", () => {
  it("a failed dispatch releases the reservation — nobody was touched", async () => {
    // No wallet in the test env → dispatch throws after the claim.
    await sendEmail({ to: "fail@startup.example", subject: "s", body: "b" }, CTX).catch(() => {});
    expect(getSharedDb().touchesFor("fail@startup.example")).toEqual([]);
  });

  it("a held send leaves no reservation of its own behind", async () => {
    getSharedDb().recordTouch({ email: "h@startup.example", workspace: "sdk", playName: "p" });
    await sendEmail({ to: "h@startup.example", subject: "s", body: "b" }, CTX).catch(() => {});
    const mine = getSharedDb()
      .touchesFor("h@startup.example")
      .filter((t) => t.workspace === "gtm");
    expect(mine).toEqual([]);
  });
});
