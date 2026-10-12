import { getLedger } from "./ledger.ts";
import {
  canInviteOnLinkedIn,
  type LinkedInGuardVerdict,
  type LinkedInInviteProspect,
} from "./linkedin-guard.ts";
import { linkedInHasConversationWith } from "./linkedin-inbox.ts";

/**
 * The guard against the process-wide ledger, shared DB and synced inbox. Kept
 * out of linkedin-guard.ts, which the ledger imports: this file is the only
 * one that needs both the ledger and the inbox store.
 */
export function canInviteOnLinkedInNow(prospect: LinkedInInviteProspect): LinkedInGuardVerdict {
  return canInviteOnLinkedIn(prospect, {
    ledger: getLedger(),
    inbox: { hasConversationWith: (url) => linkedInHasConversationWith(url) },
  });
}
