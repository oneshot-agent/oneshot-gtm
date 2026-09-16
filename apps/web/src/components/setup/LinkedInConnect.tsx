import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.ts";
import { doneFailureCopy, linkedinView, type LinkedInCfg } from "../../lib/linkedinConnect.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";

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
      try {
        tab.current = window.open("", "_blank");
      } catch {
        tab.current = null;
      }
    },
    onSuccess: (r) => {
      if (!r.liveUrl) {
        tab.current?.close();
        setError(`The platform opened no sign-in browser (status ${r.status}). Try again.`);
        return;
      }
      setLiveUrl(r.liveUrl);
      if (tab.current) tab.current.location.href = r.liveUrl;
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
                className="inline-flex items-center gap-1 text-[12px] text-ink-muted underline underline-offset-2"
              >
                open the sign-in tab <ExternalLink size={11} />
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
