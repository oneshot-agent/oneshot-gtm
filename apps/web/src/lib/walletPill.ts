import type { DoctorCheck } from "@oneshot-gtm/shared-types";

export type PillTone = "receipt" | "spend" | "blocked" | "neutral";

export interface WalletPill {
  value: string;
  tone: PillTone;
  title: string;
  /** True when the value is a balance the founder can act on (refresh makes sense). */
  hasBalance: boolean;
}

function toneOf(severity: DoctorCheck["severity"]): PillTone {
  if (severity === "ok") return "receipt";
  if (severity === "warn") return "spend";
  return "blocked";
}

/** "$0.00" / "$26.89"; whole dollars past $100 so the pill stays short. */
export function formatUsd(amount: number): string {
  return amount >= 100 ? `$${Math.round(amount)}` : `$${amount.toFixed(2)}`;
}

/**
 * What the masthead's wallet pill shows. The balance check wins when the
 * doctor produced one (it is what the founder actually needs to see — an
 * empty wallet refuses every paid call while the env check still says ok);
 * otherwise the env check, as before; otherwise a neutral dash.
 */
export function walletPill(checks: DoctorCheck[], loading = false): WalletPill {
  if (loading) return { value: "…", tone: "neutral", title: "checking", hasBalance: false };
  const balance = checks.find((c) => c.name === "wallet balance");
  if (balance && typeof balance.balanceUsd === "number") {
    return {
      value: formatUsd(balance.balanceUsd),
      tone: toneOf(balance.severity),
      title: [balance.message, balance.hint, "refreshes daily"].filter(Boolean).join(" · "),
      hasBalance: true,
    };
  }
  if (balance) {
    return {
      value: balance.severity === "ok" ? "ok" : balance.severity,
      tone: toneOf(balance.severity),
      title: balance.message,
      hasBalance: true,
    };
  }
  const env = checks.find((c) => c.name.includes("wallet"));
  if (!env) return { value: "—", tone: "neutral", title: "unknown", hasBalance: false };
  const value =
    env.severity !== "ok" ? env.severity : env.message.includes("AGENT_PRIVATE_KEY") ? "pk" : "cdp";
  return { value, tone: toneOf(env.severity), title: env.message, hasBalance: false };
}
