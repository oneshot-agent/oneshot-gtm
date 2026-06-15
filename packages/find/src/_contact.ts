import { logEvent } from "@oneshot-gtm/core";
import type { CallContext, FindEmailInput } from "@oneshot-gtm/core";
import { isCircuitOpen, recordResolutionOutcome } from "./_breaker.ts";
import { shouldSkipFindEmail } from "./_findemail-prescreen.ts";
import { safeFindEmail, safeVerifyEmail } from "./_sdk-safe.ts";

/**
 * Outcome of the shared contact-resolution spine. On `ok`, the caller has a
 * verified, non-duplicate email; otherwise `reason` says which gate dropped the
 * candidate. `costUsd` is the find + verify spend accrued so far — returned on
 * EVERY path so callers never lose cost tracking on a drop.
 */
export type ContactResolution =
  | { ok: true; email: string; fullName: string | null; costUsd: number }
  | {
      ok: false;
      reason:
        | "no-domain"
        | "prescreen"
        | "not-found"
        | "duplicate"
        | "undeliverable"
        // The backend threw/timed out — NOT a verdict about the candidate.
        // Callers should defer/persist-for-retry rather than treat as bad.
        | "platform-error";
      costUsd: number;
    };

/**
 * The prescreen → findEmail → dedupe → verify spine shared by every enqueueing
 * finder. Extracted so the per-candidate isolation (safeFindEmail/safeVerifyEmail
 * never throw) and the dedupe-before-verify ordering live in one place instead
 * of being re-implemented (and drifting) in each finder.
 *
 * Boundary: this owns email resolution + verification only. Downstream steps
 * (enrichVerifiedContact, findLinkedInUrl, webRead, enqueue) stay in the caller
 * because they vary too much between finders.
 *
 * - `knownEmail`: when the caller already has a usable email (a public profile
 *   email, or one surfaced by LinkedIn enrichment), pass it to skip the
 *   prescreen + findEmail entirely.
 * - `companyDomain`: required when `knownEmail` is absent (the findEmail input).
 * - `isDuplicate`: called with the resolved email BEFORE verify, so a
 *   cross-table duplicate is dropped without paying for a verify call. Dedupe
 *   stays caller-owned (each finder has its own `dedupeKey`).
 * - `decisionContext`: threaded to both findEmail and verify as audit metadata.
 */
export async function resolveAndVerifyContact(args: {
  playName: string;
  fullName: string | null;
  knownEmail?: string | null;
  companyDomain?: string | null;
  isDuplicate?: (email: string) => boolean;
  decisionContext?: CallContext["decisionContext"];
}): Promise<ContactResolution> {
  const ctx: CallContext = { playName: args.playName };
  if (args.decisionContext) ctx.decisionContext = args.decisionContext;

  let costUsd = 0;
  let email: string;
  let fullName = args.fullName;

  if (args.knownEmail) {
    email = args.knownEmail;
  } else {
    if (!args.companyDomain) return { ok: false, reason: "no-domain", costUsd };
    const skip = shouldSkipFindEmail({
      fullName: args.fullName,
      companyDomain: args.companyDomain,
    });
    if (!skip.ok) {
      logEvent("finder.skipped_findemail", { name: args.playName, reason: skip.reason }, "info");
      return { ok: false, reason: "prescreen", costUsd };
    }
    // Circuit open (backend outage): skip the paid call entirely — fast-fail as
    // a platform error so the caller defers instead of burning spend + ~70s.
    if (isCircuitOpen()) return { ok: false, reason: "platform-error", costUsd };
    const findInput: FindEmailInput = { companyDomain: args.companyDomain };
    if (args.fullName) findInput.fullName = args.fullName;
    const found = await safeFindEmail(findInput, ctx);
    costUsd += found.result.cost ?? 0;
    // status:"error" = the safe wrapper caught a throw (platform/transport
    // failure), NOT a genuine "no email for this person". Don't treat as a
    // verdict; feed the breaker and defer.
    if (found.result.status === "error") {
      recordResolutionOutcome(true);
      return { ok: false, reason: "platform-error", costUsd };
    }
    recordResolutionOutcome(false); // backend answered (found or genuinely not)
    if (!found.result.found || !found.result.email) {
      return { ok: false, reason: "not-found", costUsd };
    }
    email = found.result.email;
    fullName = found.result.full_name ?? args.fullName;
  }

  if (args.isDuplicate?.(email)) return { ok: false, reason: "duplicate", costUsd };

  if (isCircuitOpen()) return { ok: false, reason: "platform-error", costUsd };
  const verified = await safeVerifyEmail({ email }, ctx);
  costUsd += verified.result.cost ?? 0;
  if (verified.result.status === "error") {
    recordResolutionOutcome(true);
    return { ok: false, reason: "platform-error", costUsd };
  }
  recordResolutionOutcome(false);
  if (!verified.result.deliverable) return { ok: false, reason: "undeliverable", costUsd };

  return { ok: true, email, fullName, costUsd };
}
