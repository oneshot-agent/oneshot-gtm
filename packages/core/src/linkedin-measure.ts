import type { LinkedInStepKind } from "@oneshot-gtm/shared-types";
import { currentWorkspaceName } from "./shared-db.ts";
import { getLedger } from "./ledger.ts";
import { computeLinkedInFunnel, type LinkedInFunnelResult } from "./linkedin-funnel.ts";
import { linkedInConversationIndex } from "./linkedin-inbox.ts";

/**
 * The LinkedIn funnel and invite listing for the current workspace (#792).
 * Read-only over the workspace ledger and the shared inbox store; no API call.
 */
export function readLinkedInMeasure(
  filters: {
    sinceDays?: number | null;
    play?: string | null;
    stepKind?: LinkedInStepKind | null;
  } = {},
  now: Date = new Date(),
): LinkedInFunnelResult {
  const workspace = currentWorkspaceName();
  return computeLinkedInFunnel({
    source: getLedger().readLinkedInFunnelSource(),
    workspace,
    now,
    filters,
    conversationFor: linkedInConversationIndex(workspace),
  });
}
