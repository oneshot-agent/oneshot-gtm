import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { CallListResponse, CallListRow } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { CallControl, DialPanel } from "../components/calls/DialPanel.tsx";
import { NoNumber } from "../components/calls/NoNumber.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { cn, timeAgo } from "../lib/cn.ts";
import {
  beginCall,
  canDial,
  findRow,
  localTimeNow,
  newSaveKey,
  nextRow,
  outcomeTitle,
  rowId,
  sameRow,
  sectionRows,
  timersAfterLog,
  windowHint,
  type CallTimer,
  type RowKey,
} from "../lib/dialler.ts";
import { useMask } from "../lib/privacy.tsx";

interface CallsSearch {
  /** The open row, e.g. from a cadence's "Open call". */
  prospect?: number;
  /** Its play, for a Due row: a person can be due in two. */
  play?: string;
}

export const Route = createFileRoute("/calls")({
  staticData: { title: "Calls" },
  validateSearch: (search: Record<string, unknown>): CallsSearch => {
    const id = Number(search["prospect"]);
    if (!Number.isInteger(id) || id <= 0) return {};
    const play = search["play"];
    return typeof play === "string" && play ? { prospect: id, play } : { prospect: id };
  },
  component: CallsPage,
});

function CallsPage() {
  const { prospect, play } = Route.useSearch();
  const navigate = Route.useNavigate();
  const query = useQuery({ queryKey: ["calls"], queryFn: api.calls, refetchInterval: 60_000 });
  const open = (row: RowKey | null) =>
    void navigate({
      search:
        row == null
          ? {}
          : { prospect: row.prospectId, ...(row.playName ? { play: row.playName } : {}) },
      replace: true,
    });
  return (
    <CallsView
      data={query.data}
      error={query.error}
      selected={prospect}
      {...(play ? { selectedPlay: play } : {})}
      onOpen={open}
    />
  );
}

/** The page body, apart from the router so it renders from data alone. */
export function CallsView({
  data,
  error,
  selected,
  selectedPlay,
  onOpen,
}: {
  data: CallListResponse | undefined;
  error?: Error | null;
  selected: number | undefined;
  selectedPlay?: string;
  onOpen: (row: RowKey | null) => void;
}) {
  // When Call was pressed, the number it dialled and the step the row was
  // on, per row (`rowId`), until that row's call is logged.
  const [started, setStarted] = useState<Record<string, CallTimer>>({});
  const start = (row: CallListRow, phone: string | null) =>
    setStarted((s) => ({
      ...s,
      [rowId(row)]: {
        prospectId: row.prospectId,
        at: Date.now(),
        phone,
        currentStep: row.currentStep,
        enrolledAt: row.enrolledAt,
      },
    }));
  // Each row's next save id, kept here so a panel that remounts while its
  // save runs retries with the same one; a logged save takes a new one.
  const saveKeys = useRef(new Map<string, string>());
  const saveKeyFor = (row: RowKey) => {
    const id = rowId(row);
    const key = saveKeys.current.get(id) ?? newSaveKey();
    saveKeys.current.set(id, key);
    return key;
  };
  // The call window is read on this clock, so a row turns callable (or not)
  // as a boundary passes, without waiting on the next poll.
  const [now, refresh] = useNow(CLOCK_TICK_MS);
  // Which row is open as of the latest render: a save that finishes after the
  // founder opened someone else must not move them on.
  const openRef = useRef<CallListRow | null>(null);

  const header = (
    <div>
      <h1 className="ln-eyebrow mb-1">Calls</h1>
      <p className="text-[13px] text-ink-muted">
        Due cadence calls first, then everyone else with a number.
        {data?.enabled &&
          ` Calls go out ${data.window.start}–${data.window.end} their time${data.window.weekdays ? ", weekdays" : ""}.`}
      </p>
    </div>
  );

  // A failed refresh keeps the page (and the open panel's outcome and note);
  // only a first load that failed replaces it.
  if (error && !data) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="font-mono text-[12px] text-[color:var(--ink-blocked-2)]">
          couldn't load calls · {error.message}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="rounded-[var(--radius-md)] border border-ink-rule">
          {[0, 1, 2].map((i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      </div>
    );
  }
  if (!data.enabled) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyNote
          note={
            <>
              Calls are off for this workspace. Turn them on in{" "}
              <Link
                to="/setup"
                hash="calls"
                className="text-ink-cream underline underline-offset-2"
              >
                Setup
              </Link>
              .
            </>
          }
        />
      </div>
    );
  }

  const row = selected != null ? findRow(data, selected, selectedPlay) : null;
  openRef.current = row;
  const next = row ? nextRow(sectionRows(data, row), row) : null;
  const section = (title: string, rows: CallListRow[], empty: string) => (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-medium text-ink-cream">
        {title} {rows.length > 0 && `(${rows.length})`}
      </h2>
      {rows.length === 0 ? (
        <div className="text-[12px] text-ink-faint">{empty}</div>
      ) : (
        <div className="flex flex-col divide-y divide-ink-rule rounded-[var(--radius-md)] border border-ink-rule">
          {rows.map((r) => (
            <CallRow
              key={rowId(r)}
              row={r}
              data={data}
              now={now}
              onRefresh={refresh}
              open={row != null && sameRow(r, row)}
              onOpen={() => onOpen(r)}
              onStart={(phone) => {
                onOpen(r);
                start(r, phone);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="flex flex-col gap-6">
      {header}
      {error && (
        <div className="font-mono text-[12px] text-[color:var(--ink-blocked-2)]">
          couldn't refresh calls · {error.message}
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col gap-8">
          {section("Due", data.due, "No cadence calls due.")}
          {section("Call list", data.list, "Nobody else with a number.")}
        </div>
        <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          {row ? (
            <DialPanel
              key={rowId(row)}
              row={row}
              next={next}
              dialMode={data.dialMode}
              window={data.window}
              now={now}
              onRefresh={refresh}
              started={started[rowId(row)] ?? null}
              saveKey={saveKeyFor(row)}
              onStart={(phone) => start(row, phone)}
              onLogged={(logged, at, key) => {
                setStarted((s) => timersAfterLog(s, { row: logged, at }));
                if (saveKeys.current.get(rowId(logged)) === key)
                  saveKeys.current.delete(rowId(logged));
              }}
              onOpen={onOpen}
              isOpen={(r) => openRef.current != null && sameRow(openRef.current, r)}
            />
          ) : selected != null ? (
            <EmptyNote note="This person isn't on the call list: no usable number, or they can't be contacted." />
          ) : (
            <div className="text-[12px] text-ink-faint">Open someone to see their brief.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function CallRow({
  row,
  data,
  now,
  onRefresh,
  open,
  onOpen,
  onStart,
}: {
  row: CallListRow;
  data: CallListResponse;
  now: Date;
  onRefresh: () => void;
  open: boolean;
  onOpen: () => void;
  onStart: (phone: string | null) => void;
}) {
  const mask = useMask();
  const hint = windowHint(row, data.window, now);
  const dialable = canDial(row, data.window, now) && data.dialMode === "tel";
  const localTime = localTimeNow(row.local, now);
  return (
    <div
      onClick={(e) => {
        // The row's own links and buttons must not also open it.
        if ((e.target as HTMLElement).closest("a, button")) return;
        onOpen();
      }}
      className={cn(
        "flex cursor-pointer items-start justify-between gap-4 px-4 py-3",
        "transition-colors duration-[var(--dur-stamp)] hover:bg-ink-surface/60",
        open && "bg-ink-surface",
      )}
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          className="truncate text-left text-[13px] text-ink-cream hover:underline"
        >
          {mask("name", row.name) || "—"}
        </button>
        <div className="truncate text-[12px] text-ink-muted">
          {[row.title, mask("company", row.company)].filter(Boolean).join(" · ")}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-ink-muted">
          {row.phone == null ? (
            <NoNumber row={row} />
          ) : dialable ? (
            <a
              href={`tel:${row.phone}`}
              onClick={(e) =>
                beginCall(e, row, data.window, { start: onStart, refresh: onRefresh })
              }
              className="hover:text-ink-cream"
            >
              {mask("phone", row.phone)}
            </a>
          ) : (
            <span>{mask("phone", row.phone)}</span>
          )}
          {localTime && <span>· {localTime} their time</span>}
          <span>· {row.reason}</span>
          {row.lastTouchAt && <span>· last touch {timeAgo(row.lastTouchAt)}</span>}
          {row.lastCall && (
            <span>
              · last call {outcomeTitle(row.lastCall.outcome)} {timeAgo(row.lastCall.at)}
            </span>
          )}
        </div>
      </div>
      {/* The bridge's button lives in the panel only. */}
      {(data.dialMode === "tel" || hint) && (
        <CallControl
          row={row}
          dialMode={data.dialMode}
          window={data.window}
          now={now}
          onStart={onStart}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}

const CLOCK_TICK_MS = 30_000;

/** The current time, re-read every `ms` and on demand. */
function useNow(ms: number): [Date, () => void] {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return [now, () => setNow(new Date())];
}
