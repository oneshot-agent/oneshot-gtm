import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let ids: { id: string; provider: string; address: string }[];
vi.mock("../src/config.ts", () => ({
  configDir: () => home,
  loadConfig: () => ({ emailIdentities: ids }),
}));
vi.mock("../src/identities.ts", () => ({
  resolveIdentities: (cfg: { emailIdentities: unknown[] }) => cfg.emailIdentities,
}));
const { mailboxConnection, saveMailboxConnection, resetMailboxConnections } =
  await import("../src/mailbox-config.ts");
const fetchMock = vi.fn();
const row = (address: string) => ({
  from_email: address,
  imap_host: "imap.example.com",
  imap_port: 993,
  smtp_host: "smtp.example.com",
  smtp_port: 587,
  password: Buffer.from("app-secret").toString("base64"),
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mailbox-config-"));
  ids = [{ id: "smartlead:a@example.com", provider: "smartlead", address: "a@example.com" }];
  resetMailboxConnections();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SMARTLEAD_API_KEY", "workspace-a-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it("decodes credentials only for a registered mailbox and requires encrypted transports", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify([row("other@example.com"), row("a@example.com")])),
  );
  const connection = await mailboxConnection(ids[0]!.id);
  expect(connection.address).toBe("a@example.com");
  expect(connection.imap.pass).toBe("app-secret");
  expect(connection.imap.secure).toBe(true);
  expect(connection.smtp.secure).toBe(false); // Requires STARTTLS in the transport.
  await expect(mailboxConnection("smartlead:other@example.com")).rejects.toThrow(
    /no longer connected/,
  );
});

it("invalidates the account cache when the workspace API key changes", async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify([row("a@example.com")])));
  await mailboxConnection(ids[0]!.id);
  await mailboxConnection(ids[0]!.id);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.stubEnv("SMARTLEAD_API_KEY", "workspace-b-key");
  await mailboxConnection(ids[0]!.id);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(new URL(fetchMock.mock.calls[1]![0]).searchParams.get("api_key")).toBe("workspace-b-key");
});

it("offers connection setup for accounts with no usable direct credentials", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify([{ from_email: "a@example.com" }])));
  await expect(mailboxConnection(ids[0]!.id)).rejects.toThrow(/Connect IMAP and SMTP/);
});

it("stores explicit connection credentials privately and never accepts another workspace identity", async () => {
  const connection = {
    address: "a@example.com",
    imap: { host: "imap.example.com", port: 993, secure: true, user: "a", pass: "imap-secret" },
    smtp: { host: "smtp.example.com", port: 587, secure: false, user: "a", pass: "smtp-secret" },
  };
  saveMailboxConnection(ids[0]!.id, connection);
  expect(statSync(join(home, "mailbox-connections.json")).mode & 0o777).toBe(0o600);
  expect(await mailboxConnection(ids[0]!.id)).toEqual(connection);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(() => saveMailboxConnection("smartlead:other@example.com", connection)).toThrow(
    /does not belong/,
  );
});

it("does not expose an upstream error body or API key", async () => {
  fetchMock.mockResolvedValue(
    new Response("password=secret api_key=workspace-a-key", { status: 401 }),
  );
  await expect(mailboxConnection(ids[0]!.id)).rejects.toThrow(
    "Smartlead connection lookup failed (HTTP 401). Reconnect in Setup.",
  );
});
