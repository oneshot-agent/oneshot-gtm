import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  describeDecision,
  type CadenceView,
  type DecidedByFilter,
  type ProspectBrowseRow,
  type ProspectSortKey,
  type QueueRowDetail,
  type QueueStatusView,
} from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { Field, Input, Select, Textarea } from "../components/primitives/Field.tsx";
import { Pii } from "../components/primitives/Pii.tsx";
import { Skeleton, SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { cn, formatCount, timeAgo } from "../lib/cn.ts";
import { maskDeep } from "../lib/mask.ts";
import {
  companyFor,
  emailFor,
  linkedinUrlFor,
  nameFor,
  sourceDetail,
  titleFor,
} from "../lib/payloadIdentity.ts";
import { usePrivacy } from "../lib/privacy.tsx";
import {
  pageSummary,
  parseProspectsSearch,
  pastEnd,
  type ProspectsSearch,
} from "../lib/prospects-helpers.ts";
import { rationaleLine } from "../lib/queueRationale.ts";
import { readOnly } from "../lib/readOnly.ts";

export const Route = createFileRoute("/prospects")({
  staticData: { title: "Prospects" },
  // Filters live in the URL so a search is a link; defaults are dropped so
  // /prospects stays clean and the demo's fixture path stays stable.
  validateSearch: parseProspectsSearch,
  component: ProspectsPage,
});

const STATUSES: Array<QueueStatusView | "all"> = [
  "all",
  "pending",
  "approved",
  "rejected",
  "sent",
  "expired",
];

const DECIDED: Array<{ key: DecidedByFilter | "any"; label: string }> = [
  { key: "any", label: "anyone" },
  { key: "human", label: "you" },
  { key: "machine", label: "machine" },
  { key: "none", label: "undecided" },
];

/** Every sort × direction the URL accepts, so a shared link always shows its own order. */
const SORTS: Array<{ key: ProspectSortKey; dir: "asc" | "desc"; label: string }> = [
  { key: "found", dir: "desc", label: "newest" },
  { key: "found", dir: "asc", label: "oldest" },
  { key: "decided", dir: "desc", label: "last decided" },
  { key: "decided", dir: "asc", label: "first decided" },
  { key: "name", dir: "asc", label: "name a–z" },
  { key: "name", dir: "desc", label: "name z–a" },
];

/** Same tone map as /queue, so a status reads the same colour on both pages. */
function statusTone(
  status: QueueStatusView,
): "receipt" | "spend" | "blocked" | "signal" | "neutral" {
  switch (status) {
    case "pending":
      return "spend";
    case "approved":
      return "receipt";
    case "rejected":
      return "blocked";
    case "sent":
      return "signal";
    case "expired":
      return "neutral";
  }
}

function ProspectsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // One row open at a time, expanded in place — the same shape as /queue.
  const [expanded, setExpanded] = useState<number | null>(null);

  const update = (patch: Partial<ProspectsSearch>, opts: { replace?: boolean } = {}): void => {
    // Every filter change restarts at page one — page N of a different
    // search is not a place.
    setExpanded(null);
    void navigate({
      search: (prev) => ({ ...prev, ...patch, page: undefined }),
      ...(opts.replace ? { replace: true } : {}),
    });
  };

  // The search box is local state, pushed to the URL 250 ms after typing
  // stops (replacing the entry, so Back does not walk through keystrokes);
  // a browser back/forward that changes `q` pulls it back down — but only
  // when the box does not already say that, or the URL's trimmed value
  // would eat a trailing space or a character typed while the push landed.
  const [qDraft, setQDraft] = useState(search.q ?? "");
  useEffect(() => {
    setQDraft((prev) => (prev.trim() === (search.q ?? "") ? prev : (search.q ?? "")));
  }, [search.q]);
  useEffect(() => {
    const trimmed = qDraft.trim();
    if (trimmed === (search.q ?? "")) return;
    const id = setTimeout(() => update({ q: trimmed || undefined }, { replace: true }), 250);
    return () => clearTimeout(id);
    // `update` is stable per render but not memoised; the URL value is the
    // only dependency that should re-arm the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft, search.q]);

  const results = useQuery({
    queryKey: ["prospects", search],
    queryFn: () => api.prospectSearch(search),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const data = results.data;
  const rows = data?.rows ?? [];
  const counts = data?.counts;
  const allCount = counts
    ? counts.pending + counts.approved + counts.rejected + counts.sent + counts.expired
    : null;
  const summary = data ? pageSummary(data.total, data.offset, data.limit) : null;
  const isPastEnd = data ? pastEnd(data.total, data.offset) : false;
  const sortKey = `${search.sort ?? "found"}:${search.dir ?? "desc"}`;
  const filterActive =
    !!search.q || !!search.status || !!search.play || !!search.decided || !!search.sort;

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Prospects</div>
          <h1
            className="mt-1 text-ink-cream"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 44,
              fontWeight: 600,
              letterSpacing: "-0.025em",
              lineHeight: 0.98,
            }}
          >
            Everyone the finders found.
          </h1>
        </div>
        <div className="text-right font-mono text-[11px] text-ink-faint">
          {data ? (
            <>
              <div>
                <span className="text-ink-cream-2">{formatCount(data.total)}</span>{" "}
                <span className="text-ink-muted">{filterActive ? "matching" : "rows"}</span>
              </div>
              {allCount != null && filterActive && (
                <div className="mt-0.5">
                  <span className="text-ink-cream-2">{formatCount(allCount)}</span>{" "}
                  <span className="text-ink-muted">in this view</span>
                </div>
              )}
            </>
          ) : (
            <Skeleton lines={2} widths={["96px", "64px"]} />
          )}
        </div>
      </section>

      {/* One filter block, one rule under it: search, then status with the
          counts each chip would reveal, then who decided, sort and play. */}
      <div className="flex flex-col gap-2.5 border-b border-ink-rule/60 px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-[min(420px,100%)]">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
            />
            <Input
              type="search"
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              placeholder="name, email, company, title, play, note…"
              aria-label="search prospects"
              className="pl-8"
            />
          </div>
          <span className="mx-1 h-4 w-px bg-ink-rule" />
          <span className="ln-eyebrow">sort</span>
          <Select
            aria-label="sort"
            value={sortKey}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(":") as [ProspectSortKey, "asc" | "desc"];
              update({
                sort: key === "found" && dir === "desc" ? undefined : key,
                dir: dir === "asc" ? "asc" : undefined,
              });
            }}
            className="w-[150px]"
          >
            {SORTS.map((s) => (
              <option key={`${s.key}:${s.dir}`} value={`${s.key}:${s.dir}`}>
                {s.label}
              </option>
            ))}
          </Select>
          <span className="ln-eyebrow">play</span>
          <Select
            aria-label="play"
            value={search.play ?? ""}
            onChange={(e) => update({ play: e.target.value || undefined })}
            className="w-[190px]"
          >
            <option value="">every play</option>
            {(data?.plays ?? (search.play ? [search.play] : [])).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="ln-eyebrow">status</span>
          {STATUSES.map((s) => {
            const active = (search.status ?? "all") === s;
            const n = s === "all" ? allCount : (counts?.[s] ?? null);
            return (
              <Button
                key={s}
                variant={active ? "secondary" : "ghost"}
                size="sm"
                onClick={() => update({ status: s === "all" ? undefined : s })}
              >
                {s}
                {n != null && <span className="ml-1 font-mono opacity-60">{formatCount(n)}</span>}
              </Button>
            );
          })}
          <span className="mx-2 h-4 w-px bg-ink-rule" />
          <span className="ln-eyebrow">decided by</span>
          {DECIDED.map((d) => (
            <Button
              key={d.key}
              variant={(search.decided ?? "any") === d.key ? "secondary" : "ghost"}
              size="sm"
              onClick={() => update({ decided: d.key === "any" ? undefined : d.key })}
            >
              {d.label}
            </Button>
          ))}
        </div>
      </div>

      <section>
        {results.isLoading ? (
          <div>
            {Array.from({ length: 8 }, (_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : results.isError ? (
          <div className="px-6 py-8">
            <EmptyNote note={`Couldn't load prospects · ${results.error.message}`} />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-8">
            {isPastEnd && summary ? (
              <EmptyNote note="This page is past the end — rows were decided out from under it.">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void navigate({
                      search: (prev) => ({
                        ...prev,
                        page: summary.pages > 1 ? summary.pages : undefined,
                      }),
                    })
                  }
                >
                  go to the last page
                </Button>
              </EmptyNote>
            ) : filterActive ? (
              <EmptyNote note="Nothing matches. Loosen a filter or clear the search.">
                <Button variant="ghost" size="sm" onClick={() => void navigate({ search: {} })}>
                  clear filters
                </Button>
              </EmptyNote>
            ) : (
              <EmptyNote
                note="No candidates yet. Run a finder from /queue's Triggers panel; everything it surfaces — kept or rejected — lands here."
                cli="oneshot-gtm find watch"
              />
            )}
          </div>
        ) : (
          <table className={cn("w-full text-[13px]", results.isFetching && "opacity-70")}>
            <thead className="sticky top-0 z-10 bg-ink-bg">
              <tr className="border-b border-ink-rule text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="w-6 py-2 pl-4 pr-0" aria-label="expand" />
                <th className="py-2 text-left font-medium">prospect</th>
                <th className="py-2 text-left font-medium">play</th>
                <th className="py-2 pr-4 text-left font-medium">status</th>
                <th className="py-2 text-left font-medium">decision</th>
                <th className="py-2 text-right font-medium">found</th>
                <th className="px-6 py-2 text-right font-medium">decided</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <BrowseRow
                  key={row.id}
                  row={row}
                  zebra={i % 2 === 1}
                  expanded={expanded === row.id}
                  onToggle={() => setExpanded((prev) => (prev === row.id ? null : row.id))}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {summary && data && data.total > 0 && (
        <div className="flex items-center justify-between gap-4 border-t border-ink-rule/60 px-6 py-3 font-mono text-[11px] text-ink-faint">
          <div>
            showing <span className="text-ink-cream-2">{formatCount(summary.from)}</span>–
            <span className="text-ink-cream-2">{formatCount(summary.to)}</span> of{" "}
            <span className="text-ink-cream-2">{formatCount(data.total)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={summary.page <= 1}
              onClick={() =>
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    page: summary.page > 2 ? summary.page - 1 : undefined,
                  }),
                })
              }
              aria-label="previous page"
            >
              <ChevronLeft size={12} /> prev
            </Button>
            <span>
              page {summary.page} / {summary.pages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={summary.page >= summary.pages}
              onClick={() =>
                void navigate({ search: (prev) => ({ ...prev, page: summary.page + 1 }) })
              }
              aria-label="next page"
            >
              next <ChevronRight size={12} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BrowseRow({
  row,
  zebra,
  expanded,
  onToggle,
}: {
  row: ProspectBrowseRow;
  zebra: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { masked } = usePrivacy();
  const name = row.prospect?.name ?? nameFor(row.payload);
  const email = emailFor(row.payload);
  const title = row.prospect?.title ?? titleFor(row.payload);
  const company = companyFor(row.payload);
  const linkedinUrl = linkedinUrlFor(row.payload);
  const evidence = rationaleLine(row.playName, row.payload);
  const detail = sourceDetail(row.source);
  return (
    <Fragment>
      <tr
        onClick={onToggle}
        // Rows are the only way into the detail, so they take focus and toggle
        // on Enter like a button would.
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) onToggle();
        }}
        aria-expanded={expanded}
        className={cn(
          "cursor-pointer border-b border-ink-rule/60 focus:outline-none focus-visible:bg-ink-surface/60",
          "transition-colors duration-[var(--dur-stamp)]",
          "hover:bg-ink-surface/60",
          zebra && "bg-ink-surface/20",
          expanded && "bg-ink-surface/40",
        )}
      >
        <td className="w-6 py-2 pl-4 pr-0 text-ink-faint">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </td>
        <td className="py-2">
          <div className="text-ink-cream">{name ? <Pii kind="name">{name}</Pii> : "(unknown)"}</div>
          <div className="font-mono text-[11px] text-ink-faint">
            {email ? <Pii kind="email">{email}</Pii> : "—"}
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
          </div>
          {/* Freeform finder evidence can name people the structured masking
            cannot reach, so it hides under privacy mode as it does on /queue. */}
          {evidence && !masked ? (
            <div className="mt-0.5 max-w-[46ch] truncate text-[11px] text-ink-muted">
              {evidence}
            </div>
          ) : null}
        </td>
        <td className="py-2 text-ink-cream-2">
          {row.playName}
          {detail && (
            <div className="truncate font-mono text-[10.5px] text-ink-faint">{detail}</div>
          )}
        </td>
        <td className="py-2 pr-4">
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
        </td>
        <td className="py-2 text-[12px] text-ink-cream-2">
          {describeDecision(row)}
          {(row.prospect?.icpVerdict ?? payloadString(row.payload, "icpVerdict")) === "reject" && (
            <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[color:var(--ink-blocked-2)]">
              off-icp
            </span>
          )}
        </td>
        <td className="py-2 text-right font-mono text-[12px] text-ink-muted">
          {timeAgo(row.foundAt)}
        </td>
        <td className="px-6 py-2 text-right font-mono text-[12px] text-ink-muted">
          {row.decidedAt ? timeAgo(row.decidedAt) : "—"}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-ink-rule/60 bg-ink-surface/20">
          <td colSpan={7} className="px-6 py-4">
            <DetailPanel id={row.id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * The expanded row: everything /api/queue/:id knows about this candidate, plus
 * the override actions. Mounted per row (keyed by the table), so its
 * rejection draft dies with the row it belonged to.
 */
function DetailPanel({ id }: { id: number }) {
  const qc = useQueryClient();
  const { masked } = usePrivacy();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const detail = useQuery({
    queryKey: ["prospects", "detail", id],
    queryFn: () => api.queueRowDetail(id),
  });
  const d = detail.data ?? null;

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ["prospects"] });
    void qc.invalidateQueries({ queryKey: ["queue"] });
    void qc.invalidateQueries({ queryKey: ["home"] });
  };
  const approve = useMutation({
    mutationFn: (rowId: number) => api.approveQueue(rowId),
    onSuccess: () => {
      toast.success("approved — it will go out on the next drain");
      invalidate();
    },
    onError: (err) => toast.error(`couldn't approve · ${err.message}`),
  });
  const reject = useMutation({
    mutationFn: (vars: { rowId: number; reason?: string }) =>
      api.rejectQueue(vars.rowId, vars.reason),
    onSuccess: () => {
      toast.success("rejected");
      setRejecting(false);
      invalidate();
    },
    onError: (err) => toast.error(`couldn't reject · ${err.message}`),
  });

  const row = d?.row ?? null;
  // Never past a reply: the server refuses too (409), but the button should
  // not be there to press.
  const canApprove =
    row != null &&
    !d?.flags.replied &&
    (row.status === "pending" || row.status === "rejected" || row.status === "expired");
  const canReject = row != null && (row.status === "pending" || row.status === "approved");
  const icpVerdict = row?.prospect?.icpVerdict ?? payloadString(row?.payload, "icpVerdict");
  const icpReason =
    row?.prospect?.icpVerdictReason ?? payloadString(row?.payload, "icpVerdictReason");

  return (
    <div className="flex flex-col gap-4">
      {detail.isLoading || !d || !row ? (
        detail.isError ? (
          <div className="text-[13px] text-[color:var(--ink-blocked-2)]">
            {detail.error.message}
          </div>
        ) : (
          <Skeleton lines={8} />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {/* Decision block: what happened to this row and why. */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(row.status)}>{row.status}</Badge>
            <span className="text-[13px] text-ink-cream-2">{describeDecision(row)}</span>
            {row.decidedAt && (
              <span className="font-mono text-[11px] text-ink-faint">{timeAgo(row.decidedAt)}</span>
            )}
            {d.flags.icpReject && <Badge tone="blocked">off-icp</Badge>}
            {d.flags.bounced && <Badge tone="blocked">hard bounce</Badge>}
            {d.flags.contactSuppressed && (
              <Badge tone="blocked">
                {d.flags.contactSuppressed === "unsubscribe" ? "unsubscribed" : "mailbox gone"}
              </Badge>
            )}
            {d.flags.breakupHold && <Badge tone="blocked">do not contact</Badge>}
          </div>
          {row.notes && (
            <div>
              <div className="ln-eyebrow mb-1">notes · reason</div>
              {/* Freeform: an auto-reject reason routinely names the person and
                  their company, which structured masking cannot reach, so under
                  privacy mode it is withheld rather than half-masked. */}
              {masked ? (
                <div className="text-[12px] text-ink-faint">hidden under privacy mode</div>
              ) : (
                <div className="text-[13px] text-ink-cream-2">{row.notes}</div>
              )}
            </div>
          )}
          {d.flags.replied && (
            <div className="text-[12px] text-ink-muted">
              This person has replied — the conversation lives on /inbox and this row will not be
              re-approved here.
            </div>
          )}
          {row.status === "expired" && !d.flags.replied && (
            <div className="text-[12px] text-ink-muted">
              Expired rows can be approved again, but any draft below is stale — it will be
              re-drafted on the next run.
            </div>
          )}
          {rejecting && (
            <Field label="Reason (optional, logged for ICP-filter learning)">
              <Textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. wrong stage, wrong industry, already a customer"
              />
            </Field>
          )}

          <IdentityBlock row={row} detail={d} />

          {(icpVerdict || icpReason) && (
            <div>
              <div className="ln-eyebrow mb-1">icp verdict</div>
              <div className="text-[13px] text-ink-cream-2">
                <span
                  className={cn(icpVerdict === "reject" && "text-[color:var(--ink-blocked-2)]")}
                >
                  {icpVerdict ?? "—"}
                </span>
                {icpReason && (
                  <span className="text-ink-muted"> · {maskDeep(icpReason, masked)}</span>
                )}
              </div>
            </div>
          )}

          {d.cadences.length > 0 && (
            <div>
              <div className="ln-eyebrow mb-1">cadences</div>
              <ul className="flex flex-col gap-1 text-[13px] text-ink-cream-2">
                {d.cadences.map((c) => (
                  <CadenceLine key={`${c.prospectId}-${c.playName}`} c={c} />
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="ln-eyebrow mb-1">history</div>
            <ol className="flex flex-col gap-1">
              {d.timeline.map((ev) => (
                <li
                  key={`${ev.at}|${ev.kind}|${ev.label}`}
                  className="flex items-baseline gap-3 text-[13px]"
                >
                  <span className="w-[64px] shrink-0 text-right font-mono text-[11px] text-ink-faint">
                    {timeAgo(ev.at)}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-ink-cream-2">{ev.label}</span>
                  {ev.playName && ev.playName !== row.playName && (
                    <span className="font-mono text-[11px] text-ink-faint">{ev.playName}</span>
                  )}
                  {ev.detail && !masked && (
                    <span className="min-w-0 truncate text-[12px] text-ink-muted">{ev.detail}</span>
                  )}
                </li>
              ))}
            </ol>
          </div>

          {row.lastDraft && (
            <div>
              <div className="ln-eyebrow mb-1">
                last draft{row.lastDraft.sent ? " · sent" : ""}
                {row.lastDraftedAt ? ` · ${timeAgo(row.lastDraftedAt)}` : ""}
              </div>
              <div className="text-[13px] text-ink-cream">
                {maskDeep(row.lastDraft.subject, masked)}
              </div>
              <pre className="mt-1 max-h-[28vh] overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-ink-rule bg-ink-bg-deep p-3 font-prose text-[12.5px] leading-[1.55] text-ink-cream-2">
                {maskDeep(row.lastDraft.body, masked)}
              </pre>
            </div>
          )}

          <details className="text-ink-faint">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] hover:text-ink-cream-2">
              payload json
            </summary>
            <pre className="mt-2 max-h-[300px] overflow-auto rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep p-3 font-mono text-[11.5px] leading-[1.55] text-ink-cream-2">
              {JSON.stringify(maskDeep(row.payload, masked), null, 2)}
            </pre>
          </details>
        </div>
      )}
      {row && (canApprove || canReject || rejecting) && (
        <div className="flex items-center justify-end gap-2 border-t border-ink-rule/60 pt-3">
          {!rejecting && canReject && (
            <Button
              variant="ghost"
              onClick={() => {
                setReason(row.notes ?? "");
                setRejecting(true);
              }}
              {...readOnly}
            >
              <X size={12} /> Reject…
            </Button>
          )}
          {rejecting && (
            <>
              <Button variant="ghost" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={reject.isPending}
                onClick={() => reject.mutate({ rowId: row.id, reason: reason.trim() || undefined })}
                {...readOnly}
              >
                {reject.isPending ? "Rejecting…" : "Reject"}
              </Button>
            </>
          )}
          {!rejecting && canApprove && (
            <Button
              variant="secondary"
              disabled={approve.isPending}
              onClick={() => approve.mutate(row.id)}
              {...readOnly}
            >
              <Check size={12} /> {row.status === "rejected" ? "Approve anyway" : "Approve"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function IdentityBlock({ row, detail }: { row: ProspectBrowseRow; detail: QueueRowDetail }) {
  const { masked } = usePrivacy();
  const title = detail.prospect?.title ?? titleFor(row.payload);
  const company = detail.prospect?.company ?? companyFor(row.payload);
  // The prospect column is polymorphic (LinkedIn, X or GitHub) and written
  // unvalidated; run it through the same guard as the payload so a stored
  // `javascript:` value can never become an href.
  const linkedinUrl =
    linkedinUrlFor({ linkedinUrl: detail.prospect?.linkedinUrl }) ?? linkedinUrlFor(row.payload);
  const evidence = rationaleLine(row.playName, row.payload);
  const source = sourceDetail(row.source);
  return (
    <div>
      <div className="ln-eyebrow mb-1">who · why</div>
      <div className="text-[13px] text-ink-cream-2">
        {[title, company ? maskDeep(company, masked, "company") : null]
          .filter(Boolean)
          .join(" · ") || <span className="text-ink-faint">no title or company on record</span>}
        {linkedinUrl && (
          <a
            href={linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 text-ink-cream-2 underline decoration-ink-rule underline-offset-2 hover:text-ink-cream"
          >
            [in]
          </a>
        )}
      </div>
      {evidence && !masked && <div className="mt-0.5 text-[12px] text-ink-muted">{evidence}</div>}
      <div className="mt-1 font-mono text-[11px] text-ink-faint">
        surfaced {timeAgo(row.foundAt)} by {row.playName}
        {source ? ` · ${source}` : ""}
        {detail.prospect
          ? ` · prospect #${detail.prospect.id}${detail.prospect.linkedBy === "email" ? " (matched by email)" : ""}${detail.prospect.hasDossier ? " · researched" : ""}`
          : " · never emailed"}
      </div>
    </div>
  );
}

function CadenceLine({ c }: { c: CadenceView }) {
  return (
    <li className="flex items-center gap-2">
      <span>{c.playName}</span>
      <Badge
        tone={c.status === "replied" ? "receipt" : c.status === "active" ? "signal" : "neutral"}
      >
        {c.status}
      </Badge>
      <span className="font-mono text-[11px] text-ink-faint">
        step {Math.min(c.currentStep + 1, c.followupCount + 1)}/{c.followupCount + 1}
        {c.nextDueAt && c.status === "active" ? ` · next ${timeAgo(c.nextDueAt)}` : ""}
        {c.stopReason ? ` · ${c.stopReason.replace(/_/g, " ")}` : ""}
      </span>
    </li>
  );
}

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
