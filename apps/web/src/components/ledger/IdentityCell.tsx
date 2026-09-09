import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { usePrivacy } from "../../lib/privacy.tsx";
import { Pii } from "../primitives/Pii.tsx";

/**
 * The ledger row's identity cell, shared by /queue, /prospects and /cadences
 * (issue #600). A row is a ledger entry: one line of identity, one line that
 * answers the page's question — the signal on /queue, the decision on
 * /prospects, the sequence state on /cadences. Nothing else at rest.
 *
 * `w-full max-w-0` takes the width the fixed columns leave and lets both lines
 * truncate at it instead of stretching the table. Every sibling cell must be
 * `whitespace-nowrap` or the table re-flows around it.
 */
export interface Identity {
  name: string | null;
  email: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  phone?: string | null;
}

export function IdentityCell({
  identity,
  line2,
  line2Privacy = "hide",
  className,
}: {
  identity: Identity;
  /** The page's line — a `SignalLabel`, usually. */
  line2: ReactNode;
  /**
   * Whether line 2 is freeform text that can name a person or a company
   * (the queue's signal is: an event title, a repo, a cohort). `"hide"`
   * replaces it under privacy mode; `"show"` keeps it (a sequence state names
   * nobody). The structured identity above it is masked by `<Pii>` either way.
   */
  line2Privacy?: "hide" | "show";
  className?: string;
}) {
  const { masked } = usePrivacy();
  const { name, email, title, company, linkedinUrl, phone } = identity;
  return (
    <td className={cn("w-full max-w-0 py-[10px] pr-6", className)}>
      <div className="flex items-baseline gap-2 overflow-hidden whitespace-nowrap leading-5">
        <span className="shrink-0 text-ink-cream">
          {name ? <Pii kind="name">{name}</Pii> : "(unknown)"}
        </span>
        <span className="truncate font-mono text-[11px] text-ink-faint">
          {email ? <Pii kind="email">{email}</Pii> : "—"}
          {/*
            The title is a LinkedIn headline and some are paragraphs, so it
            alone is clamped; email, company and the [in] link are what tell
            two rows apart and have to survive it.
          */}
          {title ? (
            <>
              {" · "}
              <span className="inline-block max-w-[38ch] truncate align-bottom text-ink-cream-2">
                {title}
              </span>
            </>
          ) : null}
          {company ? (
            <>
              {" · "}
              <Pii kind="company">{company}</Pii>
            </>
          ) : null}
          {linkedinUrl ? (
            <a
              href={linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 text-ink-cream-2 underline decoration-ink-rule underline-offset-2 hover:text-ink-cream hover:decoration-ink-cream-2"
              onClick={(e) => e.stopPropagation()}
            >
              [in]
            </a>
          ) : null}
          {phone ? (
            <span className="ml-1">
              · <Pii kind="phone">{phone}</Pii>
            </span>
          ) : null}
        </span>
      </div>
      <div className="truncate text-[12px] leading-4 text-ink-cream-2">
        {masked && line2Privacy === "hide" ? (
          <span className="text-ink-faint">hidden in privacy mode</span>
        ) : (
          line2
        )}
      </div>
    </td>
  );
}

export type SignalTone = "muted" | "spend" | "blocked" | "receipt";

// Literal class strings per tone — Tailwind cannot see a concatenated name.
const SIGNAL_TONE: Record<SignalTone, string> = {
  muted: "text-ink-muted",
  spend: "text-ink-spend-2",
  blocked: "text-ink-blocked-2",
  receipt: "text-[color:var(--ink-receipt-2)]",
};

/** The small mono label that is a ledger row's second line — plain case, never shouting. */
export function SignalLabel({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: SignalTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block max-w-full truncate align-bottom font-mono text-[11px]",
        SIGNAL_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
