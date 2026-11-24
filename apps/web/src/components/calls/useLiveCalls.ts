import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import { IS_DEMO } from "../../api/demo.ts";
import { isLive } from "../../lib/bridgeCall.ts";
import { liveCallsPollMs } from "../../lib/liveCall.ts";

/** The live bar's read of `/api/calls/live`, shared by every place that shows a live call. */
export const liveCallsKey = ["calls-live"];

/**
 * The live calls, polled: the bar's read, which also moves the member's own
 * calls on server-side, so it keeps polling in a background tab while one
 * of them is live.
 */
export function useLiveCallsPoll() {
  return useQuery({
    queryKey: liveCallsKey,
    queryFn: api.callsLive,
    retry: false,
    enabled: !IS_DEMO,
    // A hidden tab keeps polling only while one of your own calls is live
    // (that read is what moves it on); otherwise it waits for the tab to
    // come back, which refetches on focus.
    refetchInterval: (q) => {
      const data = q.state.data;
      const ownLive = (data?.calls ?? []).some((c) => c.mine && isLive(c));
      if (!ownLive && typeof document !== "undefined" && document.hidden) return false;
      return liveCallsPollMs(data);
    },
    refetchIntervalInBackground: true,
  });
}

/**
 * The same read without polling of its own: the bar's poll keeps it fresh,
 * and a mutation that changes a call invalidates it.
 */
export function useLiveCalls() {
  return useQuery({
    queryKey: liveCallsKey,
    queryFn: api.callsLive,
    retry: false,
    enabled: !IS_DEMO,
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  }).data;
}

/** Whether one of the member's own calls is connected now: the tab title says so. */
export function useOnMyCall(): boolean {
  return (useLiveCalls()?.calls ?? []).some((c) => c.mine && c.status === "connected");
}

/** The clock, re-read every second while `active`, for a call timer. */
export function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Whether any of these calls is connected, so its timer ticks. */
export function anyConnected(calls: readonly { status?: string }[] | undefined): boolean {
  return (calls ?? []).some((c) => c.status === "connected");
}
