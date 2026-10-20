import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.ts";
import { cn } from "../../lib/cn.ts";
import {
  liveReadNotice,
  READING_LINKEDIN,
  shouldReadOnOpen,
  type LiveReadNotice,
} from "../../lib/liveRead.ts";
import { usePrivacy } from "../../lib/privacy.tsx";
import { clearRowActivity, rowActivityOf, setRowActivity } from "../../lib/rowActivity.ts";

/**
 * Mounted in an open case: reads the row's LinkedIn profile when it has no
 * live read (lib/liveRead.ts decides which rows), then says what came of it
 * in one line. Once per open: the ref is set on the first effect run, so a
 * re-render, a refetched row or StrictMode's second effect never fires it
 * again; closing the case unmounts it, and the next open fires afresh.
 *
 * While it runs the shared row activity reads "Reading LinkedIn…": the
 * offer block and the letter treat it as busy, and the row's Approve waits
 * on it (it outlives this component when the case closes mid-read).
 */
export function ReadOnOpen({ row }: { row: QueueRowView }) {
  const qc = useQueryClient();
  const { masked } = usePrivacy();
  const [notice, setNotice] = useState<LiveReadNotice | null>(null);
  const refresh = (id: number, redrafted: boolean) => {
    // The list carries the row's payload, offer and draft; the dossier and
    // /prospects detail read the same research.
    void qc.invalidateQueries({ queryKey: ["queue"] });
    void qc.invalidateQueries({ queryKey: ["queue-dossier", id] });
    void qc.invalidateQueries({ queryKey: ["prospects"] });
    if (redrafted) void qc.invalidateQueries({ queryKey: ["queue-drafts", id] });
  };
  const read = useMutation({
    mutationFn: async (id: number) => {
      const token = setRowActivity(id, READING_LINKEDIN);
      try {
        return await api.readQueueProfile(id);
      } finally {
        clearRowActivity(id, token);
      }
    },
    onSuccess: (result, id) => {
      setNotice(liveReadNotice(result));
      refresh(id, result.redrafted);
    },
    onError: (err, id) => {
      setNotice({ tone: "muted", text: `LinkedIn not read: ${err.message}` });
      refresh(id, false);
    },
  });

  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    // A read still running from the last open settles on its own.
    if (rowActivityOf(row.id) === READING_LINKEDIN) return;
    if (shouldReadOnOpen(row)) read.mutate(row.id);
    // Only the open fires it: the row is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!notice) return null;
  return (
    <p
      role="status"
      className={cn(
        "m-0 text-[12px] leading-5",
        notice.tone === "blocked" ? "text-[color:var(--ink-blocked-2)]" : "text-ink-muted",
      )}
    >
      {/* A reject reason can name the person or the company. */}
      {masked && notice.tone === "blocked" ? "Rejected after the LinkedIn read." : notice.text}
    </p>
  );
}
