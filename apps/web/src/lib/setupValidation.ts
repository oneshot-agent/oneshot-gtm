/**
 * Field validators + request builders for the sectioned /setup page. Pure and
 * DOM-free so the rules that used to live inline in the form (and the two
 * that silently failed open — identity caps and the add-sender cap) are unit
 * tested. Every validator returns `null` for "fine" and a short lowercase
 * message for `Field error=`.
 */
import type { SetupRequest } from "@oneshot-gtm/shared-types";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Optional field; when present must look like `local@host.tld`. */
export function validateEmail(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return null;
  // Deliberately loose: one @, no whitespace, a dot in the host part.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "enter an email address like jane@acme.com";
  return null;
}

/**
 * Optional field; when present must be a bare host name — no scheme, path,
 * port, mailbox or whitespace. Both the signature domain and the sending
 * domain are interpolated verbatim (signature line, `from_domain`), so
 * `https://acme.com/` would ship as-is.
 */
export function validateBareDomain(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return "bare domain only — drop the https://";
  if (/[/@:\s]/.test(v)) return "bare domain only — no path, port or mailbox";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) return "enter a domain like acme.com";
  return null;
}

export const CAP_ERROR = "enter a whole number of sends per day";

/**
 * A per-day send cap typed into a text box.
 *   blank → `null` when `blank: "uncapped"` (identity rows: no cap)
 *         → `undefined` when `blank: "omit"` (add-sender form: warm-up ramp)
 *   digits only → that integer
 *   anything else → error (never "uncapped" — that was the fail-open bug)
 */
export function parseCap(
  raw: string,
  opts: { blank: "uncapped" | "omit" },
): Parsed<number | null | undefined> {
  const v = raw.trim();
  if (v.length === 0) return { ok: true, value: opts.blank === "uncapped" ? null : undefined };
  if (!/^\d+$/.test(v)) return { ok: false, error: CAP_ERROR };
  const n = Number(v);
  if (!Number.isSafeInteger(n)) return { ok: false, error: CAP_ERROR };
  return { ok: true, value: n };
}

export const SPEND_CEILING_ERROR = "enter a positive number of USD, or leave blank for unlimited";

/**
 * Install-wide daily spend ceiling. Blank = unlimited (`null`). Uses
 * `Number()` rather than `parseFloat` — the same choice the CLI's
 * `configSpendCeiling` makes — so "2usd" is rejected instead of read as 2.
 */
export function parseSpendCeiling(raw: string): Parsed<number | null> {
  const v = raw.trim();
  if (v.length === 0) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: SPEND_CEILING_ERROR };
  return { ok: true, value: n };
}

/** Optional; when present must be an IANA zone the runtime's Intl knows. */
export function validateTimeZone(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return null;
  try {
    // The constructor is the check: an unknown zone throws a RangeError.
    Intl.DateTimeFormat("en-US", { timeZone: v }).format(0);
    return null;
  } catch {
    return "unknown time zone — use an IANA name like Europe/Vienna";
  }
}

/** Required text field (used for the LLM model so `""` never persists). */
export function validateRequired(raw: string, what: string): string | null {
  return raw.trim().length === 0 ? `enter ${what}` : null;
}

// ---------------------------------------------------------------------------
// Email-transport section: staging → one atomic SetupRequest

export interface PendingOneShotAdd {
  sendingDomain: string;
  mailbox: string;
  /** Raw text from the Max/day box; blank = warm-up ramp. Validated here. */
  maxPerDay: string;
}

export interface PendingSmartleadAdd {
  address: string;
  label: string;
  providerMessagePerDay: number | null;
}

export interface IdentityPoolStaging {
  /** Live identity ids + their stored cap, so stale edits can be dropped. */
  identities: Array<{ id: string; maxPerDay: number | null }>;
  /** Raw cap text per identity id, only for rows the founder touched. */
  capEdits: Record<string, string>;
  removedIds: string[];
  pendingAdds: PendingOneShotAdd[];
  pendingSmartleadAdds: PendingSmartleadAdd[];
  /** Legacy single-identity provider select; undefined = untouched. */
  emailProvider?: "oneshot" | "gmail";
}

export type IdentityPoolBuild =
  | { ok: true; request: SetupRequest; empty: boolean }
  | { ok: false; errors: { caps: Record<string, string>; adds: Record<string, string> } };

/** The stored cap as the text box shows it: blank = uncapped. */
export function capText(maxPerDay: number | null): string {
  return maxPerDay == null ? "" : String(maxPerDay);
}

/**
 * Turn the section's staging into the single POST that commits it. A cap edit
 * only counts when the row still exists AND the text differs from the stored
 * cap; a removal only when the id still exists. Any invalid cap fails the
 * whole build — nothing partial goes out.
 */
export function buildIdentityPoolRequest(s: IdentityPoolStaging): IdentityPoolBuild {
  const capErrors: Record<string, string> = {};
  const addErrors: Record<string, string> = {};
  const live = new Map(s.identities.map((i) => [i.id, i.maxPerDay]));
  const removed = new Set(s.removedIds.filter((id) => live.has(id)));

  const identityUpdates: NonNullable<SetupRequest["identityUpdates"]> = [];
  for (const [id, raw] of Object.entries(s.capEdits)) {
    if (!live.has(id) || removed.has(id)) continue;
    if (raw.trim() === capText(live.get(id) ?? null)) continue;
    const parsed = parseCap(raw, { blank: "uncapped" });
    if (!parsed.ok) {
      capErrors[id] = parsed.error;
      continue;
    }
    identityUpdates.push({ id, maxPerDay: parsed.value ?? null });
  }

  const addIdentities: NonNullable<SetupRequest["addIdentities"]> = [];
  for (const a of s.pendingAdds) {
    const parsed = parseCap(a.maxPerDay, { blank: "omit" });
    const key = `${a.mailbox.trim() || "agent"}@${a.sendingDomain}`;
    if (!parsed.ok) {
      addErrors[key] = parsed.error;
      continue;
    }
    addIdentities.push({
      provider: "oneshot",
      sendingDomain: a.sendingDomain,
      ...(a.mailbox.trim() ? { mailbox: a.mailbox.trim() } : {}),
      // Blank cap = omit → cold-start ramp; a number = explicit cap.
      ...(parsed.value !== undefined ? { maxPerDay: parsed.value } : {}),
    });
  }
  for (const a of s.pendingSmartleadAdds) {
    addIdentities.push({
      provider: "smartlead",
      address: a.address,
      ...(a.label.trim() ? { label: a.label.trim() } : {}),
      providerMessagePerDay: a.providerMessagePerDay,
    });
  }

  if (Object.keys(capErrors).length > 0 || Object.keys(addErrors).length > 0) {
    return { ok: false, errors: { caps: capErrors, adds: addErrors } };
  }

  const request: SetupRequest = {
    ...(identityUpdates.length > 0 ? { identityUpdates } : {}),
    ...(addIdentities.length > 0 ? { addIdentities } : {}),
    ...(removed.size > 0 ? { removeIdentityIds: [...removed] } : {}),
    ...(s.emailProvider !== undefined ? { emailProvider: s.emailProvider } : {}),
  };
  return { ok: true, request, empty: Object.keys(request).length === 0 };
}
