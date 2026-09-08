import { useMemo } from "react";
import { Checkbox } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

export function TelemetrySection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(() => ({ telemetryEnabled: cfg.telemetryEnabled }), [cfg]);
  const s = useConfigSection({
    id: "telemetry",
    server,
    toRequest: (sent) => sent,
    onDirtyChange,
  });
  return (
    <SectionShell {...s.shell} lede="Anonymous command counts only. Never your data.">
      <Checkbox
        label="Send anonymous opt-out telemetry (commands run, no data, no PII — see TELEMETRY.md)"
        checked={s.values.telemetryEnabled}
        onChange={(e) => s.set("telemetryEnabled", e.target.checked)}
      />
    </SectionShell>
  );
}
