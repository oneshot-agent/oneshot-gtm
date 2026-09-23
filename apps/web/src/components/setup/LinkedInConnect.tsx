import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { Button } from "../primitives/Button.tsx";

/**
 * The tab that will hold the hosted sign-in, opened during the click and
 * given a waiting page while the platform boots the browser. Same-origin
 * `about:blank`, so writing into it is allowed; the later navigation to the
 * live URL replaces it.
 */
function openWaitingTab(): Window | null {
  try {
    const w = window.open("", "_blank");
    if (!w) return null;
    w.document.write(
      "<!doctype html><title>Opening LinkedIn sign-in…</title>" +
        '<body style="font:15px/1.5 system-ui,sans-serif;color:#1c2128;background:#f5f6f3;margin:0;display:grid;place-items:center;height:100vh">' +
        '<div style="max-width:32rem;padding:24px"><p><strong>Opening the LinkedIn sign-in…</strong></p>' +
        "<p>The hosted browser takes up to a minute to start. Keep this tab open; it will show LinkedIn's login page when it is ready.</p>" +
        "<p>If nothing appears after a minute, go back to the setup page and use <em>Open the sign-in tab</em>.</p></div></body>",
    );
    w.document.close();
    return w;
  } catch {
    return null;
  }
}

/** Reuse the tab we hold when it is still open; otherwise open a fresh one. */
function navigateTab(tab: { current: Window | null }, url: string): void {
  if (tab.current && !tab.current.closed) {
    tab.current.location.href = url;
    tab.current.focus();
  } else {
    // The waiting tab was closed (or never opened): try once more, and the
    // "Open the sign-in tab" button is the fallback.
    tab.current = window.open(url, "_blank");
  }
}

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
 * One LinkedIn card for two connections. One primary action at a time:
 *
 *   nothing connected  → [Connect LinkedIn]  messaging sign-in, then the profile session
 *   messaging step     → waiting line · open the tab again · cancel   (OneShot confirms by itself)
 *   profile step       → [Done — I've signed in] · open the tab again · cancel
 *   both connected     → ✓ Messaging · ✓ Profile reads · reconnect
 *
 * The messaging sign-in is a platform intent polled until it completes;
 * the profile session is the two-step hosted login (start, then finish
 * once the founder has signed in), kept on a PENDING profile until its feed
 * verifies, so a Done click before the sign-in completed changes nothing.
 * Accounts that need a reconnect or a permission are managed on Replies.
 * The cookie paste lives behind "advanced".
 */
export function LinkedInConnect({
  cfg,
  cookieSet,
  advancedOpen,
  onToggleAdvanced,
}: {
  cfg: LinkedInCfg;
  cookieSet: boolean;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
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

  // A page that reloaded mid-profile-login: ask the server where it stands.
  const resume = useQuery({
    queryKey: ["linkedin-login-state"],
    queryFn: api.linkedinLoginState,
    enabled: Boolean(cfg.linkedinPendingProfileId) && !liveUrl,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (resume.data?.pending && resume.data.liveUrl) setLiveUrl(resume.data.liveUrl);
  }, [resume.data]);

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
      if (!r.liveUrl) {
        dropTab();
        setStep(null);
        setError(`The platform opened no sign-in browser (status ${r.status}). Try again.`);
        return;
      }
      setLiveUrl(r.liveUrl);
      setStep("research");
      navigateTab(tab, r.liveUrl);
      refresh();
    },
    onError: (err: Error) => {
      dropTab();
      setStep(null);
      setError(err.message);
    },
  });
  const done = useMutation({
    mutationFn: api.finishLinkedInLogin,
    onMutate: () => setError(null),
    onSuccess: (r) => {
      if (r.loggedIn) {
        setLiveUrl(null);
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
      setLiveUrl(null);
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
    accounts: accounts.data ?? [],
    step,
    liveUrl,
  });
  const researchMissing = view.connectRuns.includes("research");

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
      if (researchMissing) {
        start.mutate();
      } else {
        setStep(null);
        dropTab();
      }
    } else {
      setStep(null);
      dropTab();
      setError(connectionFailureCopy(status, connection.data?.failure_reason));
    }
    // start/qc are stable; researchMissing is read at the moment the intent settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.data, intentId]);

  const cancelMessaging = () => {
    clearIntent();
    setIntentId(null);
    setConnectUrl(null);
    setStep(null);
    setError(null);
    dropTab();
  };

  const busy =
    start.isPending ||
    done.isPending ||
    cancel.isPending ||
    cookie.isPending ||
    messaging.isPending;
  const openUrl = step === "messaging" ? connectUrl : liveUrl;

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
        {view.research.phase === "connected" && step === null && (
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
            {done.isPending ? "checking… ~1 min" : "Done — I've signed in"}
          </Button>
        )}
        {(view.primary === "done" || step === "messaging") && (
          <>
            {openUrl && (
              <a
                href={openUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded border border-ink-rule/60 px-2 py-1 text-[12px] text-ink-cream-2 underline-offset-2 hover:underline"
              >
                Open the sign-in tab <ExternalLink size={11} />
              </a>
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
          {view.waiting}
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
