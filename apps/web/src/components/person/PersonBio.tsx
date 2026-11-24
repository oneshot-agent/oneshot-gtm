import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueueDossierView, ReadProfileResult } from "@oneshot-gtm/shared-types";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { cn, timeAgo } from "../../lib/cn.ts";
import { liveReadNotice, READING_LINKEDIN, type LiveReadNotice } from "../../lib/liveRead.ts";
import { useMask, usePrivacy } from "../../lib/privacy.tsx";
import { readOnly } from "../../lib/readOnly.ts";
import { clearRowActivity, setRowActivity, useRowActivity } from "../../lib/rowActivity.ts";
import { Disclosure } from "../ledger/CaseList.tsx";
import { Button } from "../primitives/Button.tsx";
import { DossierBody } from "../queue/PersonDossier.tsx";
import { PaneHeading } from "./PaneHeading.tsx";

/** Summaries longer than this get a "more" toggle; shorter ones fit the clamp. */
const CLAMP_CHARS = 280;

/** The role the research marks current: "Head of AI at Acme since Jan 2023". */
function currentRole(dossier: QueueDossierView, mask: ReturnType<typeof useMask>): string | null {
  const role = dossier.experience.find((r) => r.current);
  if (!role) return null;
  return [
    role.title ?? "Role",
    ` at ${mask("company", role.company)}`,
    role.startDate ? ` since ${role.startDate}` : "",
  ].join("");
}

/** Research is worth asking for only when none, or only the summary, is cached. */
export function canResearch(dossier: QueueDossierView, queueId: number | null): boolean {
  return queueId != null && (dossier.status === "none" || dossier.status === "summary-only");
}

/** What a pressed Research says when the queue's own notice has nothing to add. */
function quietOutcome(result: ReadProfileResult): string {
  if (result.read) return "LinkedIn read";
  if (result.skipped === "fresh") return "Already read recently";
  if (result.skipped === "no-seed" || result.skipped === "not-linkedin")
    return "No LinkedIn profile to read";
  return "Nothing read";
}

/**
 * Reads the row's LinkedIn profile now (the same call a queue row makes on
 * open, with its own daily cap), then says what came of it in one line.
 */
function ResearchButton({ queueId }: { queueId: number }) {
  const qc = useQueryClient();
  const { masked } = usePrivacy();
  const activity = useRowActivity(queueId);
  const [notice, setNotice] = useState<LiveReadNotice | null>(null);
  const settle = (): void => {
    for (const key of ["person", "queue-dossier", "queue", "prospects"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
  const read = useMutation({
    mutationFn: async (id: number) => {
      const token = setRowActivity(id, READING_LINKEDIN);
      try {
        return await api.readQueueProfile(id);
      } finally {
        clearRowActivity(id, token);
      }
    },
    onSuccess: (result) => {
      setNotice(liveReadNotice(result) ?? { tone: "muted", text: quietOutcome(result) });
      settle();
    },
    onError: (err) => {
      setNotice({ tone: "muted", text: `LinkedIn not read: ${err.message}` });
      settle();
    },
  });
  const busy = read.isPending || activity === READING_LINKEDIN;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() => read.mutate(queueId)}
        title="Read their LinkedIn profile now (counts toward the daily read cap)"
        {...readOnly}
      >
        {busy && <Loader2 size={11} className="animate-spin" />}
        {busy ? READING_LINKEDIN : "Research"}
      </Button>
      {notice && (
        <p
          role="status"
          className={cn(
            "m-0 text-[12px] leading-5",
            notice.tone === "blocked" ? "text-[color:var(--ink-blocked-2)]" : "text-ink-muted",
          )}
        >
          {/* A reject reason can name the person or the company. */}
          {masked && notice.tone === "blocked" ? "Rejected after the LinkedIn read." : notice.text}
        </p>
      )}
    </div>
  );
}

/**
 * The bio in view: their summary, current role and newest posts, then the
 * whole dossier behind a disclosure. Freeform research names the person, so
 * privacy mode keeps only the role line.
 */
export function PersonBio({
  dossier,
  queueId,
}: {
  dossier: QueueDossierView;
  /** The queue row Research reads for; no button without one. */
  queueId: number | null;
}) {
  const { masked } = usePrivacy();
  const mask = useMask();
  const [more, setMore] = useState(false);
  const summary = dossier.person.summary?.trim() || null;
  const role = currentRole(dossier, mask);
  const posts = dossier.posts.filter((p) => !p.isRepost && p.content?.trim()).slice(0, 2);
  const empty = !summary && !role && posts.length === 0;
  return (
    <section aria-label="Bio">
      <PaneHeading>bio</PaneHeading>
      <div className="text-[12px] leading-5 text-ink-cream-2">
        {role && <p className="m-0">{role}</p>}
        {masked ? (
          <p className="m-0 mt-1 text-ink-muted">Bio hidden in privacy mode.</p>
        ) : (
          <>
            {summary && (
              <>
                <p
                  className={cn(
                    "m-0 mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]",
                    !more && "line-clamp-4",
                  )}
                >
                  {summary}
                </p>
                {summary.length > CLAMP_CHARS && (
                  <button
                    type="button"
                    className="mt-0.5 cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink-cream-2"
                    aria-expanded={more}
                    onClick={() => setMore((v) => !v)}
                  >
                    {more ? "less" : "more"}
                  </button>
                )}
              </>
            )}
            {posts.length > 0 && (
              <ul className="m-0 mt-2 list-none p-0">
                {posts.map((post) => (
                  <li
                    key={post.url ?? `${post.postedAt ?? ""}:${post.content?.slice(0, 40) ?? ""}`}
                    className="flex min-w-0 items-baseline gap-2"
                  >
                    <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                      {post.postedAt ? timeAgo(post.postedAt) : "post"}
                    </span>
                    <span className="min-w-0 truncate text-ink-muted">{post.content}</span>
                  </li>
                ))}
              </ul>
            )}
            {empty && (
              <p className="m-0 text-ink-muted">
                {dossier.status === "none" ? "No research saved yet." : "Nothing in the summary."}
              </p>
            )}
          </>
        )}
      </div>
      {canResearch(dossier, queueId) && <ResearchButton queueId={queueId as number} />}
      <div className="mt-2">
        {masked ? (
          <p className="m-0 text-[12px] text-ink-muted">Dossier hidden in privacy mode.</p>
        ) : (
          <Disclosure label="Full dossier">
            <DossierBody dossier={dossier} />
          </Disclosure>
        )}
      </div>
    </section>
  );
}
