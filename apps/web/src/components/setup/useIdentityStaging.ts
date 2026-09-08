import { useCallback, useState } from "react";
import type { PendingOneShotAdd, PendingSmartleadAdd } from "../../lib/setupValidation.ts";

/**
 * The Email-transport section's pending operations — cap edits, removals and
 * new senders — held until its Save commits them in ONE request. Unlike the
 * draft overlay these are operations, not field values, so they get their
 * own store; `clear()` runs after the post-save refetch has landed.
 */
export function useIdentityStaging() {
  const [capEdits, setCapEdits] = useState<Record<string, string>>({});
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [pendingAdds, setPendingAdds] = useState<PendingOneShotAdd[]>([]);
  const [pendingSmartleadAdds, setPendingSmartleadAdds] = useState<PendingSmartleadAdd[]>([]);

  const setCap = useCallback((id: string, raw: string) => {
    setCapEdits((m) => ({ ...m, [id]: raw }));
  }, []);
  const remove = useCallback((id: string) => {
    setRemovedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }, []);
  const stageAdd = useCallback((a: PendingOneShotAdd) => {
    setPendingAdds((p) => [...p, a]);
  }, []);
  const unstageAdd = useCallback((a: PendingOneShotAdd) => {
    setPendingAdds((p) => p.filter((x) => x !== a));
  }, []);
  const stageSmartlead = useCallback((a: PendingSmartleadAdd) => {
    setPendingSmartleadAdds((p) => (p.some((x) => x.address === a.address) ? p : [...p, a]));
  }, []);
  const unstageSmartlead = useCallback((address: string) => {
    setPendingSmartleadAdds((p) => p.filter((x) => x.address !== address));
  }, []);
  const clearSmartlead = useCallback(() => setPendingSmartleadAdds([]), []);
  const clear = useCallback(() => {
    setCapEdits({});
    setRemovedIds([]);
    setPendingAdds([]);
    setPendingSmartleadAdds([]);
  }, []);

  return {
    capEdits,
    setCap,
    removedIds,
    remove,
    pendingAdds,
    stageAdd,
    unstageAdd,
    pendingSmartleadAdds,
    stageSmartlead,
    unstageSmartlead,
    clearSmartlead,
    clear,
  };
}
