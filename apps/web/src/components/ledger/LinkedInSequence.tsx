import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  CadenceLinkedInTouch,
  CadenceSequenceView,
  CadenceUpcomingStep,
} from "@oneshot-gtm/shared-types";
import { RotateCw } from "lucide-react";
import { timeAgo } from "../../lib/cn.ts";
import { Button } from "../primitives/Button.tsx";
import { LetterCard, LetterEmpty } from "./LetterCard.tsx";

/**
 * A LinkedIn cadence's letter: what the person received on LinkedIn, and
 * what follows if they don't reply. Each part loads the cadence's sequence on
 * mount (same key, one fetch); the page hands in the loader and the buttons.
 */

const DAY_MS = 24 * 3600 * 1000;

/** "Connection request" from "connection request". */
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** When an upcoming step goes, counted from the touch before it. */
export function upcomingWhen(step: CadenceUpcomingStep): string {
  if (step.awaitsAcceptance) return "once they accept";
  if (step.dayOffset <= 0) return "the same day";
  return `${step.dayOffset} day${step.dayOffset === 1 ? "" : "s"} later`;
}

/** Days from one YYYY-MM-DD to now, never negative. */
function daysSince(day: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(`${day}T00:00:00Z`)) / DAY_MS));
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
      {children}
    </div>
  );
}

/** The steps left if no reply, in order, each with the text it sends when that is known. */
export function UpcomingSteps({ steps }: { steps: CadenceUpcomingStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-4 border-t border-ink-rule pt-3">
      <Heading>If no reply</Heading>
      <ol className="flex flex-col gap-3">
        {steps.map((s) => (
          <li key={s.stepIndex} className="border-l border-ink-rule pl-3">
            <div className="font-mono text-[11px] text-ink-faint">
              step {s.stepIndex} · {s.label}
              {s.channel !== "linkedin" ? ` · ${s.channel.replace("_", " ")}` : ""} ·{" "}
              {upcomingWhen(s)}
            </div>
            {s.text ? (
              <p className="m-0 mt-1 whitespace-pre-wrap text-[12px] leading-5 text-ink-cream-2">
                {s.text}
              </p>
            ) : (
              <p className="m-0 mt-1 text-[12px] text-ink-muted">written when it's due</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Earlier LinkedIn touches, oldest first. */
function SentTouches({ touches, heading }: { touches: CadenceLinkedInTouch[]; heading: string }) {
  if (touches.length === 0) return null;
  return (
    <div className="mt-4 border-t border-ink-rule pt-3">
      <Heading>{heading}</Heading>
      <ol className="flex flex-col gap-3">
        {touches.map((t) => (
          <li key={`${t.stepIndex}-${t.sentAt}`} className="border-l border-ink-rule pl-3">
            <div className="font-mono text-[11px] text-ink-faint">
              step {t.stepIndex} · {t.label} · sent {timeAgo(t.sentAt)}
            </div>
            <p className="m-0 mt-1 whitespace-pre-wrap text-[12px] leading-5 text-ink-cream-2">
              {t.text}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function useSequence(queryKey: readonly unknown[], load: () => Promise<CadenceSequenceView>) {
  return useQuery({ queryKey, queryFn: load });
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="ghost" size="sm" title="load it again" onClick={onRetry}>
      <RotateCw size={11} /> Retry
    </Button>
  );
}

/**
 * The letter while an invite waits on acceptance: the message that went, how
 * long it has waited and when it is withdrawn, then the messages still to
 * come. Nothing can be drafted until they accept, so the foot holds only
 * `actions` (Stop).
 */
export function WaitingLetter({
  view,
  waitingSince,
  actions,
  onRetry,
  now = Date.now(),
}: {
  /** Undefined while loading; null when it could not be read. */
  view: CadenceSequenceView | null | undefined;
  /** The row's `linkedinWaitingSince`, for the line shown before the view loads. */
  waitingSince: string;
  actions?: ReactNode;
  /** Shown when the view could not be read: loads it again. */
  onRetry?: () => void;
  now?: number;
}) {
  const last = view?.linkedInSent.at(-1);
  if (!view || !last) {
    return (
      <LetterEmpty
        note={
          view === undefined
            ? "Loading what was sent…"
            : view === null
              ? `Waiting for acceptance · invite sent ${waitingSince}. Couldn't load what was sent.`
              : `Waiting for acceptance · invite sent ${waitingSince}.`
        }
        // No note was captured for the invite: what follows is still known.
        below={view ? <UpcomingSteps steps={view.upcoming} /> : undefined}
        actions={
          <>
            {view === null && onRetry ? <RetryButton onRetry={onRetry} /> : null}
            {actions}
          </>
        }
      />
    );
  }
  const sentOn = view.invite?.sentOn ?? waitingSince;
  const waited = daysSince(sentOn, now);
  return (
    <LetterCard
      meta={<span title={last.sentAt}>Sent {sentOn}</span>}
      subject={sentence(last.label)}
      stateLine={
        <span className="text-ink-muted">
          waiting for acceptance · {waited} day{waited === 1 ? "" : "s"}
          {view.invite ? ` · withdrawn ${view.invite.expiresOn} if not accepted` : ""}
        </span>
      }
      body={last.text}
      afterBody={
        <>
          <SentTouches touches={view.linkedInSent.slice(0, -1)} heading="Earlier on LinkedIn" />
          <UpcomingSteps steps={view.upcoming} />
        </>
      }
      foot={actions ? { right: actions } : null}
    />
  );
}

/** `WaitingLetter` with its sequence loaded. */
export function WaitingLetterLoader({
  queryKey,
  load,
  waitingSince,
  actions,
}: {
  queryKey: readonly unknown[];
  load: () => Promise<CadenceSequenceView>;
  waitingSince: string;
  actions?: ReactNode;
}) {
  const query = useSequence(queryKey, load);
  return (
    <WaitingLetter
      view={query.isError ? null : query.data}
      waitingSince={waitingSince}
      actions={actions}
      onRetry={() => void query.refetch()}
    />
  );
}

/**
 * Under a drafted LinkedIn message: what the person already received there,
 * and the steps after the drafted one (`nextStep`).
 */
export function LinkedInThread({
  view,
  nextStep,
  onRetry,
}: {
  /** Undefined while loading; null when it could not be read. */
  view: CadenceSequenceView | null | undefined;
  nextStep: number;
  onRetry?: () => void;
}) {
  if (view === null) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-rule pt-3 text-[12px] text-ink-muted">
        Couldn't load the LinkedIn thread.
        {onRetry ? <RetryButton onRetry={onRetry} /> : null}
      </div>
    );
  }
  if (!view) return null;
  return (
    <>
      <SentTouches touches={view.linkedInSent} heading="Sent on LinkedIn" />
      <UpcomingSteps steps={view.upcoming.filter((s) => s.stepIndex > nextStep)} />
    </>
  );
}

/** `LinkedInThread` with its sequence loaded. */
export function LinkedInThreadLoader({
  queryKey,
  load,
  nextStep,
}: {
  queryKey: readonly unknown[];
  load: () => Promise<CadenceSequenceView>;
  nextStep: number;
}) {
  const query = useSequence(queryKey, load);
  return (
    <LinkedInThread
      view={query.isError ? null : query.data}
      nextStep={nextStep}
      onRetry={() => void query.refetch()}
    />
  );
}
