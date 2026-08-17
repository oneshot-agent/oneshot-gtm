/**
 * Partial PII masking for "privacy mode" — used before screenshots so contact
 * data isn't identifying while the UI still reads naturally (see `usePrivacy`
 * + the `<Pii>` component). These are intentionally lossy/readable, NOT secure
 * redaction: the goal is "don't leak a real person in a screenshot", not
 * cryptographic anonymity. All return the input unchanged when empty.
 */

const DOTS = "•••";

/** "Asad Hussain" → "Asad H." — first token kept, rest reduced to initials. */
export function maskName(name: string | null | undefined): string {
  if (!name) return name ?? "";
  const tokens = name.trim().split(/\s+/);
  if (tokens.length <= 1) return tokens[0] ?? "";
  const [first, ...rest] = tokens;
  const initials = rest
    .map((t) => (t[0] ? `${t[0].toUpperCase()}.` : ""))
    .filter(Boolean)
    .join(" ");
  return initials ? `${first} ${initials}` : (first ?? "");
}

/** "asadhussain2408@gmail.com" → "asa•••@gmail.com" — keep a hint + the domain. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return email ?? "";
  const at = email.indexOf("@");
  if (at === -1) {
    // Not an address — mask everything past the first 3 chars.
    return email.length <= 3 ? `${email[0] ?? ""}${DOTS}` : `${email.slice(0, 3)}${DOTS}`;
  }
  const local = email.slice(0, at);
  const domain = email.slice(at); // includes "@"
  const keep = local.length >= 3 ? local.slice(0, 3) : local.slice(0, 1);
  return `${keep}${DOTS}${domain}`;
}

/** "Acme AI" → "Acme" — keep the first word only. */
export function maskCompany(company: string | null | undefined): string {
  if (!company) return company ?? "";
  return company.trim().split(/\s+/)[0] ?? "";
}

/** "+1 555 123 4567" → "•••-4567" — keep the last 4 digits. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return phone ?? "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return phone;
  return `${DOTS}-${digits.slice(-4)}`;
}

/**
 * Raw From header: "John Smith <john@x.com>" → "John S. <joh•••@x.com>".
 * Bare addresses fall through to `maskEmail`. Mirrors the `<…>` parse in
 * `apps/server/src/api/inbox.ts:normalizeFrom`.
 */
export function maskFrom(raw: string | null | undefined): string {
  if (!raw) return raw ?? "";
  const m = raw.match(/^(.*?)<([^>]+)>\s*$/);
  // No angle brackets — a bare address or a bare display name; let `auto` decide.
  if (!m) return maskAuto(raw.trim());
  const display = (m[1] ?? "").trim();
  const email = (m[2] ?? "").trim();
  const maskedEmail = maskEmail(email);
  return display ? `${maskName(display)} <${maskedEmail}>` : `<${maskedEmail}>`;
}

/** Mask a value that may be either a name or an email (detected by "@"). */
export function maskAuto(value: string | null | undefined): string {
  if (!value) return value ?? "";
  return value.includes("@") ? maskEmail(value) : maskName(value);
}

export type PiiKind = "name" | "email" | "company" | "phone" | "from" | "auto";

/** Dispatch to the right mask function for a `<Pii kind>`. */
export function maskByKind(kind: PiiKind, value: string): string {
  switch (kind) {
    case "name":
      return maskName(value);
    case "email":
      return maskEmail(value);
    case "company":
      return maskCompany(value);
    case "phone":
      return maskPhone(value);
    case "from":
      return maskFrom(value);
    case "auto":
      return maskAuto(value);
  }
}

/**
 * Identity-bearing keys inside a receipt payload, mapped to how each is masked.
 * Anything not listed here is left alone — which is the point: costs, receipt
 * ids, request ids, timestamps, and every other figure must survive privacy
 * mode untouched, because the numbers are the whole reason to show a receipt.
 */
const IDENTITY_KEYS: Record<string, PiiKind> = {
  email: "email",
  emails: "email",
  altemails: "email",
  best_work_email: "email",
  best_personal_email: "email",
  from: "from",
  name: "name",
  full_name: "name",
  first_name: "name",
  last_name: "name",
  phone: "phone",
  phones: "phone",
  fullphone: "phone",
  company: "company",
  organization: "company",
};

/** Bare address anywhere inside a free-text string (a query, a memo, a summary). */
const EMBEDDED_EMAIL = /[^\s"'<>@]+@[^\s"'<>@]+\.[^\s"'<>@]+/g;

/** "https://linkedin.com/in/jane-doe-1a2b" → "https://linkedin.com/in/•••" */
function maskProfileUrl(url: string): string {
  return url.replace(/\/(in|profile|users?)\/[^/?#]+/i, (_m, seg: string) => `/${seg}/${DOTS}`);
}

/**
 * Recursively mask a decoded JSON payload for screenshots — used by the
 * receipts modal, where the signed payload is rendered verbatim and so cannot
 * be wrapped in `<Pii>` field by field.
 *
 * Guarantees, in order of importance:
 *  1. Numbers and booleans are returned by identity. No figure is ever altered.
 *  2. Strings under a known identity key are masked by that key's kind.
 *  3. Any other string has embedded email addresses masked in place.
 *
 * Same lossy-but-readable contract as the rest of this file: the goal is "don't
 * leak a real person in a screenshot", not cryptographic anonymity.
 */
export function maskDeep<T>(value: T, masked: boolean, kind?: PiiKind): T {
  if (!masked) return value;
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    if (kind) return maskByKind(kind, value) as unknown as T;
    if (/^https?:\/\//i.test(value)) return maskProfileUrl(value) as unknown as T;
    return value.replace(EMBEDDED_EMAIL, (m) => maskEmail(m)) as unknown as T;
  }

  // Elements of an identity-keyed array inherit that key's kind ("emails": [...]).
  if (Array.isArray(value)) {
    return value.map((v) => maskDeep(v, masked, kind)) as unknown as T;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyKind = IDENTITY_KEYS[k.toLowerCase()];
      out[k] = maskDeep(v, masked, keyKind);
      if (/^linkedin_?url$/i.test(k) && typeof v === "string") out[k] = maskProfileUrl(v);
    }
    return out as unknown as T;
  }

  return value;
}

/**
 * The single gate behind privacy mode — shared by `<Pii>` and `useMask` so the
 * on/off + empty-value logic lives in exactly one (testable) place. Returns the
 * raw value when privacy is off or the value is empty; masks otherwise.
 */
export function applyMask(
  masked: boolean,
  kind: PiiKind,
  value: string | null | undefined,
): string {
  const v = value ?? "";
  return masked && v ? maskByKind(kind, v) : v;
}
