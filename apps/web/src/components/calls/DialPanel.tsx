import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CallBrief,
  CallListResponse,
  CallListRow,
  LogCallRequest,
} from "@oneshot-gtm/shared-types";
import { Loader2, Phone, RotateCw } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { cn, timeAgo } from "../../lib/cn.ts";
import {
  defaultHoldUntil,
  dialKeyAction,
  dialReducer,
  formatDuration,
  logCallRequest,
  OUTCOME_KEYS,
  beginCall,
  localTimeNow,
  outcomeTitle,
  windowHint,
} from "../../lib/dialler.ts";
import { humanizeFlag } from "../../lib/flagLabels.ts";
import { useMask } from "../../lib/privacy.tsx";
import { readOnly } from "../../lib/readOnly.ts";
import { SheetHeading } from "../ledger/SheetHeading.tsx";
import { Button, buttonStyles } from "../primitives/Button.tsx";
import { Input, Textarea } from "../primitives/Field.tsx";
import { NoNumber } from "./NoNumber.tsx";

export const briefKey = (row: Pick<CallListRow, "prospectId" | "playName">) => [
  "call-brief",
  row.prospectId,
  row.playName,
];

/**
 * Log one call and move on: posts the outcome, then opens the next row in
 * the same section (or closes the panel at its end). When the founder opened
 * someone else while the save ran, the page stays where they went. Kept
 * apart from the component so the keyboard path and the button path are the
 * same code.
 */
export async function saveCall(
  log: (prospectId: number, req: LogCallRequest) => Promise<unknown>,
  row: Pick<CallListRow, "prospectId">,
  req: LogCallRequest,
  next: Pick<CallListRow, "prospectId"> | null,
  open: (prospectId: number | null) => void,
  isOpen: (prospectId: number) => boolean,
): Promise<void> {
  await log(row.prospectId, req);
  if (isOpen(row.prospectId)) open(next?.prospectId ?? null);
}

/**
 * The open row: the brief to read, Call, the outcome keys, a note, and
 * Save & next. One panel per prospect (keyed by the page), so nothing typed
 * for one person carries over to the next.
 */
export function DialPanel({
  row,
  next,
  dialMode,
  window: callWindow,
  now,
  onRefresh,
  startedAt,
  onStart,
  onOpen,
  isOpen,
}: {
  row: CallListRow;
  next: CallListRow | null;
  dialMode: CallListResponse["dialMode"];
  window: CallListResponse["window"];
  /** The page's clock, which the call window is read on. */
  now: Date;
  /** Re-read the clock: Call found the window closed. */
  onRefresh: () => void;
  /** When Call was pressed for this row (ms); null before. */
  startedAt: number | null;
  onStart: () => void;
  onOpen: (prospectId: number | null) => void;
  /** Whether this prospect is still the open row. */
  isOpen: (prospectId: number) => boolean;
}) {
  const qc = useQueryClient();
  const mask = useMask();
  const [state, dispatch] = useReducer(dialReducer, undefined, () => ({
    outcome: null,
    note: "",
    holdUntil: defaultHoldUntil(),
  }));
  const elapsed = useElapsed(startedAt);

  const brief = useQuery({
    queryKey: briefKey(row),
    queryFn: () => api.callBrief(row.prospectId, { playName: row.playName }).then((r) => r.brief),
    staleTime: Infinity,
    retry: false,
  });
  const regenerate = useMutation({
    mutationFn: () => api.callBrief(row.prospectId, { playName: row.playName, regenerate: true }),
    onSuccess: (r) => qc.setQueryData(briefKey(row), r.brief),
    onError: (err) => toast.error(`couldn't write the brief · ${err.message}`),
  });
  const history = useQuery({
    queryKey: ["prospect-calls", row.prospectId],
    queryFn: () => api.prospectCalls(row.prospectId),
  });

  const save = useMutation({
    mutationFn: (req: LogCallRequest) => saveCall(api.logCall, row, req, next, onOpen, isOpen),
    onSuccess: (_data, req) => {
      void qc.invalidateQueries({ queryKey: ["calls"] });
      void qc.invalidateQueries({ queryKey: ["prospect-calls", row.prospectId] });
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      toast.success(`logged · ${outcomeTitle(req.outcome)}`);
    },
    onError: (err) => toast.error(`couldn't log the call · ${err.message}`),
  });
  const request = logCallRequest(state, {
    durationSec: startedAt != null ? elapsed : null,
    playName: row.playName,
  });
  const submit = () => {
    if (request && !save.isPending) save.mutate(request);
  };

  // Digits pick an outcome, Enter saves. The latest submit, without re-binding.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = dialKeyAction(e);
      if (!action) return;
      e.preventDefault();
      if (action.kind === "save") submitRef.current();
      else dispatch(action);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const localTime = localTimeNow(row.local, now);
  const flags = brief.data?.flags ?? [];

  return (
    <div className="flex flex-col gap-5 rounded-[var(--radius-md)] border border-ink-rule bg-ink-bg-deep/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] text-ink-cream">{mask("name", row.name) || "—"}</div>
          <div className="mt-0.5 text-[12px] text-ink-muted">
            {[row.title, mask("company", row.company)].filter(Boolean).join(" · ")}
          </div>
          <div className="mt-1 font-mono text-[11.5px] text-ink-muted">
            {row.phone ? mask("phone", row.phone) : <NoNumber row={row} />}
            {localTime && <span> · {localTime} their time</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {startedAt != null && (
            <span className="font-mono text-[13px] text-ink-cream" aria-label="call time">
              {formatDuration(elapsed)}
            </span>
          )}
          <CallControl
            row={row}
            dialMode={dialMode}
            window={callWindow}
            now={now}
            onStart={onStart}
            onRefresh={onRefresh}
            className="h-8 px-3 text-[13px]"
          />
        </div>
      </div>

      <section>
        <SheetHeading
          label="brief"
          right={
            <Button
              variant="ghost"
              size="sm"
              disabled={brief.isFetching || regenerate.isPending}
              onClick={() => regenerate.mutate()}
              title="Write the brief again (an LLM call)"
              {...readOnly}
            >
              <RotateCw size={11} /> Regenerate
            </Button>
          }
        />
        {brief.isLoading || regenerate.isPending ? (
          <div className="flex items-center gap-2 text-[12px] text-ink-muted">
            <Loader2 size={12} className="animate-spin" /> Writing the brief…
          </div>
        ) : brief.error ? (
          <div className="font-mono text-[12px] text-[color:var(--ink-blocked-2)]">
            couldn't load the brief · {brief.error.message}
          </div>
        ) : brief.data ? (
          <BriefView brief={brief.data} flags={flags} />
        ) : null}
      </section>

      <section>
        <SheetHeading label="outcome" />
        <div className="flex flex-wrap gap-1.5">
          {OUTCOME_KEYS.map((o) => (
            <Button
              key={o.outcome}
              size="sm"
              variant={state.outcome === o.outcome ? "primary" : "secondary"}
              aria-pressed={state.outcome === o.outcome}
              onClick={() => dispatch({ kind: "pick", outcome: o.outcome })}
            >
              <kbd className="font-mono text-[10px] opacity-60">{o.key}</kbd>
              {o.title}
            </Button>
          ))}
        </div>
        {state.outcome === "not_now" && (
          <label className="mt-3 flex items-center gap-2 text-[12px] text-ink-muted">
            Call again from
            <Input
              type="date"
              className="w-auto"
              value={state.holdUntil}
              onChange={(e) => dispatch({ kind: "hold", holdUntil: e.target.value })}
            />
          </label>
        )}
        <Textarea
          className="mt-3"
          placeholder="Note"
          aria-label="Note"
          value={state.note}
          onChange={(e) => dispatch({ kind: "note", note: e.target.value })}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="font-mono text-[11px] text-ink-faint">
            1–0 pick · ↵ save · ⌘↵ from the note
          </span>
          <Button
            size="sm"
            disabled={!request || save.isPending}
            onClick={submit}
            title={next ? "Log this call and open the next one" : "Log this call"}
            {...readOnly}
          >
            {save.isPending && <Loader2 size={11} className="animate-spin" />}
            {next ? "Save & next" : "Save"}
          </Button>
        </div>
      </section>

      <section>
        <SheetHeading label="calls" />
        {history.data && history.data.calls.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-[12px] text-ink-cream-2">
            {history.data.calls.map((c) => (
              <li key={c.id}>
                <span className="font-mono text-[11px] text-ink-muted">{timeAgo(c.startedAt)}</span>{" "}
                {outcomeTitle(c.outcome)}
                {c.durationSec != null && (
                  <span className="text-ink-muted"> · {formatDuration(c.durationSec)}</span>
                )}
                {c.note && <span className="text-ink-muted"> · {c.note}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[12px] text-ink-faint">
            {history.isLoading ? "…" : "No calls logged yet."}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Call, as the workspace can place it: a tel: link today; with the bridge
 * configured, the button that will ring the founder's phone. Outside their
 * call window it is replaced by the hint.
 */
export function CallControl({
  row,
  dialMode,
  window: callWindow,
  now,
  onStart,
  onRefresh,
  className,
}: {
  row: Pick<CallListRow, "phone" | "local">;
  dialMode: CallListResponse["dialMode"];
  window: CallListResponse["window"];
  now: Date;
  onStart: () => void;
  onRefresh: () => void;
  className?: string;
}) {
  if (!row.phone) return null;
  const hint = windowHint(row, callWindow, now);
  if (hint) return <span className="font-mono text-[11px] text-ink-faint">{hint}</span>;
  if (dialMode === "bridge") {
    return (
      <span className="flex flex-col items-end gap-1">
        <Button size="sm" disabled>
          <Phone size={11} /> Ring my phone
        </Button>
        <span className="text-[11px] text-ink-faint">
          Ringing your phone arrives with the call bridge
        </span>
      </span>
    );
  }
  return (
    <a
      href={`tel:${row.phone}`}
      // Checked again on the clock as it is now: the page's clock ticks only every 30s.
      onClick={(e) => beginCall(e, row, callWindow, { start: onStart, refresh: onRefresh })}
      className={cn(buttonStyles({ variant: "receipt", size: "sm" }), className)}
    >
      <Phone size={11} /> Call
    </a>
  );
}

function briefBlock(label: string, body: React.ReactNode) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className="mt-1 font-prose text-[13.5px] leading-[1.55] text-ink-cream">{body}</div>
    </div>
  );
}

function BriefView({ brief, flags }: { brief: CallBrief; flags: string[] }) {
  return (
    <div className="flex flex-col gap-3">
      {flags.length > 0 && (
        <div className="text-[12px] text-[color:var(--ink-spend-2)]">
          Check the wording: {flags.map(humanizeFlag).join(", ")}
        </div>
      )}
      {briefBlock("Opener", brief.opener)}
      {briefBlock("Offer", brief.offer)}
      {brief.questions.length > 0 &&
        briefBlock(
          "Questions",
          <ul className="list-disc pl-4">
            {brief.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>,
        )}
      {brief.objections.length > 0 &&
        briefBlock(
          "If they say",
          <dl className="flex flex-col gap-1.5">
            {brief.objections.map((o) => (
              <div key={o.objection}>
                <dt className="text-ink-cream-2">{o.objection}</dt>
                <dd className="text-ink-muted">{o.answer}</dd>
              </div>
            ))}
          </dl>,
        )}
      {briefBlock("Voicemail", brief.voicemail)}
      {brief.gatekeeper && briefBlock("Gatekeeper", brief.gatekeeper)}
    </div>
  );
}

/** Seconds since `startedAt`, ticking once a second; 0 before a call starts. */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}
