import type { SetupRequest } from "@oneshot-gtm/shared-types";
import type { CallsSettingsView } from "../api/client.ts";
import type { SetupStatus } from "../components/setup/types.ts";

/** The Calls section's draft, flattened to primitives (numbers as text). */
export type CallSectionValues = {
  enabled: boolean;
  /** The call step in new email cadences: off, or at a position. */
  stepOn: boolean;
  position: string;
  delayDays: string;
  holdDays: string;
  start: string;
  end: string;
  weekdays: boolean;
};

/** What `POST /api/setup` merges under `calls`. The bridge is not edited here. */
export interface CallsSettingsPatch {
  enabled: boolean;
  cadenceStep: { position: number; delayDays: number; holdDays: number } | null;
  window: { start: string; end: string; weekdays: boolean };
}

export const DEFAULT_CALL_WINDOW = { start: "09:00", end: "17:00", weekdays: true };
export const DEFAULT_CALL_STEP = { position: 3, delayDays: 5, holdDays: 3 };

/**
 * The settings with defaults filled in: the server's resolved `calls` when it
 * reports one, else the raw config (older servers), else everything off.
 */
export function callsSettings(status: Pick<SetupStatus, "calls" | "cfg">): CallsSettingsView {
  const raw = status.calls ?? status.cfg.calls ?? {};
  return {
    enabled: raw.enabled ?? false,
    cadenceStep: raw.cadenceStep ?? null,
    window: { ...DEFAULT_CALL_WINDOW, ...raw.window },
    bridge: raw.bridge ?? null,
  };
}

export function callSectionValues(calls: CallsSettingsView): CallSectionValues {
  const step = calls.cadenceStep;
  return {
    enabled: calls.enabled,
    stepOn: step != null,
    position: String(step?.position ?? DEFAULT_CALL_STEP.position),
    delayDays: String(step?.delayDays ?? DEFAULT_CALL_STEP.delayDays),
    holdDays: String(step?.holdDays ?? DEFAULT_CALL_STEP.holdDays),
    start: calls.window.start,
    end: calls.window.end,
    weekdays: calls.window.weekdays ?? DEFAULT_CALL_WINDOW.weekdays,
  };
}

/** `calls` goes out whole whenever any of its fields changed, read from the latest values. */
export function callSectionRequest(
  values: CallSectionValues,
  sent: Partial<CallSectionValues>,
): SetupRequest & { calls?: CallsSettingsPatch } {
  if (Object.keys(sent).length === 0) return {};
  return {
    calls: {
      enabled: values.enabled,
      cadenceStep: values.stepOn
        ? {
            position: Number(values.position),
            delayDays: Number(values.delayDays),
            holdDays: Number(values.holdDays),
          }
        : null,
      window: { start: values.start, end: values.end, weekdays: values.weekdays },
    },
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function whole(v: string, min: number): string | null {
  return /^\d+$/.test(v.trim()) && Number(v) >= min ? null : `A whole number, ${min} or more.`;
}

export function callSectionErrors(
  values: CallSectionValues,
): Partial<Record<keyof CallSectionValues, string | null>> {
  const step = values.stepOn;
  const misordered = TIME.test(values.start) && TIME.test(values.end) && values.end <= values.start;
  return {
    position: step ? whole(values.position, 2) : null,
    delayDays: step ? whole(values.delayDays, 0) : null,
    holdDays: step ? whole(values.holdDays, 1) : null,
    // The window's order is checked on both ends: errors show only on edited
    // fields, and moving just one end past the other must still block Save.
    start: !TIME.test(values.start) ? "A time like 09:00." : misordered ? "Before the end." : null,
    end: !TIME.test(values.end) ? "A time like 17:00." : misordered ? "After the start." : null,
  };
}
