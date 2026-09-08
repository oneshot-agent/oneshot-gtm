import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

/**
 * One section's save cycle: post, refetch what the page reads, then let the
 * section forget the draft keys it just sent — in that order, so an input
 * never flashes the stale server value between "saved" and "refetched".
 *
 * `refetch` keys are awaited; `alsoInvalidate` keys are fire-and-forget (the
 * doctor / home widgets that mirror setup state, same as the old global save).
 */
export function useSectionSave<S>(opts: {
  save: (sent: S) => Promise<void>;
  refetch: QueryKey[];
  alsoInvalidate?: QueryKey[];
  /** Called only when every awaited refetch succeeded. */
  onCommitted: (sent: S) => void;
  /** Success toast; defaults to none (the footer tick is the signal). */
  successMessage?: string;
}) {
  const qc = useQueryClient();
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: async (sent: S): Promise<{ sent: S; refreshed: boolean }> => {
      await opts.save(sent);
      for (const key of opts.refetch) await qc.invalidateQueries({ queryKey: key });
      // invalidateQueries resolves even when the refetch failed; only commit
      // the draft when the data on screen is actually the post-save truth.
      const refreshed = opts.refetch.every((key) => !qc.getQueryState(key)?.error);
      return { sent, refreshed };
    },
    onSuccess: ({ sent, refreshed }) => {
      setSavedAt(Date.now());
      for (const key of opts.alsoInvalidate ?? []) void qc.invalidateQueries({ queryKey: key });
      if (refreshed) {
        opts.onCommitted(sent);
        if (opts.successMessage) toast.success(opts.successMessage);
      } else {
        toast.warning("saved · couldn't refresh — reload to confirm");
      }
    },
    onError: (err: Error) => toast.error(`couldn't save · ${err.message}`),
  });

  return {
    run: (sent: S) => mutation.mutate(sent),
    isPending: mutation.isPending,
    savedAt,
  };
}
