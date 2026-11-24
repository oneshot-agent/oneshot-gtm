import type { PersonView } from "@oneshot-gtm/shared-types";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { linkedinUrlFor } from "../../lib/payloadIdentity.ts";
import { useMask } from "../../lib/privacy.tsx";
import { Badge } from "../primitives/Badge.tsx";

/** The stops on this person, worded as the /prospects drawer words them. */
export function PersonFlags({ flags }: { flags: PersonView["flags"] }) {
  return (
    <>
      {flags.icpReject && <Badge tone="blocked">off-icp</Badge>}
      {flags.bounced && <Badge tone="blocked">hard bounce</Badge>}
      {flags.contactSuppressed && (
        <Badge tone="blocked">
          {flags.contactSuppressed === "unsubscribe" ? "unsubscribed" : "mailbox gone"}
        </Badge>
      )}
      {flags.breakupHold && <Badge tone="blocked">do not contact</Badge>}
      {flags.replied && <Badge tone="receipt">replied</Badge>}
    </>
  );
}

/**
 * Who the person is: name, role, where, their LinkedIn and what stops a
 * send. `aside` sits on the right (the Calls page puts the phone there) and
 * shows while the person loads, so a control placed in it never disappears.
 */
export function PersonHeader({
  person,
  body,
  aside,
}: {
  person: PersonView | null;
  /** Shown in place of the identity while there is no person (a skeleton or an error line). */
  body?: ReactNode;
  aside?: ReactNode;
}) {
  const mask = useMask();
  const p = person?.prospect ?? null;
  const dossier = person?.dossier.person ?? null;
  const name = p?.name ?? dossier?.fullName ?? null;
  const title = p?.title ?? dossier?.title ?? null;
  const company = p?.company ?? dossier?.company ?? null;
  // Both columns are written unvalidated: only a LinkedIn profile URL becomes an href.
  const linkedin =
    linkedinUrlFor({ linkedinUrl: p?.linkedinUrl }) ??
    linkedinUrlFor({ linkedinUrl: dossier?.linkedinUrl });
  const role = [title, company ? mask("company", company) : null].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {person ? (
          <>
            <div className="text-[15px] text-ink-cream">{mask("name", name) || "—"}</div>
            {role && <div className="mt-0.5 text-[12px] text-ink-muted">{role}</div>}
            {(dossier?.location || linkedin) && (
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                {dossier?.location && <span>{dossier.location}</span>}
                {linkedin && (
                  <a
                    href={linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-ink-cream-2 underline underline-offset-2"
                  >
                    <ExternalLink size={12} aria-hidden="true" />
                    LinkedIn
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 empty:hidden">
              <PersonFlags flags={person.flags} />
            </div>
          </>
        ) : (
          body
        )}
      </div>
      {aside && <div className="flex shrink-0 flex-col items-end gap-1">{aside}</div>}
    </div>
  );
}
