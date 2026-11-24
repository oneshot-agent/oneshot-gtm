import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CallRecordMode, LiveCallView } from "@oneshot-gtm/shared-types";
import { Loader2, PhoneOff } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { isLive } from "../../lib/bridgeCall.ts";
import { cn } from "../../lib/cn.ts";
import { formatDuration } from "../../lib/dialler.ts";
import {
  elapsedSec,
  liveCallLine,
  memberLabel,
  RECORDING_TONE_CLASS,
  recordingState,
} from "../../lib/liveCall.ts";
import { useMask, usePrivacy } from "../../lib/privacy.tsx";
import { readOnly } from "../../lib/readOnly.ts";
import { callKey } from "./DialPanel.tsx";
import { anyConnected, liveCallsKey, useLiveCallsPoll, useSecondTick } from "./useLiveCalls.ts";

/**
 * Every bridged call on now, on every page, under the header: yours with
 * Hang up and Open, a teammate's read-only, and whether each is being
 * recorded. Your ended calls stay until their outcome is logged. Its poll
 * also moves your own calls on, so a call keeps going wherever you are.
 */
export function LiveCallBar() {
  const { data } = useLiveCallsPoll();
  const calls = data?.enabled ? data.calls : [];
  const now = useSecondTick(anyConnected(calls));
  if (!data?.enabled || calls.length === 0) return null;
  return <LiveCallRows calls={calls} record={data.record} now={now} />;
}

/** Your ended calls shown as rows; the rest are counted. */
const ENDED_SHOWN = 3;

/** The bar's rows, apart from the poll so it renders from data alone. */
export function LiveCallRows({
  calls,
  record,
  now,
}: {
  calls: LiveCallView[];
  record: CallRecordMode;
  now: number;
}) {
  if (calls.length === 0) return null;
  // Every live call shows; of your ended ones waiting on an outcome, the
  // newest few do, and the rest are counted with a way to the Calls page.
  const live = calls.filter((c) => isLive(c));
  const ended = calls.filter((c) => !isLive(c));
  const more = ended.length - ENDED_SHOWN;
  return (
    <div
      role="status"
      aria-label="calls"
      className="divide-y divide-ink-rule border-b border-ink-rule bg-ink-bg-deep/70 font-mono text-[11px] text-ink-muted ln-mono"
    >
      {[...live, ...ended.slice(0, ENDED_SHOWN)].map((c) => (
        <LiveCallRow key={c.id} call={c} record={record} now={now} />
      ))}
      {more > 0 && (
        <div className="px-6 py-1.5">
          <Link to="/calls" className="text-ink-cream underline-offset-2 hover:underline">
            +{more} more {more === 1 ? "call" : "calls"} to log
          </Link>
        </div>
      )}
    </div>
  );
}

function LiveCallRow({
  call: c,
  record,
  now,
}: {
  call: LiveCallView;
  record: CallRecordMode;
  now: number;
}) {
  const qc = useQueryClient();
  const mask = useMask();
  const { masked } = usePrivacy();
  const hangUp = useMutation({
    mutationFn: (id: number) => api.hangUpCall(id),
    onSuccess: (updated) => qc.setQueryData(callKey(updated.id), updated),
    onError: (err) => toast.error(`couldn't hang up · ${err.message}`),
    onSettled: (_d, _e, id) => {
      void qc.invalidateQueries({ queryKey: liveCallsKey });
      void qc.invalidateQueries({ queryKey: callKey(id) });
    },
  });
  const live = isLive(c);
  const name = mask("name", c.prospectName);
  const rec = recordingState(c, record);
  const sec = elapsedSec(c, now);
  const shownSec = sec ?? (!live && c.durationSec != null ? c.durationSec : null);
  const open = {
    to: "/calls" as const,
    search: {
      prospect: c.prospectId,
      ...(c.playName ? { play: c.playName } : {}),
      call: c.id,
    },
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-6 py-1.5">
      <span
        aria-hidden
        className={cn(
          "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
          !live
            ? "bg-ink-faint"
            : rec.tone === "recording"
              ? "animate-pulse bg-[color:var(--ink-blocked-2)]"
              : "animate-pulse bg-ink-cream-2",
        )}
      />
      {!c.mine && <span className="text-ink-cream-2">{memberLabel(c.member, masked)} ·</span>}
      <span className="min-w-0 truncate text-ink-cream">{liveCallLine(c, name)}</span>
      {shownSec != null && (
        <span className="text-ink-cream-2" aria-label="call time">
          · {formatDuration(shownSec)}
        </span>
      )}
      <span className={RECORDING_TONE_CLASS[rec.tone]}>· {rec.label}</span>
      <span className="ml-auto flex items-center gap-3">
        <Link {...open} className="text-ink-cream underline-offset-2 hover:underline">
          {c.mine && !live ? "Log outcome" : "Open"}
        </Link>
        {c.mine && live && (
          <button
            type="button"
            disabled={hangUp.isPending}
            onClick={() => hangUp.mutate(c.id)}
            className="inline-flex items-center gap-1 text-[color:var(--ink-blocked-2)] hover:underline disabled:opacity-50"
            {...readOnly}
          >
            {hangUp.isPending ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <PhoneOff size={10} />
            )}
            Hang up
          </button>
        )}
      </span>
    </div>
  );
}
