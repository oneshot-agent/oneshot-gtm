import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LinkedInReadsView } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { IS_DEMO } from "../../api/demo.ts";
import {
  clearIntent,
  connectionFailureCopy,
  linkedinCardView,
  readIntent,
  writeIntent,
  type CardStep,
} from "../../lib/linkedinCard.ts";
import { doneFailureCopy, type LinkedInCfg } from "../../lib/linkedinConnect.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { InviteQuotaLine } from "../InviteQuotaLine.tsx";
import { LinkedInTouchedImport } from "./LinkedInTouchedImport.tsx";
import { Button } from "../primitives/Button.tsx";

/**
 * The tab that will hold the hosted sign-in, opened during the click and
 * given a waiting page while the platform boots the browser. Same-origin
 * `about:blank`, so writing into it is allowed; the later navigation to the
 * sign-in link replaces it.
 */
function openWaitingTab(): Window | null {
  try {
    const w = window.open("", "_blank");
    if (!w) return null;
    w.document.write(
      "<!doctype html><title>Opening LinkedIn sign-in…</title>" +
        '<body style="font:15px/1.5 system-ui,sans-serif;color:#1c2128;background:#f5f6f3;margin:0;display:grid;place-items:center;height:100vh">' +
        '<div style="max-width:32rem;padding:24px"><p><strong>Opening the LinkedIn sign-in…</strong></p>' +
        "<p>The hosted browser takes up to a minute to start. Keep this tab open; it will show the sign-in page when it is ready. Sign in there, then press Done on that page.</p>" +
        "<p>If nothing appears after a minute, go back to the setup page and use <em>New sign-in link</em>.</p></div></body>",
    );
    w.document.close();
    return w;
  } catch {
    return null;
  }
}

/**
 * Reuse the tab we hold when it is still open; otherwise open a fresh one.
 * False when no tab took the URL (a popup blocker), so the caller can offer
 * it as a link instead.
 */
function navigateTab(tab: { current: Window | null }, url: string): boolean {
  if (tab.current && !tab.current.closed) {
    tab.current.location.href = url;
    tab.current.focus();
    return true;
  }
  // The waiting tab was closed (or never opened): try once more, and the
  // "Open the sign-in tab" link is the fallback.
  tab.current = window.open(url, "_blank");
  return Boolean(tab.current);
}

/** A setup state that ended the login before Done was pressed. */
const SETUP_ENDED_RX = /fail|error|expired|closed|cancel|stopped|no_setup/i;
/** How often the card asks whether Done was pressed on the sign-in page. */
const DONE_POLL_MS = 5000;

function StatusLine({
  label,
  ok,
  text,
  children,
}: {
  label: string;
  ok: boolean;
  text: string;
  children?: ReactNode;
}) {
  return (
    <p className="flex items-center gap-2 text-[12px] text-ink-cream-2">
      {ok ? (
        <Check size={13} className="text-[color:var(--ink-signal)]" aria-hidden="true" />
      ) : (
        <span className="inline-block w-[13px]" aria-hidden="true" />
      )}
      <span className="text-ink-muted">{label}</span>
      <span className={ok ? "" : "text-ink-muted"}>{text}</span>
      {children}
    </p>
  );
}

/**
 * One LinkedIn card for two connections. When the messaging account reads
 * profiles too (`reads.via === "account"`), it is one connection: the
 * Profile reads line is the day's counter, and nothing here opens the
 * browser session. Otherwise, one primary action at a time:
 *
 *   nothing connected  → [Connect LinkedIn]  messaging sign-in, then the profile session
 *   messaging step     → waiting line · open the tab again · cancel   (OneShot confirms by itself)
 *   profile step       → waiting line · [Check sign-in] · new sign-in link · cancel
 *   both connected     → ✓ Messaging · ✓ Profile reads · reconnect
 *
 * The messaging sign-in is a platform intent polled until it completes;
 * the profile session is the hosted login behind a single-use link: the
 * founder signs in and presses Done on that page, the card polls the login
 * state until `completedAt` is set, then finish verifies. The login stays on
 * a PENDING profile until its feed verifies, so a check before the sign-in
 * completed changes nothing. A used or expired link is never shown again:
 * "new sign-in link" mints a fresh one (the earlier one stops working).
 * Accounts that need a reconnect or a permission are managed on Replies.
 * The cookie paste lives behind "advanced".
 */
export function LinkedInConnect({
  cfg,
  cookieSet,
  reads,
  advancedOpen,
  onToggleAdvanced,
}: {
  cfg: LinkedInCfg;
  cookieSet: boolean;
  /** What live reads go through, from `/setup`; null from an older server. */
  reads: LinkedInReadsView | null;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
}) {
  const viaAccount = reads?.via === "account";
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  // The minted link no tab took (a popup blocker): offered once as a link.
  const [unopenedUrl, setUnopenedUrl] = useState<string | null>(null);
  // The `completedAt` a finish already ran for, so the poll starts one per Done.
  const finishedFor = useRef<string | null>(null);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(() => readIntent());
  const [step, setStep] = useState<CardStep>(() => (readIntent() ? "messaging" : null));
  // The tab we opened inside the click gesture (popup blockers allow that);
  // navigated to each hosted sign-in as the platform hands the URLs back.
  const tab = useRef<Window | null>(null);

  // Messaging accounts, the same query Replies reads, so the cache is shared.
  const accounts = useQuery({
    queryKey: ["replies"],
    queryFn: api.replies,
    enabled: !IS_DEMO,
    select: (r) => r.accounts,
  });

  // A profile login in progress (started here, or before a reload): poll its
  // state until the founder pressed Done on the sign-in page.
  const loginState = useQuery({
    queryKey: ["linkedin-login-state"],
    queryFn: api.linkedinLoginState,
    enabled:
      (Boolean(cfg.linkedinPendingProfileId) || step === "research") && !viaAccount && !IS_DEMO,
    refetchInterval: DONE_POLL_MS,
  });
  const pendingState = loginState.data?.pending ? loginState.data : null;
  const setupEnded = Boolean(
    pendingState && !pendingState.completedAt && SETUP_ENDED_RX.test(pendingState.status),
  );

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["setup"] });
    void qc.invalidateQueries({ queryKey: ["doctor"] });
    void qc.invalidateQueries({ queryKey: ["linkedin-login-state"] });
    void qc.invalidateQueries({ queryKey: ["replies"] });
  };

  const dropTab = () => {
    tab.current?.close();
    tab.current = null;
  };

  const start = useMutation({
    mutationFn: api.startLinkedInLogin,
    onMutate: () => {
      setError(null);
      // Opened inside the click so popup blockers allow it; the platform
      // takes up to a minute to hand back the sign-in URL, so the tab says
      // so instead of sitting blank. When the messaging step just finished
      // we still hold its tab and reuse it.
      if (!tab.current || tab.current.closed) tab.current = openWaitingTab();
    },
    onSuccess: (r) => {
      if (!r.setupUrl) {
        dropTab();
        setStep(null);
        setError(`The platform opened no sign-in browser (status ${r.status}). Try again.`);
        return;
      }
      setSetupUrl(r.setupUrl);
      setStep("research");
      setUnopenedUrl(navigateTab(tab, r.setupUrl) ? null : r.setupUrl);
      refresh();
    },
    onError: (err: Error) => {
      dropTab();
      setStep(null);
      setError(err.message);
    },
  });
  // The link opens once: a used, expired or lost one is replaced, never re-shown.
  const newLink = useMutation({
    mutationFn: api.newLinkedInLoginLink,
    onMutate: () => {
      setError(null);
      if (!tab.current || tab.current.closed) tab.current = openWaitingTab();
    },
    onSuccess: (r) => {
      setSetupUrl(r.setupUrl);
      setStep("research");
      setUnopenedUrl(navigateTab(tab, r.setupUrl) ? null : r.setupUrl);
      refresh();
    },
    onError: (err: Error) => {
      dropTab();
      setError(err.message);
    },
  });
  const done = useMutation({
    mutationFn: api.finishLinkedInLogin,
    onMutate: () => setError(null),
    onSuccess: (r) => {
      if (r.loggedIn) {
        setSetupUrl(null);
        setUnopenedUrl(null);
        setStep(null);
        tab.current = null;
      } else {
        setError(doneFailureCopy(r.reason));
      }
      refresh();
    },
    onError: (err: Error) => setError(err.message),
  });
  const cancel = useMutation({
    mutationFn: api.cancelLinkedInLogin,
    onSuccess: () => {
      setSetupUrl(null);
      setUnopenedUrl(null);
      setStep(null);
      setError(null);
      dropTab();
      refresh();
    },
    onError: (err: Error) => setError(err.message),
  });
  const cookie = useMutation({
    mutationFn: api.connectLinkedInSession,
    onMutate: () => setError(null),
    onSuccess: (r) => {
      if (!r.loggedIn) setError(doneFailureCopy(r.reason));
      refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Messaging: the platform issues a hosted sign-in and an intent to poll.
  const messaging = useMutation({
    mutationFn: () => api.linkedinAction({ action: "connect" }),
    onMutate: () => {
      setError(null);
      tab.current = openWaitingTab();
    },
    onSuccess: (r) => {
      if (!r.url || !r.intent_id) {
        dropTab();
        setError("The platform returned no LinkedIn sign-in link. Try again.");
        return;
      }
      setConnectUrl(r.url);
      navigateTab(tab, r.url);
      writeIntent(r.intent_id);
      setIntentId(r.intent_id);
      setStep("messaging");
    },
    onError: (err: Error) => {
      dropTab();
      setError(err.message);
    },
  });
  const connection = useQuery({
    queryKey: ["linkedin-connection", intentId],
    queryFn: () => api.linkedinAction({ action: "connection", intentId: intentId! }),
    enabled: Boolean(intentId) && !IS_DEMO,
    refetchInterval: 5000,
  });

  const view = linkedinCardView({
    cfg,
    cookieSet,
    // Demo has no accounts by construction; otherwise an unloaded list is
    // unknown, so Connect never adds a second account behind a spinner.
    accounts: IS_DEMO ? [] : accounts.isSuccess ? accounts.data : null,
    accountsError: accounts.error?.message ?? null,
    step,
    setupUrl,
    reads,
  });
  const researchMissing = view.connectRuns.includes("research");
  // Bumped by each settled connect and by cancel, so a setup check that
  // resolves after a cancel cannot open the profile sign-in.
  const connectAttempt = useRef(0);
  useEffect(
    () => () => {
      connectAttempt.current++;
    },
    [],
  );

  // The intent reached a terminal state: either carry on to the profile
  // session in the same tab, or say why it did not connect.
  useEffect(() => {
    const status = connection.data?.status;
    if (!intentId || !status || status === "pending" || status === "verifying") return;
    clearIntent();
    setIntentId(null);
    setConnectUrl(null);
    if (status === "completed") {
      void qc.invalidateQueries({ queryKey: ["replies"] });
      // The account just connected may itself read profiles: ask the server
      // again (a new request, not one already in flight from before the
      // connect) before opening the browser sign-in the stale view asked for.
      const attempt = ++connectAttempt.current;
      void qc
        .cancelQueries({ queryKey: ["setup"] })
        .then(() => qc.fetchQuery({ queryKey: ["setup"], queryFn: api.setupStatus, staleTime: 0 }))
        .then((fresh) => fresh.linkedinReads?.via !== "account")
        .catch(() => true)
        .then((stillMissing) => {
          // Cancelled (or another attempt began) while the check ran.
          if (attempt !== connectAttempt.current) return;
          if (researchMissing && stillMissing) {
            start.mutate();
          } else {
            setStep(null);
            dropTab();
          }
        });
    } else {
      setStep(null);
      dropTab();
      setError(connectionFailureCopy(status, connection.data?.failure_reason));
    }
    // start/qc are stable; researchMissing is read at the moment the intent settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.data, intentId]);

  const cancelMessaging = () => {
    connectAttempt.current++;
    clearIntent();
    setIntentId(null);
    setConnectUrl(null);
    setStep(null);
    setError(null);
    dropTab();
  };

  // Done pressed on the sign-in page: verify once per Done, unless a check
  // is already running or one already ran for it (the server remembers, so a
  // reload or a second tab never repeats a paid check).
  const completedAt = pendingState?.completedAt ?? null;
  const checked = pendingState?.checked === true;
  useEffect(() => {
    if (!completedAt || checked || finishedFor.current === completedAt || done.isPending) return;
    finishedFor.current = completedAt;
    done.mutate();
    // done is stable; only a new Done starts a check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedAt, checked]);

  const busy =
    start.isPending ||
    newLink.isPending ||
    done.isPending ||
    cancel.isPending ||
    cookie.isPending ||
    messaging.isPending;
  const openUrl = step === "messaging" ? connectUrl : unopenedUrl;

  return (
    <div className="clear-both flex flex-col gap-2">
      <StatusLine label="Messaging" ok={view.messaging.ok} text={view.messaging.text}>
        {view.messaging.state === "attention" && (
          <Link to="/inbox" className="text-[12px] text-ink-faint underline underline-offset-2">
            manage in Replies
          </Link>
        )}
      </StatusLine>
      <StatusLine label="Profile reads" ok={view.research.ok} text={view.research.text}>
        {view.research.phase === "connected" && !view.research.viaAccount && step === null && (
          <button
            type="button"
            className="text-[12px] text-ink-faint underline underline-offset-2"
            disabled={busy}
            onClick={() => start.mutate()}
          >
            reconnect
          </button>
        )}
      </StatusLine>
      <InviteQuotaLine className="text-[12px] text-ink-muted" />
      <LinkedInTouchedImport />
      <div className="flex flex-wrap items-center gap-2">
        {view.primary === "connect" && (
          <Button
            type="button"
            variant="receipt"
            size="sm"
            disabled={busy}
            onClick={() =>
              view.connectRuns[0] === "messaging" ? messaging.mutate() : start.mutate()
            }
            {...readOnly}
          >
            {messaging.isPending || start.isPending
              ? "opening the sign-in tab…"
              : "Connect LinkedIn"}
          </Button>
        )}
        {view.primary === "done" && (
          <Button
            type="button"
            variant="receipt"
            size="sm"
            disabled={busy}
            onClick={() => done.mutate()}
            {...readOnly}
          >
            {done.isPending ? "checking… ~1 min" : "Check sign-in"}
          </Button>
        )}
        {(view.primary === "done" || step === "messaging") && (
          <>
            {openUrl && (
              <a
                href={openUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  if (step !== "messaging") setUnopenedUrl(null);
                }}
                className="inline-flex items-center gap-1 rounded border border-ink-rule/60 px-2 py-1 text-[12px] text-ink-cream-2 underline-offset-2 hover:underline"
              >
                Open the sign-in tab <ExternalLink size={11} />
              </a>
            )}
            {view.primary === "done" && (
              <button
                type="button"
                className="text-[12px] text-ink-faint underline underline-offset-2"
                disabled={busy}
                title="The sign-in link opens once; a new one replaces it and the old page stops working"
                onClick={() => newLink.mutate()}
                {...readOnly}
              >
                {newLink.isPending ? "minting a new link…" : "new sign-in link"}
              </button>
            )}
            <button
              type="button"
              className="text-[12px] text-ink-faint underline underline-offset-2"
              disabled={busy}
              onClick={() => (step === "messaging" ? cancelMessaging() : cancel.mutate())}
            >
              cancel
            </button>
          </>
        )}
        <button
          type="button"
          className="ml-auto text-[11px] text-ink-faint underline underline-offset-2"
          onClick={onToggleAdvanced}
        >
          {advancedOpen ? "hide cookie option" : "advanced: use a cookie"}
        </button>
      </div>
      {view.waiting && (
        <p className="text-[12px] text-ink-muted">
          {setupEnded
            ? "The sign-in page closed before Done was pressed. Get a new sign-in link to try again."
            : view.waiting}
          {step === "messaging" && connection.error ? ` · ${connection.error.message}` : ""}
        </p>
      )}
      {advancedOpen && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!cookieSet || busy}
            title={cookieSet ? undefined : "Save the cookie below first"}
            onClick={() => cookie.mutate()}
            {...readOnly}
          >
            {cookie.isPending ? "checking the cookie… ~1 min" : "Connect with the saved cookie"}
          </Button>
          <span className="text-[11px] text-ink-faint">
            li_at from your browser: dev tools → Application → Cookies → linkedin.com
          </span>
        </div>
      )}
      {error && <p className="text-[12px] text-[color:var(--ink-blocked-2)]">{error}</p>}
    </div>
  );
}
