import { beforeEach, expect, it, vi } from "vitest";

// `smartlead connect`: each NEW mailbox gets direct SMTP when its credentials
// resolve, else the Smartlead API with the reason printed. Core and prompts
// are mocked, so no key, network or config is touched.

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  defaultSendVia: vi.fn(),
  lines: [] as string[],
}));

vi.mock("@oneshot-gtm/core", () => ({
  smartleadApiKey: () => "stored-key",
  listSmartleadAccounts: async () => [
    { fromEmail: "direct@mail.example.com", fromName: "D", messagePerDay: 40, isSmtpSuccess: true },
    { fromEmail: "oauth@mail.example.com", fromName: "O", messagePerDay: 40, isSmtpSuccess: true },
  ],
  loadConfig: () => ({}),
  resolveIdentities: () => [],
  registerSmartleadIdentity: mocks.register,
  defaultSendViaForSmartlead: mocks.defaultSendVia,
  saveSecrets: vi.fn(),
  secretsPath: () => "/dev/null",
}));
vi.mock("prompts", () => ({
  default: async (q: { name: string; choices?: { value: unknown }[] }) => ({
    [q.name]: q.choices?.map((choice) => choice.value),
  }),
}));
vi.mock("../src/output.ts", () => {
  const record = (s: string) => void mocks.lines.push(s);
  return {
    c: { cyan: (s: string) => s },
    header: record,
    note: record,
    ok: record,
    warn: (s: string) => record(`WARN ${s}`),
  };
});

const { commandSmartleadConnect } = await import("../src/commands/smartlead.ts");

beforeEach(() => {
  mocks.lines = [];
  mocks.register.mockReset();
  mocks.defaultSendVia.mockReset();
  mocks.register.mockImplementation((input: { address: string }) => ({
    identityId: `smartlead:${input.address}`,
    created: true,
  }));
  mocks.defaultSendVia.mockImplementation(async (address: string) =>
    address.startsWith("direct")
      ? { sendVia: "smtp", reason: null }
      : { sendVia: "provider", reason: "Connect IMAP and SMTP for this Smartlead mailbox." },
  );
});

it("registers each new mailbox on the send path its credentials allow", async () => {
  await commandSmartleadConnect();
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({ address: "direct@mail.example.com", sendVia: "smtp" }),
  );
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({ address: "oauth@mail.example.com", sendVia: "provider" }),
  );
  expect(mocks.lines).toContain("  sends via direct SMTP (duplicate-protected)");
  expect(mocks.lines).toContain(
    "WARN   sends via the Smartlead API (no SMTP credentials: Connect IMAP and SMTP for this Smartlead mailbox.)",
  );
});

it("does not register a mailbox when the credentials lookup failed, and asks for a retry", async () => {
  mocks.defaultSendVia.mockResolvedValue({
    sendVia: "provider",
    reason: "Could not reach Smartlead to resolve mailbox connections.",
    lookupFailed: true,
  });
  try {
    await commandSmartleadConnect();
    // An outage says nothing about the mailbox: it must not land on the unkeyed API path.
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.lines).toContain(
      "WARN   direct@mail.example.com not added: could not check its SMTP credentials (Could not reach Smartlead to resolve mailbox connections.). Re-run `smartlead connect` once Smartlead is reachable.",
    );
    expect(mocks.lines.some((l) => l.includes("not added (lookup failed)"))).toBe(true);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = 0;
  }
});

it("prints no send-path line for a mailbox already in the pool", async () => {
  mocks.register.mockImplementation((input: { address: string }) => ({
    identityId: `smartlead:${input.address}`,
    created: false,
  }));
  await commandSmartleadConnect();
  expect(mocks.lines.some((l) => l.includes("sends via"))).toBe(false);
});
