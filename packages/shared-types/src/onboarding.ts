export type OnboardingStep = 1 | 2 | 3;
export interface OnboardingStatus {
  ready: boolean;
  missing: string[];
  nextStep: OnboardingStep;
  aiVerified: boolean;
  verifiedAt: string | null;
  deferred: boolean;
  autoOpen: boolean;
  demo: boolean;
  context: {
    founderName: string;
    productDomain: string;
    productOneLiner: string;
    icpOneLiner: string;
  };
  provider: LlmProvider;
  model: string;
  credentials: Record<LlmProvider, boolean>;
}
import type { LlmProvider } from "./index.ts";

/** No fetching: accept a domain or HTTP(S) URL and store only its hostname. */
export function normalizeWebsite(value: string): string | null {
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !host.includes(".") ||
      !host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))
    )
      return null;
    return host;
  } catch {
    return null;
  }
}
