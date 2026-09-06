import type { OneShotConfig } from "./types.ts";
import { extractBusinessAddress } from "./mail-address.ts";

export interface MotionMailSettings {
  position: number;
  delayDays: number;
  /** Existing settings without a mode remain explicit founder opt-ins. */
  mode?: "automatic" | "always";
}
const defaults: Record<string, MotionMailSettings & { reason: string }> = {
  "new-business": {
    position: 2,
    delayDays: 3,
    reason: "A relevant opening offer for a reachable business location.",
  },
  "free-pilot": {
    position: 2,
    delayDays: 3,
    reason: "A concrete pilot proposal for a reachable business location.",
  },
  "design-partner-loi": {
    position: 2,
    delayDays: 3,
    reason: "A shareable proposal for enterprise and hardware buyers.",
  },
  "post-funding": {
    position: 3,
    delayDays: 3,
    reason: "An additional touch for an ICP-qualified decision maker with a business address.",
  },
  "hiring-signal": {
    position: 3,
    delayDays: 3,
    reason: "An additional touch for an ICP-qualified decision maker with a business address.",
  },
  "competitor-switch": {
    position: 3,
    delayDays: 3,
    reason: "An additional touch for an ICP-qualified decision maker with a business address.",
  },
};

/** Missing settings inherit the recommendation; explicit null always means off. */
export function motionMailPolicy(
  config: Pick<OneShotConfig, "directMailMotions">,
  playName: string,
) {
  const recommended = defaults[playName];
  const override = config.directMailMotions?.[playName];
  const settings =
    override === null
      ? null
      : (override ??
        (recommended
          ? {
              position: recommended.position,
              delayDays: recommended.delayDays,
              mode: "automatic" as const,
            }
          : null));
  return {
    settings,
    reason: recommended?.reason ?? "No automatic mail recommendation for this motion.",
    recommended: !!recommended,
  };
}

/** Conservative eligibility rules, not a conversion or account-value prediction. */
export function automaticMailEligible(
  playName: string,
  prospect: Record<string, unknown>,
): boolean {
  const address = extractBusinessAddress(prospect);
  if (!address?.name || !String(prospect.company ?? "").trim()) return false;
  const source = String(prospect.businessAddressSource ?? "");
  if (/registered.agent|registered.office|residential|home.address/i.test(source)) return false;
  if (prospect.icp_verdict === "reject" || prospect.icpVerdict === "reject") return false;
  if (playName === "new-business" || playName === "free-pilot") return true;
  if (playName === "design-partner-loi")
    return ["enterprise", "hardware"].includes(
      String(prospect.buyerType ?? "")
        .trim()
        .toLowerCase(),
    );
  if (["post-funding", "hiring-signal", "competitor-switch"].includes(playName))
    return (
      (prospect.icp_verdict ?? prospect.icpVerdict) === "pass" &&
      /\b(founder|owner|ceo|cto|coo|cfo|chief|president|vp|vice president|head|director)\b/i.test(
        String(prospect.title ?? ""),
      )
    );
  return false;
}

/** Printing plus transit allowance. Weekends do not consume the eight business days. */
export function mailFollowupDueAt(nextDelayDays: number, acceptedAt = new Date()): string {
  const arrival = new Date(acceptedAt);
  let days = 0;
  while (days < 8) {
    arrival.setUTCDate(arrival.getUTCDate() + 1);
    if (arrival.getUTCDay() !== 0 && arrival.getUTCDay() !== 6) days++;
  }
  // Allow two more days to read the letter; preserve longer founder-configured waits.
  return new Date(
    Math.max(arrival.getTime() + 2 * 86400000, acceptedAt.getTime() + nextDelayDays * 86400000),
  ).toISOString();
}
