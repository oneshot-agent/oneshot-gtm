import type { QueueStatusView } from "@oneshot-gtm/shared-types";
import { linkedinUrlFor, phoneFor } from "./payloadIdentity.ts";

/**
 * A row's phone lookup as the server writes it on the payload
 * (`payload.phoneLookup`, `QueuePhoneLookup` in core). Read as untyped JSON:
 * a shape check is the contract.
 */
export interface PhoneLookupView {
  status: "running" | "done" | "none" | "unavailable" | "error";
  at: string;
  message?: string;
}

const STATUSES = new Set(["running", "done", "none", "unavailable", "error"]);

export function phoneLookupFor(payload: unknown): PhoneLookupView | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>)["phoneLookup"];
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r["status"] !== "string" || !STATUSES.has(r["status"])) return null;
  if (typeof r["at"] !== "string") return null;
  return r as unknown as PhoneLookupView;
}

/** The later of two reads of one row's lookup: the list's and the open case's poll. */
export function latestPhoneLookup(
  a: PhoneLookupView | null,
  b: PhoneLookupView | null,
): PhoneLookupView | null {
  if (!a || !b) return a ?? b;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

/** A lookup still `running` after this long was cut off (a restart); it can be asked again. */
export const PHONE_LOOKUP_STALE_MS = 15 * 60 * 1000;

/** How often an open case reads its row while a lookup runs. */
export const PHONE_LOOKUP_POLL_MS = 5_000;

export type PhoneLookupState =
  | { kind: "hidden" }
  | { kind: "needs-linkedin" }
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "found"; at: string }
  | { kind: "none"; at: string }
  | { kind: "retry"; label: string; at: string };

/**
 * What the case view shows for a row's phone: a "Find phone" button, the
 * running line, or how the last lookup ended. Only approved and sent rows
 * can look one up. A number the finder already had needs nothing.
 */
export function phoneLookupState(input: {
  status: QueueStatusView;
  payload: unknown;
  lookup?: PhoneLookupView | null;
  now?: number;
}): PhoneLookupState {
  if (input.status !== "approved" && input.status !== "sent") return { kind: "hidden" };
  const lookup = input.lookup !== undefined ? input.lookup : phoneLookupFor(input.payload);
  const now = input.now ?? Date.now();
  if (lookup?.status === "running" && now - Date.parse(lookup.at) < PHONE_LOOKUP_STALE_MS)
    return { kind: "running" };
  if (phoneFor(input.payload))
    return lookup?.status === "done" ? { kind: "found", at: lookup.at } : { kind: "hidden" };
  if (!linkedinUrlFor(input.payload)) return { kind: "needs-linkedin" };
  if (!lookup) return { kind: "idle" };
  switch (lookup.status) {
    case "none":
      return { kind: "none", at: lookup.at };
    case "unavailable":
      return { kind: "retry", label: "Unavailable, try again", at: lookup.at };
    case "error":
      return {
        kind: "retry",
        label: lookup.message ? `Lookup failed: ${lookup.message}` : "Lookup failed",
        at: lookup.at,
      };
    case "running":
      return { kind: "retry", label: "Lookup interrupted", at: lookup.at };
    case "done":
      // A number was found, but the payload has none now (edited out).
      return { kind: "idle" };
  }
}
