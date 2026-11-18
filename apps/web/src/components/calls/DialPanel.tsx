import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  CallBrief,
  CallListResponse,
  CallListRow,
  CallRecordMode,
  CallRecordView,
  CurrentMember,
  LogCallRequest,
} from "@oneshot-gtm/shared-types";
import { Loader2, Phone, PhoneOff, RotateCw, X } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { IS_DEMO } from "../../api/demo.ts";
import {
  bridgePollMs,
  bridgeStatusLine,
  callerLabel,
  commitmentsToSend,
  CONSENT_LINE,
  firstName,
  isLive,
  keptCommitments,
  resumableCall,
  saveHeld,
  speakerLabel,
  suggestedPick,
  transcriptTurns,
} from "../../lib/bridgeCall.ts";
import { cn, timeAgo } from "../../lib/cn.ts";
import {
  canDial,
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
  type RowKey,
} from "../../lib/dialler.ts";
import { humanizeFlag } from "../../lib/flagLabels.ts";
import { useMask, usePrivacy } from "../../lib/privacy.tsx";
import { readOnly } from "../../lib/readOnly.ts";
import { SheetHeading } from "../ledger/SheetHeading.tsx";
import { Button, buttonStyles } from "../primitives/Button.tsx";
import { Input, Textarea } from "../primitives/Field.tsx";
import { callsMeKey } from "../setup/YourPhone.tsx";
import { NoNumber } from "./NoNumber.tsx";

export const briefKey = (row: Pick<CallListRow, "prospectId" | "playName">) => [
  "call-brief",
  row.prospectId,
  row.playName,
];
export const callKey = (id: number | null) => ["call", id];

/**
 * Log one call and move on: posts the outcome, then opens the next row in
 * the same section (or closes the panel at its end). When the founder opened
 * someone else while the save ran, the page stays where they went. Kept
 * apart from the component so the keyboard path and the button path are the
 * same code.
 */
export async function saveCall(
  log: (prospectId: number, req: LogCallRequest) => Promise<unknown>,
  row: RowKey,
  req: LogCallRequest,
  next: RowKey | null,
  open: (row: RowKey | null) => void,
  isOpen: (row: RowKey) => boolean,
): Promise<void> {
  await log(row.prospectId, req);
  if (isOpen(row)) open(next);
}

/**
 * The number a log names: the one Call dialled, captured when it was pressed
 * (a refresh may have changed the row's since); the row's own when no call
 * was started here (dialled by hand from the number shown).
 */
export function dialledNumber(
  startedAt: number | null,
  dialledPhone: string | null,
  rowPhone: string | null,
): string | null {
  return startedAt != null ? dialledPhone : rowPhone;
}

/**
 * The open row: brief, Call, outcome keys, note, Save & next. Keyed per
 * prospect by the page, so nothing typed for one person carries over. With
 * the bridge, the panel follows the call live and pre-fills what the
 * transcript suggests; nothing is logged until Save.
 */
export function DialPanel({
  row,
  next,
  dialMode,
  window: callWindow,
  now,
  onRefresh,
  startedAt,
  dialledPhone,
  saveKey,
  onStart,
  onLogged,
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
  /** The number Call dialled, captured when it was pressed; null before. */
  dialledPhone: string | null;
  /** This row's next save id, held by the page: a retry, even from a remounted panel, sends the same. */
  saveKey: string;
  onStart: (phone: string | null) => void;
  /**
   * A call was logged for this row: the timer (`startedAt` then) and the
   * save id it was submitted with are spent, so a later log reuses neither.
   */
  onLogged: (row: RowKey, startedAt: number | null, saveKey: string) => void;
  onOpen: (row: RowKey | null) => void;
  /** Whether this row is still the open one. */
  isOpen: (row: RowKey) => boolean;
}) {
  const qc = useQueryClient();
  const mask = useMask();
  const { masked } = usePrivacy();
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
  // Same key as the header's, so the history can say "you".
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: !IS_DEMO });
  const callsMe = useQuery({
    queryKey: callsMeKey,
    queryFn: api.callsMe,
    retry: false,
    staleTime: 60_000,
    enabled: !IS_DEMO,
  });

  // The bridged call on this panel: the one Call started here, else an
  // unlogged one from the history (a reload, or someone opened mid-call),
  // even once new calls are tel: links.
  const bridged = dialMode === "bridge";
  const [startedId, setStartedId] = useState<number | null>(null);
  const [ringPhone, setRingPhone] = useState<string | null>(null);
  const resumed = startedId == null ? resumableCall(history.data?.calls, me.data) : null;
  const callId = startedId ?? resumed?.id ?? null;
  const live = useQuery({
    queryKey: callKey(callId),
    queryFn: () => api.call(callId!),
    enabled: callId != null,
    refetchInterval: (q) => bridgePollMs(q.state.data),
  });
  const call = live.data ?? resumed ?? undefined;
  const callLive = isLive(call);
  const connectedSec = useElapsed(useConnectedAt(call));

  const ring = useMutation({
    mutationFn: () =>
      api.startCall({
        prospectId: row.prospectId,
        ...(row.playName ? { playName: row.playName } : {}),
      }),
    // A new call gets a blank draft. A refused start keeps the draft, so it
    // can still be saved for the call before.
    onSuccess: (c) => {
      qc.setQueryData(callKey(c.id), c);
      setStartedId(c.id);
      setRingPhone(row.phone);
      dispatch({ kind: "reset", holdUntil: defaultHoldUntil() });
    },
  });
  const hangUp = useMutation({
    mutationFn: (id: number) => api.hangUpCall(id),
    onSuccess: (c) => qc.setQueryData(callKey(c.id), c),
    onError: (err) => toast.error(`couldn't hang up · ${err.message}`),
  });
  const recordMode: CallRecordMode = callsMe.data?.record ?? false;
  const startRecording = useMutation({
    mutationFn: (id: number) => api.recordCall(id),
    onSuccess: (c) => qc.setQueryData(callKey(c.id), c),
    onError: (err) => toast.error(`couldn't start recording · ${err.message}`),
  });
  // Its own action: no outcome needed, and open from the history after Save.
  const discard = useMutation({
    mutationFn: (id: number) => api.discardRecording(id),
    onSuccess: (c) => {
      qc.setQueryData(callKey(c.id), c);
      if (c.id === call?.id) dispatch({ kind: "forget-call" });
      void qc.invalidateQueries({ queryKey: ["prospect-calls", row.prospectId] });
      toast.success("recording and transcript deleted");
    },
    onError: (err) => toast.error(`couldn't delete the recording · ${err.message}`),
  });
  // Once it ends, the history shows it; the suggestion fills an untouched panel once.
  useEffect(() => {
    if (call?.status === "ended" || call?.status === "failed")
      void qc.invalidateQueries({ queryKey: ["prospect-calls", row.prospectId] });
  }, [call?.status, qc, row.prospectId]);
  const suggestedFor = useRef<number | null>(null);
  const suggestion = suggestedPick(call?.suggestion ?? null);
  // The suggested promises the member removed before saving, for this call only.
  const [removed, setRemoved] = useState<{ callId: number; indices: number[] } | null>(null);
  const commitments = keptCommitments(
    call?.suggestion ?? null,
    removed && removed.callId === call?.id ? removed.indices : [],
  );
  const removeCommitment = (index: number) => {
    if (!call) return;
    setRemoved((r) => ({
      callId: call.id,
      indices: [...(r && r.callId === call.id ? r.indices : []), index],
    }));
  };
  const suggestionCallId = call?.suggestion ? call.id : null;
  useEffect(() => {
    if (suggestionCallId == null || suggestedFor.current === suggestionCallId) return;
    const pick = suggestedPick(call?.suggestion ?? null);
    if (!pick) return;
    suggestedFor.current = suggestionCallId;
    dispatch({ kind: "suggest", ...pick });
    // Applied once per call, when its suggestion first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionCallId]);

  const save = useMutation({
    mutationFn: ({ req }: { req: LogCallRequest; timer: number | null }) =>
      saveCall(api.logCall, row, req, next, onOpen, isOpen),
    onSuccess: (_data, { req, timer }) => {
      onLogged(row, timer, req.clientKey ?? "");
      void qc.invalidateQueries({ queryKey: ["calls"] });
      void qc.invalidateQueries({ queryKey: ["prospect-calls", row.prospectId] });
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      toast.success(`logged · ${outcomeTitle(req.outcome)}`);
    },
    onError: (err) => toast.error(`couldn't log the call · ${err.message}`),
  });
  // The step the row was opened on, for the call started from it: a bridged
  // call reopened from another row lets the server judge its step.
  const sameRowCall = !call || (call.playName ?? null) === (row.playName ?? null);
  const step = sameRowCall ? { currentStep: row.currentStep, enrolledAt: row.enrolledAt } : {};
  const bridgedOpts = call
    ? { durationSec: call.durationSec, playName: row.playName, phone: ringPhone, callId: call.id }
    : null;
  const request = logCallRequest(
    state,
    bridgedOpts
      ? {
          ...bridgedOpts,
          ...step,
          clientKey: saveKey,
          commitments: commitmentsToSend(call?.suggestion ?? null, commitments, masked),
        }
      : {
          durationSec: startedAt != null ? elapsed : null,
          playName: row.playName,
          phone: dialledNumber(startedAt, dialledPhone, row.phone),
          currentStep: row.currentStep,
          enrolledAt: row.enrolledAt,
          clientKey: saveKey,
        },
  );
  const holdSave = saveHeld(call, { pollFailed: live.error != null, starting: ring.isPending });
  const submit = () => {
    if (request && !holdSave && !save.isPending) save.mutate({ req: request, timer: startedAt });
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
  const noteSuggested = suggestion != null && !!state.noteFromCall;
  const needsPhone =
    !bridged &&
    callsMe.data?.bridgeReady === true &&
    callsMe.data.phone.status !== "verified" &&
    row.phone != null;

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
          {!callLive && (
            <CallControl
              row={row}
              dialMode={dialMode}
              window={callWindow}
              now={now}
              onStart={onStart}
              onRefresh={onRefresh}
              onRing={() => ring.mutate()}
              ringing={ring.isPending}
              className="h-8 px-3 text-[13px]"
            />
          )}
        </div>
      </div>
      {needsPhone && (
        <div className="-mt-3 text-[12px] text-ink-faint">
          To have Call ring your own phone and record a transcript, verify it in{" "}
          <Link to="/setup" hash="calls" className="text-ink-cream underline underline-offset-2">
            Setup
          </Link>
          .
        </div>
      )}
      {bridged && ring.error && (
        <div className="-mt-3 text-[12px] text-[color:var(--ink-blocked-2)]" role="alert">
          {ring.error.message}
        </div>
      )}

      {call && (
        <section>
          <SheetHeading label="call" />
          <BridgeCallView
            call={call}
            first={firstName(mask("name", row.name))}
            record={recordMode}
            connectedSec={connectedSec}
            hangingUp={hangUp.isPending}
            onHangUp={() => hangUp.mutate(call.id)}
            pollError={live.error}
            masked={masked}
            commitments={commitments}
            onRemoveCommitment={removeCommitment}
            onRecord={() => startRecording.mutate(call.id)}
            recording={startRecording.isPending}
            onDeclineConsent={() => discard.mutate(call.id)}
            declineDisabled={discard.isPending}
          />
        </section>
      )}

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
          masked ? (
            <PrivacyHidden />
          ) : (
            <BriefView brief={brief.data} flags={flags} />
          )
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
              {suggestion?.outcome === o.outcome && (
                <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] opacity-70">
                  suggested
                </span>
              )}
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
        {noteSuggested && masked ? (
          // The suggested note restates the call: privacy mode hides it, as it hides the transcript.
          <div className="mt-3 text-[12px] text-ink-faint">
            Suggested note hidden while privacy mode is on.
          </div>
        ) : (
          <Textarea
            className="mt-3"
            placeholder="Note"
            aria-label="Note"
            value={state.note}
            onChange={(e) => dispatch({ kind: "note", note: e.target.value })}
          />
        )}
        {suggestion && (state.outcome === suggestion.outcome || noteSuggested) && (
          <div className="mt-1.5 text-[11.5px] text-ink-spend-2">
            Suggested from the call. Check it, change anything that's wrong, then save.
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="font-mono text-[11px] text-ink-faint">
            {ring.isPending
              ? "starting the call…"
              : holdSave
                ? "save once the call ends"
                : "1–0 pick · ↵ save · ⌘↵ from the note"}
          </span>
          <Button
            size="sm"
            disabled={!request || holdSave || save.isPending}
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
        <CallHistory
          calls={history.data?.calls}
          isLoading={history.isLoading}
          error={history.error}
          onRetry={() => void history.refetch()}
          masked={masked}
          me={me.data}
          {...(recordMode === "always"
            ? { onDiscard: (id: number) => discard.mutate(id), discarding: discard.isPending }
            : {})}
        />
      </section>
    </div>
  );
}

/** What privacy mode hides: the brief restates research and the offer. */
function PrivacyHidden() {
  return <div className="text-[12px] text-ink-faint">Hidden while privacy mode is on.</div>;
}

/**
 * The prospect's calls, newest first, with who placed each one. A failed
 * read with nothing cached says so with Retry; "No calls logged yet." only
 * after a read that found none. Notes and transcripts are about the person:
 * hidden in privacy mode. With `onDiscard`, a recorded call can still have
 * its recording deleted after it was logged.
 */
export function CallHistory({
  calls,
  isLoading,
  error,
  onRetry,
  masked,
  me,
  onDiscard,
  discarding = false,
}: {
  calls: CallRecordView[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  masked: boolean;
  /** The signed-in member, so their own calls read "you"; undefined before /api/me answers. */
  me?: CurrentMember | null;
  onDiscard?: (callId: number) => void;
  discarding?: boolean;
}) {
  const mask = useMask();
  if (calls && calls.length > 0)
    return (
      <ul className="flex flex-col gap-1.5 text-[12px] text-ink-cream-2">
        {calls.map((c) => {
          const who = callerLabel(c.member ?? null, me);
          const hasTranscript = c.transcriptStatus === "ready" && (c.transcript?.length ?? 0) > 0;
          return (
            <li key={c.id}>
              <span className="font-mono text-[11px] text-ink-muted">{timeAgo(c.startedAt)}</span>{" "}
              {c.outcome == null && c.provider === "twilio"
                ? "Not logged yet"
                : outcomeTitle(c.outcome)}
              {c.durationSec != null && (
                <span className="text-ink-muted"> · {formatDuration(c.durationSec)}</span>
              )}
              <span className="text-ink-muted">
                {" "}
                · by {who === c.member ? mask("email", who) : who}
              </span>
              {c.note && !masked && <span className="text-ink-muted"> · {c.note}</span>}
              {hasTranscript &&
                (masked ? (
                  <span className="text-ink-faint"> · transcript hidden</span>
                ) : (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11.5px] text-ink-muted">
                      Transcript
                    </summary>
                    <TranscriptView transcript={c.transcript!} className="mt-2" />
                  </details>
                ))}
              {onDiscard && c.provider === "twilio" && c.transcriptStatus !== "none" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={discarding}
                  onClick={() => onDiscard(c.id)}
                  title="They didn't agree to recording: delete the recording and transcript"
                  {...readOnly}
                >
                  Delete recording
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    );
  if (!calls && error)
    return (
      <div className="flex items-center gap-2 font-mono text-[12px] text-[color:var(--ink-blocked-2)]">
        couldn't load the calls · {error.message}
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  return (
    <div className="text-[12px] text-ink-faint">
      {calls ? "No calls logged yet." : isLoading ? "…" : ""}
    </div>
  );
}

/**
 * Call, as the member can place it: a tel: link, or with their phone
 * verified, the button that rings it and then the prospect (the panel only:
 * it needs `onRing`). Outside their call window it is replaced by the hint.
 */
export function CallControl({
  row,
  dialMode,
  window: callWindow,
  now,
  onStart,
  onRefresh,
  onRing,
  ringing = false,
  className,
}: {
  row: Pick<CallListRow, "phone" | "local">;
  dialMode: CallListResponse["dialMode"];
  window: CallListResponse["window"];
  now: Date;
  onStart: (phone: string | null) => void;
  onRefresh: () => void;
  /** Bridge mode: ring the member's phone, then this number. */
  onRing?: () => void;
  ringing?: boolean;
  className?: string;
}) {
  if (!row.phone) return null;
  const hint = windowHint(row, callWindow, now);
  if (hint) return <span className="font-mono text-[11px] text-ink-faint">{hint}</span>;
  if (dialMode === "bridge") {
    if (!onRing) return null;
    return (
      <Button
        size="sm"
        variant="receipt"
        disabled={ringing}
        // Checked again on the clock as it is now, as the tel: link is.
        onClick={() => (canDial(row, callWindow, new Date()) ? onRing() : onRefresh())}
        title="Rings your phone, then theirs"
        className={className}
        {...readOnly}
      >
        {ringing ? <Loader2 size={11} className="animate-spin" /> : <Phone size={11} />} Call
      </Button>
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

/**
 * A bridged call as it happens: where it is, a timer once connected, Hang
 * up, and the consent line: in "ask" mode with Record, pressed once they
 * agree; in "always" mode as the call is already recorded. After it ends:
 * the transcript once it lands, and what the call suggests (its outcome and
 * note are already picked in the panel below, for the member to confirm).
 */
export function BridgeCallView({
  call,
  first,
  record,
  connectedSec,
  hangingUp,
  onHangUp,
  pollError,
  masked,
  commitments,
  onRemoveCommitment,
  onRecord,
  recording,
  onDeclineConsent,
  declineDisabled,
}: {
  call: CallRecordView;
  /** The prospect's first name, as the page shows it (masked in privacy mode). */
  first: string;
  record: CallRecordMode;
  connectedSec: number;
  hangingUp: boolean;
  onHangUp: () => void;
  pollError: Error | null;
  masked: boolean;
  /** The suggested promises still kept; Save sends these. */
  commitments: { text: string; index: number }[];
  onRemoveCommitment: (index: number) => void;
  /** "ask" mode: the prospect agreed, record from now. */
  onRecord: () => void;
  recording: boolean;
  /** "always" mode: delete the recording, the prospect refused it. */
  onDeclineConsent: () => void;
  declineDisabled: boolean;
}) {
  const live = isLive(call);
  const s = call.suggestion;
  const recordingNow = live && call.transcriptStatus === "pending";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13.5px] text-ink-cream" aria-live="polite">
          {live && call.status !== "connected" && (
            <Loader2 size={12} className="animate-spin text-ink-muted" />
          )}
          {bridgeStatusLine(call.status, first, call.statusReason)}
          {call.status === "connected" && (
            <span className="font-mono text-[13px] text-ink-cream" aria-label="call time">
              {formatDuration(connectedSec)}
            </span>
          )}
          {call.status === "ended" && call.durationSec != null && (
            <span className="font-mono text-[12px] text-ink-muted">
              {formatDuration(call.durationSec)}
            </span>
          )}
        </div>
        {live && (
          <Button size="sm" variant="danger" disabled={hangingUp} onClick={onHangUp} {...readOnly}>
            {hangingUp ? <Loader2 size={11} className="animate-spin" /> : <PhoneOff size={11} />}{" "}
            Hang up
          </Button>
        )}
      </div>
      {pollError && (
        <div className="font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">
          couldn't read the call · {pollError.message}
        </div>
      )}
      {live && record === "always" && <ConsentLine label="Say this first, the call is recorded" />}
      {call.status === "connected" && record === "ask" && call.transcriptStatus === "none" && (
        <ConsentLine label="Ask first; nothing is recorded until you press Record">
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={recording}
            onClick={onRecord}
            title="Record the rest of the call, both sides"
            {...readOnly}
          >
            {recording && <Loader2 size={11} className="animate-spin" />}
            They agreed — record
          </Button>
        </ConsentLine>
      )}
      {recordingNow && record === "ask" && (
        <div className="font-mono text-[11.5px] text-ink-muted" aria-live="polite">
          ● Recording
        </div>
      )}
      {!live && call.transcriptStatus === "pending" && (
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <Loader2 size={12} className="animate-spin" /> Transcript on its way. You can pick the
          outcome now, or wait for the suggestion.
        </div>
      )}
      {!live && call.transcriptStatus === "failed" && (
        <div className="text-[12px] text-ink-muted">
          The transcript didn't come through. Pick the outcome yourself.
        </div>
      )}
      {!live && s && (
        <div className="text-[12.5px] text-ink-cream-2">
          <span className="text-ink-spend-2">Suggested:</span> {outcomeTitle(s.outcome)}
          {!masked && commitments.length > 0 && (
            <div className="mt-1.5">
              <span className="text-ink-muted">You promised:</span>
              <ul className="mt-1 flex flex-col gap-1">
                {commitments.map((c) => (
                  <li key={c.index} className="flex items-start gap-1.5">
                    <span className="flex-1">{c.text}</span>
                    <button
                      type="button"
                      onClick={() => onRemoveCommitment(c.index)}
                      className="mt-0.5 text-ink-faint hover:text-ink-cream"
                      aria-label={`Remove: ${c.text}`}
                      title="Not a promise: leave it out"
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {masked && commitments.length > 0 && (
            <div className="mt-1.5 text-[12px] text-ink-faint">
              Promises hidden while privacy mode is on; turn it off to check and keep them.
            </div>
          )}
        </div>
      )}
      {!live &&
        call.transcriptStatus === "ready" &&
        call.transcript &&
        (masked ? <PrivacyHidden /> : <TranscriptView transcript={call.transcript} />)}
      {call.status === "ended" && record === "always" && call.transcriptStatus !== "none" && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            disabled={declineDisabled}
            onClick={onDeclineConsent}
            title="Delete the recording and transcript; log the outcome as usual"
            {...readOnly}
          >
            They didn't agree to recording — delete it
          </Button>
        </div>
      )}
    </div>
  );
}

function ConsentLine({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-ink-rule px-3 py-2 text-[12.5px] text-ink-cream-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className="mt-1 font-prose text-[13.5px] text-ink-cream">“{CONSENT_LINE}”</div>
      {children}
    </div>
  );
}

/** Both sides of the call, You and Them, one paragraph per turn. */
export function TranscriptView({
  transcript,
  className,
}: {
  transcript: NonNullable<CallRecordView["transcript"]>;
  className?: string;
}) {
  const turns = transcriptTurns(transcript);
  if (turns.length === 0)
    return <div className="text-[12px] text-ink-faint">Nothing was said on the recording.</div>;
  return (
    <dl
      className={cn(
        "flex max-h-80 flex-col gap-2 overflow-y-auto font-prose text-[13px] leading-[1.55]",
        className,
      )}
    >
      {turns.map((t) => (
        <div key={`${t.speaker}-${t.startSec}`} className="grid grid-cols-[3.25rem_1fr] gap-2">
          <dt
            className={cn(
              "font-mono text-[10.5px] uppercase tracking-[0.1em] leading-[1.9]",
              t.speaker === "founder" ? "text-ink-faint" : "text-ink-cream-2",
            )}
          >
            {speakerLabel(t.speaker)}
          </dt>
          <dd className={t.speaker === "founder" ? "text-ink-muted" : "text-ink-cream"}>
            {t.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** When this call was first seen connected (ms); null until then and after it ends. */
function useConnectedAt(call: Pick<CallRecordView, "id" | "status"> | undefined): number | null {
  const [seen, setSeen] = useState<{ id: number; at: number } | null>(null);
  const connected = call?.status === "connected";
  useEffect(() => {
    if (connected && call && seen?.id !== call.id) setSeen({ id: call.id, at: Date.now() });
  }, [connected, call, seen]);
  return connected && seen?.id === call?.id ? (seen?.at ?? null) : null;
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
