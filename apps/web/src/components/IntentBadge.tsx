import { replyIntentMeta } from "@oneshot-gtm/shared-types";
import { Badge } from "./primitives/Badge.tsx";

const TONE = { positive: "receipt", negative: "blocked", neutral: "neutral" } as const;

/**
 * A reply's intent label, from the shared REPLY_INTENTS table: its title, a
 * tone by polarity, and a "check label" marker when the classifier's
 * confidence was under the workspace threshold. An unknown label renders as
 * its raw string, neutral.
 */
export function IntentBadge(props: {
  intent: string | null | undefined;
  review?: boolean;
  confidence?: number | null;
}) {
  if (!props.intent) return null;
  const meta = replyIntentMeta(props.intent);
  const conf =
    typeof props.confidence === "number" ? ` (confidence ${props.confidence.toFixed(2)})` : "";
  return (
    <>
      <Badge
        tone={meta ? TONE[meta.polarity] : "neutral"}
        title={meta ? `${meta.description}${conf}` : props.intent}
      >
        {meta?.title ?? props.intent}
      </Badge>
      {props.review && (
        <Badge tone="spend" title={`Low-confidence label${conf}: check it before acting.`}>
          check label
        </Badge>
      )}
    </>
  );
}
