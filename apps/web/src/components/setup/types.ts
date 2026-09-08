import { useEffect } from "react";
import type { api } from "../../api/client.ts";
import type { SectionId } from "./constants.ts";

export type SetupStatus = Awaited<ReturnType<typeof api.setupStatus>>;
export type SetupCfg = SetupStatus["cfg"];
export type Sources = SetupStatus["sources"];

/** How a section tells the page (rail dots, leave guard) that it has unsaved edits. */
export type DirtyReporter = (id: SectionId, dirty: boolean) => void;

export interface SectionProps {
  cfg: SetupCfg;
  sources: Sources;
  onDirtyChange: DirtyReporter;
}

/** Report this section's dirty flag upward whenever it changes; clear it on unmount. */
export function useReportDirty(id: SectionId, dirty: boolean, report: DirtyReporter): void {
  useEffect(() => {
    report(id, dirty);
  }, [id, dirty, report]);
  useEffect(() => () => report(id, false), [id, report]);
}
