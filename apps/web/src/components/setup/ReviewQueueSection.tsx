import { useMemo } from "react";
import { Checkbox, Field, Input, Select } from "../primitives/Field.tsx";
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
 * The /queue default order, the install's time zone for event-relative
 * plays (Luma slots, "tomorrow morning"), and whether approving a row looks
 * up its phone number.
 */
export function ReviewQueueSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(
    () => ({
      queueReviewOrder: cfg.queueReviewOrder ?? "newest",
      timezone: cfg.timezone ?? "",
      phoneOnApprove: cfg.phoneOnApprove === true,
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
      lede="The default order on /queue, the clock for event-relative copy, and phone lookups on approval."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Review order"
          hint="Ranked = highest priority score first. /queue can override per visit."
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
          hint={`IANA name. Used when an event has no zone and its city can't be placed. Blank = ${RUNTIME_ZONE}.`}
        >
          <Input
            value={s.values.timezone}
            onChange={(e) => s.set("timezone", e.target.value)}
            placeholder={RUNTIME_ZONE}
            spellCheck={false}
          />
        </Field>
        <div className="md:col-span-2">
          <Checkbox
            checked={s.values.phoneOnApprove}
            onChange={(e) => s.set("phoneOnApprove", e.target.checked)}
            label="Look up a phone number for each row I approve"
          />
          <p className="m-0 mt-1 text-[12px] leading-5 text-ink-muted">
            Each lookup is a paid call (see{" "}
            <a
              href="https://docs.oneshotagent.com/pricing"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-ink-rule underline-offset-2 hover:text-ink-cream"
            >
              pricing
            </a>
            ) and a number is not guaranteed. Rows need a LinkedIn URL.
          </p>
        </div>
      </div>
    </SectionShell>
  );
}
