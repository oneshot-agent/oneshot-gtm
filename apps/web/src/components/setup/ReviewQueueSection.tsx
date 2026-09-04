import { useMemo } from "react";
import { Field, Input, Select } from "../primitives/Field.tsx";
import { validateTimeZone } from "../../lib/setupValidation.ts";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

const RUNTIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
})();

/**
 * Two config keys that existed with no UI and no CLI (issue #451): the
 * /queue default order, and the install's time zone for event-relative
 * plays (Luma slots, "tomorrow morning").
 */
export function ReviewQueueSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(
    () => ({
      queueReviewOrder: cfg.queueReviewOrder ?? "newest",
      timezone: cfg.timezone ?? "",
    }),
    [cfg],
  );
  const s = useConfigSection({
    id: "review",
    server,
    // "" reaches the server as timezone: "" → cleared (runtime zone).
    toRequest: (sent) => sent,
    validate: (v) => ({ timezone: validateTimeZone(v.timezone) }),
    onDirtyChange,
  });

  return (
    <SectionShell
      {...s.shell}
      lede="How /queue orders what you review, and which clock event-relative copy uses."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Review order"
          hint="ranked: highest priority score first, so the drafts most worth a look surface before the rest. newest: arrival order. /queue can override per visit; this is the default."
        >
          <Select
            value={s.values.queueReviewOrder}
            onChange={(e) => s.set("queueReviewOrder", e.target.value as "ranked" | "newest")}
          >
            <option value="newest">newest first (default)</option>
            <option value="ranked">ranked by priority score</option>
          </Select>
        </Field>
        <Field
          label="Time zone"
          error={s.errors.timezone}
          hint={`IANA name, e.g. Europe/Vienna. Last resort when an event has no explicit zone and its city can't be placed. Blank = this machine's zone (${RUNTIME_ZONE}).`}
        >
          <Input
            value={s.values.timezone}
            onChange={(e) => s.set("timezone", e.target.value)}
            placeholder={RUNTIME_ZONE}
            spellCheck={false}
          />
        </Field>
      </div>
    </SectionShell>
  );
}
