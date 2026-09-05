import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { safeParseJsonRecord } from "./json.ts";
import type { OneShotConfig } from "./types.ts";

// Data dir for config.json, .env, ledger.sqlite, events.jsonl, gmail-tokens.json.
// `ONESHOT_GTM_HOME` overrides the default — tests redirect data-dir I/O to a temp
// dir (see vitest.setup.ts) so they never touch the real ~/.oneshot-gtm. Read once
// at module load.
const CONFIG_DIR = process.env["ONESHOT_GTM_HOME"]?.trim() || join(homedir(), ".oneshot-gtm");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const SECRETS_PATH = join(CONFIG_DIR, ".env");

export const SECRET_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  "AGENT_PRIVATE_KEY",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "SMARTLEAD_API_KEY",
  "LINKEDIN_REPLY_WEBHOOK_SECRET",
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

const DEFAULTS: OneShotConfig = {
  walletMode: "cdp",
  llmProvider: "openrouter",
  llmModel: "anthropic/claude-sonnet-4.6",
  telemetryEnabled: true,
  founderName: null,
  founderEmail: null,
  productOneLiner: null,
  productDomain: null,
  sendingDomain: null,
  emailProvider: "oneshot",
  emailIdentities: null,
  icpOneLiner: null,
  cadenceOverrides: null,
  queueReviewOrder: "newest",
  founderCredentials: null,
  productPortfolio: null,
  partners: null,
  founderCohort: null,
  founderAdmission: null,
  productBrief: null,
  mobileSignature: false,
  timezone: null,
  clientId: null,
  dailySpendCeilingUsd: null,
};

export function configDir(): string {
  return CONFIG_DIR;
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): OneShotConfig {
  const raw = readConfigOrDefault();
  const { cfg, minted } = bootstrapClientId(raw);
  // First-sight bootstrap of the anonymous install id. Persisted immediately
  // so subsequent reads (and any future telemetry sink) see a stable value.
  // Failures are non-fatal: returning the in-memory id still works for this
  // process, we just won't have it on disk yet — next call will retry.
  if (minted) {
    try {
      saveConfig(cfg);
    } catch {
      // ignore — read-only fs, permission denied, etc. Caller still gets the id.
    }
  }
  return cfg;
}

let cachedConfig: OneShotConfig | null = null;

/**
 * Process-memoized `loadConfig` for hot read-only callers (telemetry emit).
 * Busted by `saveConfig`; a write from a SEPARATE process only propagates on
 * this process's next write or restart — the ONESHOT_GTM_TELEMETRY=0 env kill
 * switch (checked live in `shouldSendTelemetry`) is the immediate override.
 */
export function loadConfigCached(): OneShotConfig {
  return (cachedConfig ??= loadConfig());
}

/** Test-only: drop the memoized config so a case can change the file underneath it. */
export function _resetConfigCacheForTests(): void {
  cachedConfig = null;
}

/**
 * Mint a clientId when null/empty; `minted: true` signals the caller to
 * persist. Pure so it's testable without the real config file.
 */
export function bootstrapClientId(cfg: OneShotConfig): {
  cfg: OneShotConfig;
  minted: boolean;
} {
  if (cfg.clientId && cfg.clientId.length > 0) return { cfg, minted: false };
  return { cfg: { ...cfg, clientId: randomUUID() }, minted: true };
}

function readConfigOrDefault(): OneShotConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: OneShotConfig): void {
  ensureConfigDir();
  if (!existsSync(dirname(CONFIG_PATH))) mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  // Bust the read cache so loadConfigCached() reflects this write (same process).
  cachedConfig = null;
}

export function secretsPath(): string {
  return SECRETS_PATH;
}

function loadSecretsFile(): Record<string, string> {
  if (!existsSync(SECRETS_PATH)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(SECRETS_PATH, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Env-only credentials read directly from the environment by finders. Demo
 * mode must neutralize these too — same leak category as a real wallet key.
 */
export const ENV_ONLY_SECRET_KEYS = [
  "GITHUB_TOKEN",
  "LUMA_SESSION_COOKIE",
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_SECRET",
  "TWITTERAPI_IO_KEY",
  "SAM_GOV_API_KEY",
] as const;
export type EnvOnlySecretKey = (typeof ENV_ONLY_SECRET_KEYS)[number];

function applySecretsToEnv(): void {
  const stored = loadSecretsFile();

  // Demo mode (checked inline — importing demo.ts would be circular): this
  // home's .env is the SOLE secret source, never a fallback for blanks. The
  // CLI parent's inherited env and Bun's auto-loaded repo-root .env would both
  // shadow demo placeholders with live keys — overwrite-or-delete closes both.
  if (process.env["ONESHOT_GTM_DEMO"] === "1") {
    for (const k of [...SECRET_KEYS, ...ENV_ONLY_SECRET_KEYS]) {
      const v = stored[k];
      if (v) process.env[k] = v;
      else delete process.env[k];
    }
    return;
  }

  for (const [k, v] of Object.entries(stored)) {
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

/** Test-only re-run hook — applySecretsToEnv normally fires once at import. */
export function _applySecretsToEnvForTests(): void {
  applySecretsToEnv();
}

export function saveSecrets(updates: Partial<Record<SecretKey | EnvOnlySecretKey, string>>): void {
  ensureConfigDir();
  const existing = loadSecretsFile();
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === "") continue;
    existing[k] = v;
  }
  const lines = [
    "# oneshot-gtm secrets — do not commit",
    "# this file is read on every CLI invocation; values here override blank process.env",
    "",
    // Env-only keys (GITHUB_TOKEN, the X credentials, …) are writable here —
    // /setup and `config keys` store them; only `init` never asks, and demo
    // mode still neutralizes them. This rewrites the whole file, so every key
    // in either list has to survive the filter or a save silently deletes a
    // working credential.
    ...Object.entries(existing)
      .filter(
        ([k]) =>
          SECRET_KEYS.includes(k as SecretKey) ||
          ENV_ONLY_SECRET_KEYS.includes(k as EnvOnlySecretKey),
      )
      .map(([k, v]) => `${k}=${v}`),
    "",
  ];
  writeFileSync(SECRETS_PATH, lines.join("\n"));
  try {
    chmodSync(SECRETS_PATH, 0o600);
  } catch {
    // chmod may fail on Windows; the file is still in $HOME so reasonably scoped.
  }
  // reflect new values into the running process so `doctor` etc see them immediately
  for (const [k, v] of Object.entries(updates)) {
    if (v) process.env[k] = v;
  }
}

export function secretSource(key: SecretKey | EnvOnlySecretKey): "env" | "file" | null {
  // process.env was populated either by the shell (env) or by applySecretsToEnv (file).
  // We can distinguish by checking the file directly.
  const fromFile = loadSecretsFile();
  if (fromFile[key]) {
    // If the shell ALSO has it AND it differs from the file, the shell value wins (we only fill blanks).
    if (process.env[key] && process.env[key] !== fromFile[key]) return "env";
    return "file";
  }
  if (process.env[key]) return "env";
  return null;
}

// Auto-apply on first import so downstream code sees keys in process.env without ceremony.
applySecretsToEnv();

const GMAIL_TOKENS_PATH = join(CONFIG_DIR, "gmail-tokens.json");

export interface GmailTokenEntry {
  refreshToken: string;
  address: string;
}

/**
 * Per-identity Gmail refresh tokens. Lives outside the .env SECRET_KEYS
 * whitelist because the key set is dynamic (one token per authorized
 * account). Same trust level as .env: chmod 600, local-only.
 */
export function loadGmailTokens(): Record<string, GmailTokenEntry> {
  if (!existsSync(GMAIL_TOKENS_PATH)) return {};
  let raw: string;
  try {
    raw = readFileSync(GMAIL_TOKENS_PATH, "utf8");
  } catch {
    return {};
  }
  const parsed = safeParseJsonRecord(raw) ?? {};
  const out: Record<string, GmailTokenEntry> = {};
  for (const [id, entry] of Object.entries(parsed)) {
    const e = entry as Partial<GmailTokenEntry> | null;
    if (e && typeof e === "object" && typeof e.refreshToken === "string" && e.refreshToken) {
      out[id] = {
        refreshToken: e.refreshToken,
        address: typeof e.address === "string" ? e.address : "",
      };
    }
  }
  return out;
}

export function saveGmailToken(identityId: string, entry: GmailTokenEntry): void {
  ensureConfigDir();
  const all = loadGmailTokens();
  all[identityId] = entry;
  writeFileSync(GMAIL_TOKENS_PATH, JSON.stringify(all, null, 2));
  try {
    chmodSync(GMAIL_TOKENS_PATH, 0o600);
  } catch {
    // chmod may fail on Windows; the file is still in $HOME so reasonably scoped.
  }
}

export function deleteGmailToken(identityId: string): void {
  const all = loadGmailTokens();
  if (!(identityId in all)) return;
  delete all[identityId];
  writeFileSync(GMAIL_TOKENS_PATH, JSON.stringify(all, null, 2));
}

export function llmApiKey(provider: OneShotConfig["llmProvider"]): string | null {
  switch (provider) {
    case "openrouter":
      return process.env.OPENROUTER_API_KEY ?? null;
    case "openai":
      return process.env.OPENAI_API_KEY ?? null;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ?? null;
  }
}

export function oneshotEnvReady(): boolean {
  return Boolean(
    (process.env.CDP_API_KEY_ID &&
      process.env.CDP_API_KEY_SECRET &&
      process.env.CDP_WALLET_SECRET) ||
    process.env.AGENT_PRIVATE_KEY,
  );
}
