import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.ts";
import { doneFailureCopy, linkedinView, type LinkedInCfg } from "../../lib/linkedinConnect.ts";
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

/**
 * Connect LinkedIn for live profile reads. One primary action at a time:
 *
 *   idle / expired   → [Connect LinkedIn]  opens the hosted sign-in tab
 *   signing in       → [Done]  + "open the tab again" · cancel
 *   connected        → ✓ Connected as … · reconnect
 *
 * The hosted login is a two-step platform flow (start, then finish once the
 * founder has signed in). The server keeps the sign-in on a PENDING profile
 * and promotes it only when its feed verifies, so a Done click before the
 * sign-in completed, or after the tab was closed, changes nothing — the copy
 * just says "not signed in yet". The cookie paste lives behind "advanced".
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
  // The tab we opened inside the click gesture (popup blockers allow that);
  // navigated once the platform hands back the live URL.
  const tab = useRef<Window | null>(null);

  // A page that reloaded mid-login: ask the server where the sign-in stands.
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
  };

  const start = useMutation({
    mutationFn: api.startLinkedInLogin,
    onMutate: () => {
      setError(null);
      // Opened inside the click so popup blockers allow it; the platform
      // takes up to a minute to hand back the sign-in URL, so the tab says
      // so instead of sitting blank (a blank tab reads as broken, and a
      // Done click before the sign-in exists stops the hosted browser).
      tab.current = openWaitingTab();
    },
    onSuccess: (r) => {
      if (!r.liveUrl) {
        tab.current?.close();
        setError(`The platform opened no sign-in browser (status ${r.status}). Try again.`);
        return;
      }
      setLiveUrl(r.liveUrl);
      if (tab.current && !tab.current.closed) {
        tab.current.location.href = r.liveUrl;
        tab.current.focus();
      } else {
        // The waiting tab was closed (or never opened): try once more, and
        // the "Open the sign-in tab" button below is the fallback.
        tab.current = window.open(r.liveUrl, "_blank");
      }
      refresh();
    },
    onError: (err: Error) => {
      tab.current?.close();
      setError(err.message);
    },
  });
  const done = useMutation({
    mutationFn: api.finishLinkedInLogin,
    onMutate: () => setError(null),
    onSuccess: (r) => {
      if (r.loggedIn) {
        setLiveUrl(null);
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
      setError(null);
      tab.current?.close();
      tab.current = null;
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

  const busy = start.isPending || done.isPending || cancel.isPending || cookie.isPending;
  const view = linkedinView(cfg, cookieSet, Boolean(liveUrl));

  return (
    <div className="clear-both flex flex-col gap-2">
      <p className="flex items-center gap-2 text-[12px] text-ink-cream-2">
        {view.phase === "connected" && (
          <Check size={13} className="text-[color:var(--ink-signal)]" aria-hidden="true" />
        )}
        <span className={view.ok ? "" : "text-ink-muted"}>{view.headline}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {view.primary === "connect" && (
          <Button
            type="button"
            variant="receipt"
            size="sm"
            disabled={busy}
            onClick={() => start.mutate()}
            {...readOnly}
          >
            {start.isPending ? "opening the sign-in tab…" : "Connect LinkedIn"}
          </Button>
        )}
        {view.primary === "done" && (
          <>
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
            {liveUrl && (
              <a
                href={liveUrl}
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
              onClick={() => cancel.mutate()}
            >
              cancel
            </button>
          </>
        )}
        {view.phase === "connected" && (
          <button
            type="button"
            className="text-[12px] text-ink-faint underline underline-offset-2"
            disabled={busy}
            onClick={() => start.mutate()}
          >
            reconnect
          </button>
        )}
        <button
          type="button"
          className="ml-auto text-[11px] text-ink-faint underline underline-offset-2"
          onClick={onToggleAdvanced}
        >
          {advancedOpen ? "hide cookie option" : "advanced: use a cookie"}
        </button>
      </div>
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
