import type { getLedger } from "@oneshot-gtm/core";
import type {
  AutoReplyReasonView,
  CadenceAutoReason,
  InboxReplyView,
} from "@oneshot-gtm/shared-types";

type Ledger = ReturnType<typeof getLedger>;

const REASONS = new Set<AutoReplyReasonView>(["left_company", "out_of_office", "other"]);

/**
 * The stored reading of automatic replies for the /inbox badges, by reply id.
 * Best-effort: a ledger that cannot answer leaves the badges as they were.
 */
export function autoReplyViews(
  ledger: Ledger,
  ids: readonly string[],
): Map<string, Pick<InboxReplyView, "autoReason" | "returnDate" | "successor">> {
  const out = new Map<string, Pick<InboxReplyView, "autoReason" | "returnDate" | "successor">>();
  let stored: ReturnType<Ledger["listInboxReplyAutoClassifications"]>;
  try {
    stored = ledger.listInboxReplyAutoClassifications(ids);
  } catch {
    return out;
  }
  for (const [id, s] of stored) {
    if (!REASONS.has(s.reason as AutoReplyReasonView)) continue;
    out.set(id, {
      autoReason: s.reason as AutoReplyReasonView,
      returnDate: s.returnDate,
      successor: s.successor,
    });
  }
  return out;
}

/** One reply's reading; empty when it has none. */
export function autoReplyViewOf(
  ledger: Ledger,
  id: string,
): Pick<InboxReplyView, "autoReason" | "returnDate" | "successor"> {
  return autoReplyViews(ledger, [id]).get(id) ?? {};
}

/** A cadence's `hold_reason` column as the /cadences badge reads it. */
export function cadenceAutoReasonOf(
  holdReason: string | null | undefined,
): CadenceAutoReason | null {
  switch (holdReason) {
    case "out-of-office":
      return "out_of_office";
    case "left-company":
      return "left_company";
    case "blocked":
      return "blocked";
    default:
      return null;
  }
}
