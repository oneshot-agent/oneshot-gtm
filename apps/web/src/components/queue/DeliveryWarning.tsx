import type { SendDeliveryView } from "@oneshot-gtm/shared-types";
import { Badge } from "../primitives/Badge.tsx";

/**
 * What the sending mailbox's Sent folder held for this send, when it is not
 * exactly one copy: the mail provider retried underneath us (`duplicate`), or
 * no copy turned up in the check window (`not_found`, a possible silent drop).
 * A keyed send went out under one fixed Message-ID and is never resent, so
 * its `not_found` means "accepted, not seen in Sent". Null for a clean check
 * or none at all.
 */
export function deliveryWarningText(d: SendDeliveryView | null | undefined): string | null {
  if (!d) return null;
  if (d.status === "duplicate") return `Delivered ${d.observed ?? "?"}× by the mail provider`;
  if (d.status === "not_found")
    return d.keyed ? "Accepted, but not found in Sent" : "Not found in Sent";
  return null;
}

function clock(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime())
    ? iso
    : t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Compact badge for the row line. */
export function DeliveryBadge({ delivery }: { delivery: SendDeliveryView | null | undefined }) {
  const text = deliveryWarningText(delivery);
  if (!text || !delivery) return null;
  return (
    <Badge tone={delivery.status === "duplicate" ? "blocked" : "spend"}>
      {delivery.status === "duplicate" ? `delivered ${delivery.observed}×` : "not in Sent"}
    </Badge>
  );
}

/** Full warning for the letter card: what happened and when each copy went out. */
export function DeliveryWarning({ delivery }: { delivery: SendDeliveryView | null | undefined }) {
  const text = deliveryWarningText(delivery);
  if (!text || !delivery) return null;
  const tone =
    delivery.status === "duplicate"
      ? "text-[color:var(--ink-blocked-2)]"
      : "text-[color:var(--ink-spend-2)]";
  return (
    <details className={`text-[12px] leading-5 ${tone}`}>
      <summary className="cursor-pointer font-medium">{text}</summary>
      <div role="note" className="mt-2 space-y-1">
        {delivery.status === "duplicate" ? (
          <p>
            One send was recorded, but the {delivery.transport} mailbox's Sent folder holds{" "}
            {delivery.observed} copies to this recipient
            {delivery.deliveredAt.length > 0 && (
              <> ({delivery.deliveredAt.map(clock).join(", ")})</>
            )}
            .{" "}
            {delivery.keyed
              ? "Every copy carries the same Message-ID, so most mail clients show one email."
              : "The provider retried underneath the send; the recipient likely got every copy."}
          </p>
        ) : delivery.keyed ? (
          <p>
            The {delivery.transport} mailbox's server accepted this email, but no copy turned up in
            its Sent folder within 30 minutes. It was not resent.
          </p>
        ) : (
          <p>
            No copy of this email turned up in the {delivery.transport} mailbox's Sent folder within
            30 minutes of the send. It may not have gone out.
          </p>
        )}
      </div>
    </details>
  );
}
