import type { ReactNode } from "react";
import { useMask } from "../../lib/privacy.tsx";
import { Skeleton } from "../primitives/Skeleton.tsx";
import { PaneHeading } from "./PaneHeading.tsx";
import { PersonBio } from "./PersonBio.tsx";
import { PersonCadences } from "./PersonCadences.tsx";
import { PersonHeader } from "./PersonHeader.tsx";
import { TouchTimeline } from "./TouchTimeline.tsx";
import { usePerson, type PersonKey } from "./usePerson.ts";

/** A part of the pane a page already shows its own way. `call` drops call touches. */
export type PersonPanePart = "header" | "touches" | "cadences" | "call";

function LoadError({ error }: { error: Error }) {
  return (
    <div className="font-mono text-[12px] text-[color:var(--ink-blocked-2)]">
      couldn't load this person · {error.message}
    </div>
  );
}

/** Who the page already knows this is, shown while the person loads so the name never blinks. */
export interface PersonFallback {
  name: string | null;
  title: string | null;
  company: string | null;
}

function FallbackIdentity({ fallback }: { fallback: PersonFallback }) {
  const mask = useMask();
  const role = [fallback.title, fallback.company ? mask("company", fallback.company) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="min-w-0">
      <div className="text-[15px] text-ink-cream">{mask("name", fallback.name) || "—"}</div>
      {role && <div className="mt-0.5 text-[12px] text-ink-muted">{role}</div>}
    </div>
  );
}

/**
 * One person, the same on /calls, /queue, /cadences and /prospects: who
 * they are, their bio and research, every touch on every channel and their
 * cadences. Each page keeps its own action column beside it.
 */
export function PersonPane({
  prospectId,
  queueId,
  aside,
  highlightPlay,
  omit = [],
  fallback,
}: PersonKey & {
  /** Right of the name (the Calls page puts the phone and their local time there). */
  aside?: ReactNode;
  /** The page's own play, set apart from the rest in the touches. */
  highlightPlay?: string | null;
  omit?: ReadonlyArray<PersonPanePart>;
  /** The name and role the page already has, for the header while the person loads. */
  fallback?: PersonFallback;
}) {
  const query = usePerson({ prospectId, queueId });
  const person = query.data ?? null;
  const showHeader = !omit.includes("header");
  const placeholder = query.isError ? (
    <LoadError error={query.error} />
  ) : fallback ? (
    <FallbackIdentity fallback={fallback} />
  ) : (
    <Skeleton lines={2} />
  );

  if (!person) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {showHeader ? (
          <PersonHeader person={null} body={placeholder} aside={aside} />
        ) : query.isError ? (
          <LoadError error={query.error} />
        ) : (
          <Skeleton lines={4} />
        )}
      </div>
    );
  }
  const touches = omit.includes("call")
    ? person.touches.filter((t) => t.kind !== "call")
    : person.touches;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {showHeader && <PersonHeader person={person} aside={aside} />}
      <PersonBio dossier={person.dossier} queueId={queueId ?? person.queueId} />
      {!omit.includes("touches") && (
        <section aria-label="Touches">
          <PaneHeading>touches</PaneHeading>
          <TouchTimeline touches={touches} highlightPlay={highlightPlay} />
        </section>
      )}
      {!omit.includes("cadences") && <PersonCadences cadences={person.cadences} />}
    </div>
  );
}

/**
 * The touches alone, for a page that puts them apart from the bio (Calls,
 * under the outcome). Same query as the pane above it: one request.
 */
export function PersonTouches({
  prospectId,
  queueId,
  highlightPlay,
  omitCalls = false,
}: PersonKey & { highlightPlay?: string | null; omitCalls?: boolean }) {
  const query = usePerson({ prospectId, queueId });
  if (query.isError) return <LoadError error={query.error} />;
  if (!query.data) return <Skeleton lines={3} />;
  const touches = omitCalls
    ? query.data.touches.filter((t) => t.kind !== "call")
    : query.data.touches;
  return <TouchTimeline touches={touches} highlightPlay={highlightPlay} />;
}
