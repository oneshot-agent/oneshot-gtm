import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailIdentity } from "../src/types.ts";

// Provider dispatch: a smartlead identity must route through the Smartlead
// REST path (mocked fetch) and NEVER fall through to the paid OneShot SDK
// agent; unknown providers must throw; replies from smartlead must throw.
// Config + ledger are mocked so no real ~/.oneshot-gtm is touched.

const recordReceipt = vi.fn().mockReturnValue(42);
const assignSender = vi.fn((_email: string, identityId: string) => identityId);
let identities: EmailIdentity[] = [];

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      founderName: "Jane Doe",
      emailIdentities: identities,
    }),
  };
});

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return {
    ...actual,
    getLedger: () => ({
      suppressionFor: () => null,
      recordReceipt,
      getSenderAssignment: () => null,
      hasPriorEmailSend: () => false,
      assignSender,
      countEmailSendsSince: () => 0,
      firstEmailSendAt: () => null,
    }),
  };
});

const { sendEmail, replyEmail } = await import("../src/oneshot.ts");

const SL_IDENTITY: EmailIdentity = {
  id: "smartlead:jane@acme.com",
  provider: "smartlead",
  label: "Jane",
  address: "jane@acme.com",
  maxPerDay: 50,
  warmup: null,
};

const fetchMock = vi.fn();
let keySnapshot: string | undefined;

beforeEach(() => {
  keySnapshot = process.env["SMARTLEAD_API_KEY"];
  process.env["SMARTLEAD_API_KEY"] = "sl-test-key";
  identities = [SL_IDENTITY];
  recordReceipt.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (keySnapshot === undefined) delete process.env["SMARTLEAD_API_KEY"];
  else process.env["SMARTLEAD_API_KEY"] = keySnapshot;
  vi.unstubAllGlobals();
});

function sendOk() {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ success: true, data: { message: "Email sent", message_id: "msg_1" } }),
      { status: 200 },
    ),
  );
}

describe("dispatch via smartlead", () => {
  it("routes to the Smartlead API and records a truthful receipt", async () => {
    sendOk();
    const { result, receiptId } = await sendEmail(
      { to: "founder@startup.com", subject: "hey", body: "line one\nline two" },
      { playName: "test-play" },
    );
    expect(receiptId).toBe(42);
    expect(result.request_id).toBe("msg_1");
    expect(result.cost).toBe(0);
    // The only network call is Smartlead's — the SDK was never constructed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/send-email/initiate");
    const payload = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      fromEmail: string;
      body: string;
    };
    expect(payload.fromEmail).toBe("jane@acme.com");
    expect(payload.body).toContain("<br>"); // plain text was HTML-ified
    const receipt = recordReceipt.mock.calls[0]![0] as {
      callType: string;
      senderIdentity: string;
      oneshotRequestId: string;
      signedReceipt: Record<string, unknown>;
    };
    expect(receipt.callType).toBe("email.send");
    expect(receipt.senderIdentity).toBe("smartlead:jane@acme.com");
    expect(receipt.oneshotRequestId).toBe("msg_1");
    expect(receipt.signedReceipt["provider"]).toBe("smartlead");
    expect(JSON.stringify(receipt)).not.toContain("sl-test-key");
  });

  it("hard-fails without the API key instead of falling through to the SDK", async () => {
    delete process.env["SMARTLEAD_API_KEY"];
    await expect(
      sendEmail({ to: "a@b.com", subject: "s", body: "b" }, { playName: "test-play" }),
    ).rejects.toThrow(/SMARTLEAD_API_KEY not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hard-fails on a smartlead identity without an address", async () => {
    identities = [{ ...SL_IDENTITY, address: null }];
    await expect(
      sendEmail({ to: "a@b.com", subject: "s", body: "b" }, { playName: "test-play" }),
    ).rejects.toThrow(/no address on Smartlead sender identity/);
  });

  it("an unknown provider throws instead of silently using the OneShot wallet", async () => {
    identities = [{ ...SL_IDENTITY, id: "mystery:x", provider: "mystery" as never }];
    await expect(
      sendEmail({ to: "a@b.com", subject: "s", body: "b" }, { playName: "test-play" }),
    ).rejects.toThrow(/unknown email provider 'mystery'/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("replyEmail with a smartlead identity", () => {
  it("throws (send-only v1) rather than routing through the OneShot wallet", async () => {
    await expect(
      replyEmail(
        {
          identityId: "smartlead:jane@acme.com",
          to: "founder@startup.com",
          subject: "Re: hey",
          body: "thanks!",
        },
        { playName: "inbox" },
      ),
    ).rejects.toThrow(/aren't supported yet/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
