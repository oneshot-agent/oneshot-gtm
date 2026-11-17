import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { Loader2, Phone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { cn, timeAgo } from "../../lib/cn.ts";
import {
  latestPhoneLookup,
  PHONE_LOOKUP_POLL_MS,
  phoneLookupFor,
  phoneLookupState,
  type PhoneLookupView,
} from "../../lib/phoneLookup.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Modal } from "../primitives/Modal.tsx";

const PRICING_URL = "https://docs.oneshotagent.com/pricing";

/** How often the approved list re-counts the rows the bulk lookup would take. */
const PHONE_PREVIEW_POLL_MS = 20_000;

/**
 * The case view's phone line: a "Find phone" button on an approved or sent
 * row with no number, "Looking up…" while the lookup runs (the row is read
 * every few seconds until it ends), then how it ended. The number itself
 * shows with the row's identity once it lands.
 */
export function FindPhone({ row }: { row: QueueRowView }) {
  const qc = useQueryClient();
  // Set on a start this page made, before the list has read the running state.
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const listed = phoneLookupFor(row.payload);
  const started: PhoneLookupView | null = startedAt ? { status: "running", at: startedAt } : null;
  const known = latestPhoneLookup(listed, started);
  // Poll only while what the page knows says the lookup runs.
  const listedState = phoneLookupState({ status: row.status, payload: row.payload, lookup: known });
  const live = useQuery({
    queryKey: ["queue-phone", row.id],
    queryFn: () => api.queueRowDetail(row.id),
    enabled: listedState.kind === "running",
    refetchInterval: PHONE_LOOKUP_POLL_MS,
  });
  const polled = live.data ? phoneLookupFor(live.data.row.payload) : null;
  const lookup = latestPhoneLookup(known, polled);
  const payload = polled && lookup === polled && live.data ? live.data.row.payload : row.payload;
  const state = phoneLookupState({ status: row.status, payload, lookup });

  // When the poll sees the lookup end, the list reads the row again (its number).
  const wasRunning = useRef(false);
  useEffect(() => {
    if (state.kind === "running") wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      void qc.invalidateQueries({ queryKey: ["queue"] });
    }
  }, [state.kind, qc]);

  const find = useMutation({
    mutationFn: () => api.findQueuePhone(row.id),
    // The server's time of the running mark, never this browser's clock: the
    // row's later reads are ordered against it.
    onSuccess: (res) => {
      setStartedAt(res.at);
      void qc.invalidateQueries({ queryKey: ["queue"] });
    },
    onError: (err) => toast.error(`couldn't look up a phone · ${err.message}`),
  });

  if (state.kind === "hidden") return null;
  const line = (text: string, tone: "muted" | "faint" = "muted") => (
    <span className={cn(tone === "muted" ? "text-ink-muted" : "text-ink-faint")}>{text}</span>
  );
  const button = (label: string) => (
    <Button
      variant="ghost"
      size="sm"
      disabled={find.isPending}
      onClick={() => find.mutate()}
      title="Look up this person's direct phone number. A paid lookup; a number is not guaranteed."
      {...readOnly}
    >
      {find.isPending ? <Loader2 size={11} className="animate-spin" /> : <Phone size={11} />}
      {label}
    </Button>
  );
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 text-[12px] leading-5"
      data-testid="find-phone"
    >
      {state.kind === "idle" && button("Find phone")}
      {state.kind === "needs-linkedin" &&
        line("This row needs a LinkedIn URL before a phone lookup", "faint")}
      {state.kind === "running" && (
        <span className="inline-flex items-center gap-1.5 text-ink-muted">
          <Loader2 size={11} className="animate-spin" /> Looking up a phone number…
        </span>
      )}
      {state.kind === "found" && line(`Phone found ${timeAgo(state.at)}`, "faint")}
      {state.kind === "none" && line(`No number found · ${timeAgo(state.at)}`)}
      {state.kind === "retry" && (
        <>
          {line(`${state.label} · ${timeAgo(state.at)}`)}
          {button("Find phone")}
        </>
      )}
    </div>
  );
}

/**
 * The approved list's bulk lookup: "Find phones · N" for the approved rows
 * with a LinkedIn URL and no number, then a confirm before any is bought.
 * Opening the confirm reads the rows afresh and holds them: the lookup buys
 * exactly the rows the confirm counted, never one that became eligible since.
 */
export function FindPhonesButton() {
  const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState<{ ids: number[]; noLinkedin: number } | null>(null);
  // Its own poll: a lookup ending (or turning retryable) changes the count.
  const preview = useQuery({
    queryKey: ["queue", "find-phones"],
    queryFn: api.findQueuePhonesPreview,
    refetchInterval: PHONE_PREVIEW_POLL_MS,
  });
  const eligible = preview.data?.eligible ?? 0;
  const ids = confirmed?.ids ?? [];
  const noLinkedin = confirmed?.noLinkedin ?? 0;
  const open = confirmed != null;
  const close = () => setConfirmed(null);
  const openConfirm = async () => {
    const fresh = await preview.refetch();
    if (!fresh.data) {
      toast.error("couldn't count the rows · try again");
      return;
    }
    setConfirmed({ ids: fresh.data.ids, noLinkedin: fresh.data.skipped.no_linkedin ?? 0 });
  };
  const run = useMutation({
    mutationFn: (rowIds: number[]) => api.findQueuePhones(rowIds),
    onSuccess: (res) => {
      close();
      toast.success(
        `looking up ${res.started} ${res.started === 1 ? "phone" : "phones"} · they appear on each row as they land`,
      );
      void qc.invalidateQueries({ queryKey: ["queue"] });
    },
    onError: (err) => toast.error(`couldn't look up phones · ${err.message}`),
  });
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={eligible === 0}
        onClick={() => void openConfirm()}
        title={
          eligible === 0
            ? "Every approved row has a number, a lookup running, or no LinkedIn URL"
            : `Look up direct phone numbers for ${eligible} approved rows without one`
        }
        {...readOnly}
      >
        <Phone size={12} />
        {preview.data ? `Find phones · ${eligible}` : "Find phones"}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title={`Find phones for ${ids.length} ${ids.length === 1 ? "person" : "people"}?`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={run.isPending || ids.length === 0}
              onClick={() => run.mutate(ids)}
              {...readOnly}
            >
              <Phone size={12} />
              {run.isPending ? "Starting…" : `Find ${ids.length}`}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-cream-2">
          Each is a paid lookup (
          <a
            href={PRICING_URL}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-ink-rule underline-offset-2 hover:text-ink-cream"
          >
            pricing
          </a>
          ), and a number is not guaranteed. Lookups run in the background, a few at a time.
          {noLinkedin > 0 &&
            ` ${noLinkedin} approved ${noLinkedin === 1 ? "row has" : "rows have"} no LinkedIn URL and ${noLinkedin === 1 ? "is" : "are"} skipped.`}
        </p>
      </Modal>
    </>
  );
}
