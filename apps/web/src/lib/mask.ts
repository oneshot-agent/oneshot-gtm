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
