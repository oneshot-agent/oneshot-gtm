import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, loadConfig } from "./config.ts";
import { resolveIdentities } from "./identities.ts";
import { smartleadApiKey } from "./smartlead.ts";

export interface MailboxConnection {
  address: string;
  imap: { host: string; port: number; secure: boolean; user: string; pass: string };
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
}

/** Return Smartlead identities configured in the active workspace. */
export function smartleadMailboxIdentities() {
  return resolveIdentities(loadConfig()).filter((i) => i.provider === "smartlead");
}

let cached: {
  workspace: string;
  apiKey: string;
  at: number;
  rows: Record<string, unknown>[];
} | null = null;

/** Normalize an unknown provider field to a trimmed string. */
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** Decode a provider's optional base64-encoded credential field. */
const decode = (v: unknown): string => (v ? Buffer.from(str(v), "base64").toString("utf8") : "");

/** This module is deliberately not re-exported by the public core barrel. */
async function accounts(): Promise<Record<string, unknown>[]> {
  const apiKey = smartleadApiKey();
  if (!apiKey) throw new Error("Smartlead API key is missing. Reconnect Smartlead in Setup.");
  const workspace = configDir();
  if (
    cached?.workspace === workspace &&
    cached.apiKey === apiKey &&
    Date.now() - cached.at < 5 * 60_000
  )
    return cached.rows;
  const rows: Record<string, unknown>[] = [];
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({
      api_key: apiKey,
      limit: "100",
      offset: String(page * 100),
    });
    let response: Response;
    try {
      response = await fetch(`https://server.smartlead.ai/api/v1/email-accounts/?${query}`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Could not reach Smartlead to resolve mailbox connections.");
    }
    if (!response.ok)
      throw new Error(
        `Smartlead connection lookup failed (HTTP ${response.status}). Reconnect in Setup.`,
      );
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error("Smartlead returned an invalid mailbox list.");
    rows.push(...data);
    if (data.length < 100) {
      cached = { workspace, apiKey, at: Date.now(), rows };
      return rows;
    }
  }
  throw new Error("Smartlead mailbox listing is incomplete.");
}

/** Clear the workspace-scoped Smartlead account cache. */
export function resetMailboxConnections(): void {
  cached = null;
}

/** Validate the required IMAP and SMTP connection fields. */
export function validateMailboxConnection(input: MailboxConnection): MailboxConnection {
  if (!input || typeof input.address !== "string") throw new Error("Mailbox address is required.");
  for (const transport of [input.imap, input.smtp]) {
    if (
      !transport ||
      !transport.host?.trim() ||
      !transport.user?.trim() ||
      !transport.pass ||
      !Number.isInteger(transport.port) ||
      transport.port < 1 ||
      transport.port > 65535 ||
      typeof transport.secure !== "boolean"
    ) {
      throw new Error("Both IMAP and SMTP need a host, port, username, password, and TLS mode.");
    }
  }
  return input;
}

/** Read manually configured mailbox connections for the active workspace. */
function overrides(): Record<string, MailboxConnection> {
  const path = join(configDir(), "mailbox-connections.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/** Persist a verified mailbox connection with owner-only permissions. */
export function saveMailboxConnection(identityId: string, input: MailboxConnection): void {
  const identity = smartleadMailboxIdentities().find((i) => i.id === identityId);
  if (!identity?.address || identity.address.toLowerCase() !== input.address?.toLowerCase())
    throw new Error("Mailbox does not belong to this workspace identity.");
  const next = { ...overrides(), [identityId]: validateMailboxConnection(input) };
  const path = join(configDir(), "mailbox-connections.json");
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
  resetMailboxConnections();
}

/** Resolve a mailbox connection from workspace overrides or Smartlead. */
export async function mailboxConnection(identityId: string): Promise<MailboxConnection> {
  const identity = smartleadMailboxIdentities().find((i) => i.id === identityId);
  if (!identity?.address)
    throw new Error("This mailbox identity is no longer connected to this workspace.");
  const address = identity.address.toLowerCase();
  const override = overrides()[identityId];
  if (override && override.address.toLowerCase() === address)
    return validateMailboxConnection(override);
  const row = (await accounts()).find((a) => str(a["from_email"]).toLowerCase() === address);
  if (!row) throw new Error("This mailbox is missing from this workspace's Smartlead account.");
  const pass = decode(row["password"]);
  const user = str(row["username"] ?? row["user_name"]) || address;
  const imapPass = decode(row["imap_password"]) || pass;
  const imapPort = Number(row["imap_port"]) || 993;
  const smtpPort = Number(row["smtp_port"]) || 587;
  const connection: MailboxConnection = {
    address,
    imap: {
      host: str(row["imap_host"]),
      port: imapPort,
      secure: imapPort === 993,
      user: str(row["imap_username"]) || user,
      pass: imapPass,
    },
    smtp: { host: str(row["smtp_host"]), port: smtpPort, secure: smtpPort === 465, user, pass },
  };
  try {
    return validateMailboxConnection(connection);
  } catch {
    throw new Error(
      "Direct mailbox credentials are unavailable. Connect IMAP and SMTP in the inbox's mailbox settings.",
    );
  }
}
