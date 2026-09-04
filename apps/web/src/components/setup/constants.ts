import type { SetupRequest } from "@oneshot-gtm/shared-types";

export type SecretKey = keyof NonNullable<SetupRequest["secrets"]>;
export type KeySource = "env" | "file" | null | undefined;

export const LLM_DEFAULTS: Record<string, string> = {
  openrouter: "anthropic/claude-sonnet-4.6",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
};

export const LLM_KEY: Record<"openrouter" | "openai" | "anthropic", SecretKey> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export const SECRET_LABELS: Record<SecretKey, string> = {
  OPENROUTER_API_KEY: "OpenRouter API key",
  OPENAI_API_KEY: "OpenAI API key",
  ANTHROPIC_API_KEY: "Anthropic API key",
  CDP_API_KEY_ID: "CDP_API_KEY_ID",
  CDP_API_KEY_SECRET: "CDP_API_KEY_SECRET",
  CDP_WALLET_SECRET: "CDP_WALLET_SECRET",
  AGENT_PRIVATE_KEY: "AGENT_PRIVATE_KEY",
  GMAIL_CLIENT_ID: "GMAIL_CLIENT_ID",
  GMAIL_CLIENT_SECRET: "GMAIL_CLIENT_SECRET",
  GMAIL_REFRESH_TOKEN: "GMAIL_REFRESH_TOKEN",
  SMARTLEAD_API_KEY: "Smartlead API key",
  X_API_KEY: "X_API_KEY",
  X_API_SECRET: "X_API_SECRET",
  X_ACCESS_TOKEN: "X_ACCESS_TOKEN",
  X_ACCESS_SECRET: "X_ACCESS_SECRET",
  TWITTERAPI_IO_KEY: "twitterapi.io API key",
  GITHUB_TOKEN: "GitHub token",
  LUMA_SESSION_COOKIE: "Luma session cookie",
  LINKEDIN_REPLY_WEBHOOK_SECRET: "LinkedIn reply webhook secret",
};

export const X_OAUTH_KEYS = [
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_SECRET",
] as const;

export function hintFor(source: KeySource): string {
  if (source === "env") return "Currently from shell env. Leave blank to keep.";
  if (source === "file") return "Currently from this workspace's .env. Leave blank to keep.";
  return "Not set yet.";
}

/** Human status of one secret for the preference sections' key line. */
export function keyStatus(source: KeySource): string {
  if (source === "env") return "from shell env";
  if (source === "file") return "from .env";
  return "not set";
}

/**
 * The page's sections in render order. `id` doubles as the anchor
 * (`/setup#credentials`) and the key in the page-level dirty registry.
 */
export const SECTIONS = [
  { id: "profile", eyebrow: "01 · Founder profile", label: "Founder profile" },
  { id: "icp", eyebrow: "02 · Ideal customer profile", label: "ICP" },
  { id: "proof", eyebrow: "03 · Social proof", label: "Social proof" },
  { id: "brief", eyebrow: "04 · Product brief", label: "Product brief" },
  { id: "llm", eyebrow: "05 · LLM provider", label: "LLM provider" },
  { id: "wallet", eyebrow: "06 · Wallet & spend", label: "Wallet & spend" },
  { id: "x", eyebrow: "07 · X / Twitter", label: "X / Twitter" },
  { id: "email", eyebrow: "08 · Email transport", label: "Email transport" },
  { id: "review", eyebrow: "09 · Review queue & time zone", label: "Queue & time zone" },
  { id: "telemetry", eyebrow: "10 · Telemetry", label: "Telemetry" },
  { id: "credentials", eyebrow: "11 · Credentials", label: "Credentials" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export function sectionMeta(id: SectionId): (typeof SECTIONS)[number] {
  return SECTIONS.find((s) => s.id === id)!;
}
