import { useMemo } from "react";
import { Field, Input } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

/**
 * Slack incoming-webhook URL for reply/bounce/daily-summary notifications
 * (issue #71, see slack-notify.ts). Blank clears it — the feature is off
 * whenever this is unset, the same show-then-set shape as the CLI's
 * `config slack-webhook`. No URL format validation here either, matching
 * that CLI path: any non-blank string is saved as-is.
 */
export function NotificationsSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(() => ({ slackWebhookUrl: cfg.slackWebhookUrl ?? "" }), [cfg]);
  const s = useConfigSection({
    id: "notifications",
    server,
    toRequest: (sent) => sent,
    onDirtyChange,
  });

  return (
    <SectionShell
      {...s.shell}
      lede="POST to a Slack incoming-webhook on reply received, bounce recorded, and the daily send summary."
    >
      <Field
        label="Slack incoming-webhook URL"
        hint="Blank = notifications off. Delivery failures are logged, never retried, and never block the triggering operation."
      >
        <Input
          value={s.values.slackWebhookUrl}
          onChange={(e) => s.set("slackWebhookUrl", e.target.value)}
          placeholder="https://hooks.slack.com/services/T000/B000/XXXX"
          spellCheck={false}
        />
      </Field>
    </SectionShell>
  );
}
