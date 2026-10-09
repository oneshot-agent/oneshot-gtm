import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import type { DecisionReason } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import {
  appendReason,
  decisionReasonEffect,
  decisionReasonForText,
  mergeRejectSuggestion,
  REJECT_DECISION_REASONS,
  REJECT_DETAIL_CHIPS,
  type RejectReasonSource,
} from "../../lib/rejectReason.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Textarea } from "../primitives/Field.tsx";

export interface RejectReasonValue {
  /** The note kept on the prospect's timeline. */
  reason: string;
  /** The structured why; "" when none is picked. */
  decisionReason: DecisionReason | "";
}

/** How long a typed hint sits before the model is asked which category it is. */
const HINT_PAUSE_MS = 700;
/** Fewer characters than this is a keystroke, not a hint. */
const MIN_HINT_CHARS = 3;

/**
 * The reject box's one question: why. Answered by tapping a category; the
 * note below is optional detail. The model does the writing: it suggests the
 * category and the note when the box opens, rewrites the note when the founder
 * picks a different category, and names the category for a few typed words the
 * keyword match can't place. The founder's own input always wins
 * (`mergeRejectSuggestion`), and the category on screen is the one saved.
 *
 * Mount it per row (`key`) so each row starts clean.
 */
export function RejectReasonFields({
  rowId,
  value,
  onChange,
  source = null,
  privacy = false,
  disabled = false,
}: {
  /** The single row being rejected; null for a bulk reject (no model calls). */
  rowId: number | null;
  value: RejectReasonValue;
  onChange: (patch: Partial<RejectReasonValue>) => void;
  /** Where the note the box opened with came from, for the caption. */
  source?: RejectReasonSource;
  /** Privacy mode: nothing prefilled, the model is never asked. */
  privacy?: boolean;
  disabled?: boolean;
}) {
  const canAsk = rowId != null && !privacy;
  const [drafting, setDrafting] = useState(false);
  const [outcome, setOutcome] = useState<"idle" | "empty" | "error">("idle");
  // What the founder did by hand; a model reply never overrides either.
  const touched = useRef({ note: false, category: false });
  // The latest value, for replies that land after a re-render.
  const latest = useRef(value);
  latest.current = value;
  const requestSeq = useRef(0);

  const ask = useCallback(
    (hint: { hint?: string; decisionReason?: DecisionReason }, opts: { quiet?: boolean } = {}) => {
      if (rowId == null) return;
      const seq = ++requestSeq.current;
      if (!opts.quiet) {
        setDrafting(true);
        setOutcome("idle");
      }
      api
        .suggestRejectReason(rowId, hint)
        .then((reply) => {
          if (seq !== requestSeq.current) return;
          setDrafting(false);
          const patch = mergeRejectSuggestion({
            current: latest.current,
            touched: touched.current,
            reply,
            askedFor: hint.decisionReason ?? null,
          });
          if (Object.keys(patch).length > 0) onChange(patch);
          else if (!opts.quiet && !reply.reason && !latest.current.reason.trim()) {
            setOutcome("empty");
          }
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setDrafting(false);
          if (!opts.quiet) setOutcome("error");
        });
    },
    [rowId, onChange],
  );

  // On open: a box with nothing to show asks the model for both answers; one
  // that opened with a note but no category gets a free keyword match.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (!value.reason.trim()) {
      if (canAsk) ask({});
      return;
    }
    if (!value.decisionReason) {
      const local = decisionReasonForText(value.reason);
      if (local) onChange({ decisionReason: local });
    }
    // Runs once per mount: the row is fixed for this component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A typed hint the keyword match can't place: ask the model for its category
  // after a pause. Quiet, since the founder is mid-sentence.
  useEffect(() => {
    if (!canAsk || !touched.current.note || touched.current.category) return;
    const text = value.reason.trim();
    if (text.length < MIN_HINT_CHARS || value.decisionReason) return;
    const timer = setTimeout(() => ask({ hint: text }, { quiet: true }), HINT_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [canAsk, value.reason, value.decisionReason, ask]);

  const pickCategory = (reason: DecisionReason) => {
    touched.current.category = true;
    if (value.decisionReason === reason) {
      onChange({ decisionReason: "" });
      return;
    }
    onChange({ decisionReason: reason });
    // The note should say why in the founder's chosen terms: have it rewritten,
    // unless they wrote it themselves.
    if (canAsk && !touched.current.note) ask({ decisionReason: reason });
  };

  const typeNote = (text: string) => {
    touched.current.note = true;
    const patch: Partial<RejectReasonValue> = { reason: text };
    // Until they tap a chip, the category follows their words.
    if (!touched.current.category) {
      const local = decisionReasonForText(text);
      if (local) patch.decisionReason = local;
      else if (!text.trim()) patch.decisionReason = "";
    }
    onChange(patch);
  };

  const details = value.decisionReason ? (REJECT_DETAIL_CHIPS[value.decisionReason] ?? []) : [];

  return (
    <div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {drafting ? (
          <div className="mb-3 flex items-start gap-3 rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep p-3">
            <Loader2
              size={18}
              aria-hidden="true"
              className="mt-0.5 shrink-0 animate-spin text-ink-cream-2 motion-reduce:animate-none"
            />
            <div>
              <p className="m-0 text-[13px] font-medium text-ink-cream">Working out why…</p>
              <p className="mt-1 text-[12px] leading-5 text-ink-muted">
                Reading the prospect's evidence. Pick a reason yourself at any time.
              </p>
            </div>
          </div>
        ) : outcome !== "idle" && !value.reason.trim() ? (
          <div className="mb-3 rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep p-3">
            <p className="m-0 text-[13px] text-ink-cream-2">
              {outcome === "error"
                ? "Couldn’t suggest a reason."
                : "Nothing here argues against fit."}
            </p>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">Pick a reason below.</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              disabled={disabled}
              onClick={() =>
                ask(value.decisionReason ? { decisionReason: value.decisionReason } : {})
              }
            >
              <RotateCw size={12} aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : null}
      </div>

      <p className="m-0 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">Why</p>
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Why are you rejecting?">
        {REJECT_DECISION_REASONS.map((r) => (
          <Button
            key={r.value}
            variant={value.decisionReason === r.value ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={value.decisionReason === r.value}
            disabled={disabled}
            onClick={() => pickCategory(r.value)}
          >
            {r.label}
          </Button>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink-muted">{decisionReasonEffect(value.decisionReason)}</p>

      {details.length > 0 && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Add detail"
        >
          {details.map((chip) => (
            <Button
              key={chip}
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                touched.current.note = true;
                onChange({ reason: appendReason(value.reason, chip) });
              }}
            >
              + {chip}
            </Button>
          ))}
        </div>
      )}

      <Field label="Note (optional — kept on the prospect's timeline)" className="mt-3">
        <Textarea
          rows={2}
          value={value.reason}
          disabled={disabled}
          onChange={(e) => typeNote(e.target.value)}
          placeholder={
            drafting ? "writing a note from the row's evidence…" : "a few words is enough"
          }
        />
      </Field>
      {source === "person-gate" && !touched.current.note && (
        <p className="mt-1 text-xs text-ink-muted">
          Prefilled from the ICP gate's verdict — edit freely, or clear it.
        </p>
      )}
      {source === "notes" && !touched.current.note && (
        <p className="mt-1 text-xs text-ink-muted">
          Prefilled from the finder's note — edit freely, or clear it.
        </p>
      )}
      {privacy && <p className="mt-1 text-xs text-ink-faint">Privacy mode — nothing prefilled.</p>}
    </div>
  );
}
