import { useLayoutEffect, useMemo, useRef } from "react";
import type { CallsSettingsView } from "../../api/client.ts";
import { Checkbox, Field, Input } from "../primitives/Field.tsx";
import { YourPhone } from "./YourPhone.tsx";
import {
  callSectionErrors,
  callSectionRequest,
  callSectionValues,
} from "../../lib/callSettings.ts";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

/**
 * The dialler: the Calls page, a call step in new email cadences, the
 * hours to call in, and the signed-in member's own phone, which Call rings
 * first once it is verified.
 */
export function CallsSection({
  calls,
  onDirtyChange,
}: Pick<SectionProps, "onDirtyChange"> & { calls: CallsSettingsView }) {
  const server = useMemo(() => callSectionValues(calls), [calls]);
  // `calls` is one object on the server: build it from the latest values
  // (the hook hands toRequest only the dirty keys).
  const latest = useRef(server);
  const s = useConfigSection({
    id: "calls",
    server,
    toRequest: (sent) => callSectionRequest(latest.current, sent),
    validate: callSectionErrors,
    onDirtyChange,
  });
  useLayoutEffect(() => {
    latest.current = s.values;
  }, [s.values]);
  const v = s.values;

  return (
    <SectionShell
      {...s.shell}
      lede="You call prospects from the dashboard. Off by default; nothing calls on its own."
    >
      <Checkbox
        label="Turn calls on"
        checked={v.enabled}
        onChange={(e) => s.set("enabled", e.target.checked)}
      />
      <Checkbox
        label="Add a call step to new email cadences"
        checked={v.stepOn}
        disabled={!v.enabled}
        onChange={(e) => s.set("stepOn", e.target.checked)}
      />
      {v.stepOn && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field
            label="Step position"
            error={s.errors.position}
            hint="Which touch the call is: 2 = right after the first email."
          >
            <Input
              value={v.position}
              onChange={(e) => s.set("position", e.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field label="Days after the intro" error={s.errors.delayDays}>
            <Input
              value={v.delayDays}
              onChange={(e) => s.set("delayDays", e.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field
            label="Hold days"
            error={s.errors.holdDays}
            hint="An unlogged call is skipped after this, and the emails carry on."
          >
            <Input
              value={v.holdDays}
              onChange={(e) => s.set("holdDays", e.target.value)}
              inputMode="numeric"
            />
          </Field>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Call from" error={s.errors.start} hint="Their local time.">
          <Input type="time" value={v.start} onChange={(e) => s.set("start", e.target.value)} />
        </Field>
        <Field label="Call until" error={s.errors.end}>
          <Input type="time" value={v.end} onChange={(e) => s.set("end", e.target.value)} />
        </Field>
      </div>
      <Checkbox
        label="Weekdays only"
        checked={v.weekdays}
        onChange={(e) => s.set("weekdays", e.target.checked)}
      />
      <YourPhone />
    </SectionShell>
  );
}
