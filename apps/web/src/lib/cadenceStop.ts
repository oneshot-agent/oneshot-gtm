import type { CadenceStopReason, CadenceView } from "@oneshot-gtm/shared-types";

export type CadenceStopTarget = Pick<CadenceView, "prospectId" | "prospectName" | "playName">;
export type CadenceStopInput = { reason: CadenceStopReason; note?: string };
export type CadenceStopFailure = { target: CadenceStopTarget; message: string };

/** A prospect can be enrolled in several plays; each is a separate stop. */
export const cadenceKey = (c: Pick<CadenceView, "prospectId" | "playName">): string =>
  `${c.prospectId}|${c.playName}`;

export function cadenceSelection(rows: readonly CadenceView[], selected: ReadonlySet<string>) {
  const selectable = rows.filter((c) => c.status === "active" && !c.isSending);
  const chosen = rows.filter((c) => c.status === "active" && selected.has(cadenceKey(c)));
  const stoppable = chosen.filter((c) => !c.isSending);
  const previewable = stoppable.filter(
    (c) => c.nextStepChannel !== "direct_mail" && c.nextStepLabel != null,
  );
  const sendable = previewable.filter(
    (c) => c.nextStepDraft != null && c.nextStepDraft.flags.length === 0,
  );
  return { selectable, chosen, stoppable, previewable, sendable };
}

/** Reuse the single-stop endpoint's validation, retaining individual failures for retry. */
export async function stopCadences(
  targets: readonly CadenceStopTarget[],
  input: CadenceStopInput,
  stopOne: (id: number, play: string, input: CadenceStopInput) => Promise<{ stopped: number }>,
) {
  const stopped: CadenceStopTarget[] = [];
  const failed: CadenceStopFailure[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = cadenceKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const result = await stopOne(target.prospectId, target.playName, input);
      if (result.stopped !== 1) throw new Error("Cadence was not stopped. Refresh and retry.");
      stopped.push(target);
    } catch (error) {
      failed.push({
        target,
        message: error instanceof Error ? error.message : "Could not stop cadence.",
      });
    }
  }
  return { stopped, failed };
}
