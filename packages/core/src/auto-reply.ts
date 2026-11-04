import { isPermanentAutoText, stripQuotedChain } from "./reply-classify.ts";

/**
 * What an automatic reply says about the person, beyond "a machine wrote it"
 * (`classifyReply`'s `auto` / `auto_permanent`):
 * - `left_company`: the person is gone (left, retired, mailbox closed). The
 *   sequence stops; a named successor can be queued for review.
 * - `out_of_office`: away for a while. The next step waits until they are back.
 * - `other`: any other autoresponder (ticket receipts, "thanks for your email").
 *   Nothing changes.
 *
 * The rules here are the fast path and handle the clear cases. Anything they
 * cannot settle is passed to the model extraction in intel (`classifyAutoReply`).
 */
export type AutoReplyReason = "left_company" | "out_of_office" | "other";

export const AUTO_REPLY_REASONS: readonly AutoReplyReason[] = [
  "left_company",
  "out_of_office",
  "other",
];

export function isAutoReplyReason(v: unknown): v is AutoReplyReason {
  return typeof v === "string" && (AUTO_REPLY_REASONS as readonly string[]).includes(v);
}

/** Someone a "left the company" notice points to. */
export interface AutoReplySuccessor {
  name?: string;
  email?: string;
  /** The pending queue row created for them, once queued. */
  queueId?: number;
}

export interface AutoReplyFacts {
  reason: AutoReplyReason;
  /** First day back (YYYY-MM-DD) for an out-of-office; null when no date is given. */
  returnDate: string | null;
  /** Only for `left_company`. */
  successor: AutoReplySuccessor | null;
}

export interface AutoReplyInput {
  kind: string;
  subject: string | null | undefined;
  body: string | null | undefined;
  /** The address the reply came from: never its own successor. */
  fromEmail: string | null | undefined;
  /** When the reply arrived. Relative dates ("until 14th December") resolve against it. */
  receivedAt: string;
}

/** The workspace's `autoReply` block (config.json), every key optional. */
export interface AutoReplyConfig {
  /** Days added to a stated return date before the next step is due. Default 2. */
  oooBufferDays?: number;
  /** Days the next step waits when an out-of-office gives no date. Default 7. */
  undatedDelayDays?: number;
  /** Queue the successor a "left the company" reply names, as a pending row. Default true. */
  queueSuccessor?: boolean;
  /** A policy block (5.7.x bounce) stops the sequence. Default true. */
  stopOnBlock?: boolean;
}

export const DEFAULT_AUTO_REPLY_CONFIG: Required<AutoReplyConfig> = {
  oooBufferDays: 2,
  undatedDelayDays: 7,
  queueSuccessor: true,
  stopOnBlock: true,
};

function dayCount(v: unknown, fallback: number, max: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : fallback;
}

/**
 * The `autoReply` block as the reply poll reads it: each key validated,
 * anything missing or invalid reads as its default.
 */
export function autoReplyConfigOf(cfg: { autoReply?: unknown } | null | undefined) {
  const raw = (cfg?.autoReply ?? {}) as Record<string, unknown>;
  const d = DEFAULT_AUTO_REPLY_CONFIG;
  return {
    oooBufferDays: dayCount(raw["oooBufferDays"], d.oooBufferDays, 60),
    undatedDelayDays: dayCount(raw["undatedDelayDays"], d.undatedDelayDays, 90),
    queueSuccessor:
      typeof raw["queueSuccessor"] === "boolean" ? raw["queueSuccessor"] : d.queueSuccessor,
    stopOnBlock: typeof raw["stopOnBlock"] === "boolean" ? raw["stopOnBlock"] : d.stopOnBlock,
  } satisfies Required<AutoReplyConfig>;
}

// ── Delivery notices ────────────────────────────────────────────────────────

const DSN_FROM_RE = /^(?:mailer-daemon|postmaster|mail-daemon|bounce[s]?)@/i;
const DSN_SUBJECT_RE =
  /^\s*(?:undeliverable|undelivered mail|delivery status notification|mail delivery (?:failed|failure|subsystem)|returned mail|delivery (?:has )?failed|failure notice|non[- ]?delivery)/i;

/**
 * A bounce notice (DSN) rather than a person's autoresponder. These are
 * stored as `auto` too, and carry no return date or successor: the bounce
 * poll handles them.
 */
export function isDeliveryNotice(input: { from?: string | null; subject?: string | null }) {
  return DSN_FROM_RE.test((input.from ?? "").trim()) || DSN_SUBJECT_RE.test(input.subject ?? "");
}

// ── Return dates ────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};
const MONTH_ALT = Object.keys(MONTHS)
  .toSorted((a, b) => b.length - a.length)
  .join("|");
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const DAY_MONTH_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTH_ALT})\\b\\.?(?:,? (\\d{4})\\b)?`,
  "gi",
);
const MONTH_DAY_RE = new RegExp(
  `\\b(${MONTH_ALT})\\b\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4})\\b)?`,
  "gi",
);
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const NUMERIC_RE = /\b(\d{1,2})([./])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?!\d)/g;
const WEEKDAY_RE = new RegExp(
  `\\b(?:back|return(?:ing)?)(?: on)? (${WEEKDAYS.join("|")})\\b`,
  "gi",
);

// A keyword just before a date says what the date is. Nearest one wins.
const RETURN_KW_RE =
  /\b(?:back|return(?:ing|s)?|available(?: again)?(?: on| from)?|in the office(?: again)?(?: on| from)?)\b/gi;
const UNTIL_KW_RE = /\b(?:until|till|til|through|thru|to|including|ending)\b|[-–]\s*$/gi;
// How far before a date a keyword still counts, and nothing in between may
// end the sentence.
const KEYWORD_WINDOW = 48;

type DateTier = "return" | "until" | "bare";

const DAY_MS = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function validUtc(y: number, m: number, d: number): Date | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m, d));
  return t.getUTCMonth() === m && t.getUTCDate() === d ? t : null;
}

/**
 * The year a yearless date falls in: the received year, or the next one when
 * the date would sit more than 60 days in the past ("until 5 January" written
 * in late December).
 */
function withYear(m: number, d: number, year: number | null, received: Date): Date | null {
  if (year != null) return validUtc(year < 100 ? 2000 + year : year, m, d);
  const y = received.getUTCFullYear();
  const same = validUtc(y, m, d);
  if (!same) return validUtc(y + 1, m, d);
  return same.getTime() < received.getTime() - 60 * DAY_MS ? validUtc(y + 1, m, d) : same;
}

function tierBefore(text: string, at: number): DateTier {
  const window = text.slice(Math.max(0, at - KEYWORD_WINDOW), at);
  // A sentence break between the keyword and the date breaks the link.
  const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
  const near = cut >= 0 ? window.slice(cut + 1) : window;
  const last = (re: RegExp): number => {
    let pos = -1;
    for (const m of near.matchAll(re)) pos = m.index ?? pos;
    return pos;
  };
  const r = last(RETURN_KW_RE);
  const u = last(UNTIL_KW_RE);
  if (r < 0 && u < 0) return "bare";
  return r > u ? "return" : "until";
}

/**
 * The first day back an out-of-office states, as YYYY-MM-DD, resolved against
 * the day the reply arrived. A "back on" date beats an "until"/"through" date
 * ("through November 7 … back on Monday, November 9" is the 9th); within a
 * kind the latest wins. Numeric dates count only after such a keyword, and
 * read day-first with dots and month-first with slashes unless a part above
 * 12 settles it; both parts under 13 with a slash is ambiguous and skipped.
 * Null when nothing resolves within a year of the reply.
 */
export function resolveReturnDate(text: string, receivedAt: string): string | null {
  const received = new Date(receivedAt);
  if (!Number.isFinite(received.getTime())) return null;
  const body = text
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .slice(0, 2000);
  const found: Array<{ tier: DateTier; date: Date }> = [];
  const push = (at: number, date: Date | null, requireKeyword = false) => {
    if (!date) return;
    const tier = tierBefore(body, at);
    if (requireKeyword && tier === "bare") return;
    found.push({ tier, date });
  };
  for (const m of body.matchAll(DAY_MONTH_RE)) {
    const month = MONTHS[m[2]!.toLowerCase()]!;
    push(m.index!, withYear(month, Number(m[1]), m[3] ? Number(m[3]) : null, received));
  }
  for (const m of body.matchAll(MONTH_DAY_RE)) {
    const month = MONTHS[m[1]!.toLowerCase()]!;
    push(m.index!, withYear(month, Number(m[2]), m[3] ? Number(m[3]) : null, received));
  }
  for (const m of body.matchAll(ISO_RE)) {
    push(m.index!, validUtc(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  for (const m of body.matchAll(NUMERIC_RE)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const year = m[4] ? Number(m[4]) : null;
    let day: number;
    let month: number;
    if (m[2] === ".") [day, month] = [a, b];
    else if (a > 12) [day, month] = [a, b];
    else if (b > 12) [month, day] = [a, b];
    else continue;
    push(m.index!, withYear(month - 1, day, year, received), true);
  }
  if (!found.some((f) => f.tier === "return")) {
    for (const m of body.matchAll(WEEKDAY_RE)) {
      const want = WEEKDAYS.indexOf(m[1]!.toLowerCase());
      const ahead = (want - received.getUTCDay() + 7) % 7 || 7;
      const day = new Date(
        Date.UTC(received.getUTCFullYear(), received.getUTCMonth(), received.getUTCDate()) +
          ahead * DAY_MS,
      );
      found.push({ tier: "return", date: day });
    }
  }
  const inRange = found.filter(
    (f) => Math.abs(f.date.getTime() - received.getTime()) <= 366 * DAY_MS,
  );
  for (const tier of ["return", "until", "bare"] as const) {
    const dates = inRange.filter((f) => f.tier === tier).map((f) => f.date.getTime());
    if (dates.length > 0) return ymd(new Date(Math.max(...dates)));
  }
  return null;
}

// ── Successors ──────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
const ROLE_LOCAL_RE =
  /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|info|support|hello|contact|sales|admin|office|team|help|careers|jobs|hr|privacy|legal|press|billing|accounts?)$/i;
const NAME_STOP = new Set(
  [
    "please",
    "contact",
    "email",
    "e-mail",
    "mail",
    "write",
    "reach",
    "or",
    "and",
    "the",
    "my",
    "our",
    "your",
    "with",
    "for",
    "to",
    "at",
    "via",
    "on",
    "matters",
    "thank",
    "thanks",
    "regards",
    "kind",
    "best",
    "dear",
    "hi",
    "hello",
    "i",
    "colleague",
    "successor",
    "mr",
    "ms",
    "mrs",
    "miss",
    "dr",
  ].map((w) => w.toLowerCase()),
);
const NAME_WORD_RE = /^\p{Lu}[\p{L}'-]*$/u;
const CONTACT_CUE_RE =
  /\b(?:contact|reach(?: out to)?|write to|get in touch|forward|replac(?:e|ement|ing)|successor|taken over|take over|colleague|in my place|instead)\b/i;

/** Up to three capitalised words ending right before `at` in `text`. */
function nameBefore(text: string, at: number): string | null {
  const before = text
    .slice(Math.max(0, at - 80), at)
    .replace(/[\s(<[:,–-]+$/u, "")
    .replace(/\b(?:at|via|on|email|e-mail)$/i, "")
    .trim();
  const words = before.split(/\s+/);
  const out: string[] = [];
  for (let i = words.length - 1; i >= 0 && out.length < 3; i--) {
    const w = words[i]!.replace(/[.,;:]+$/, "");
    if (!NAME_WORD_RE.test(w) || NAME_STOP.has(w.toLowerCase())) break;
    out.unshift(w);
  }
  return out.length > 0 ? out.join(" ") : null;
}

/** Whether an address is a role inbox or one of `exclude`. */
function excludedAddress(email: string, exclude: readonly string[]): boolean {
  const lower = email.toLowerCase();
  if (exclude.some((e) => e.trim().toLowerCase() === lower)) return true;
  return ROLE_LOCAL_RE.test(lower.split("@")[0] ?? "");
}

/**
 * The person a "left the company" notice points to: the first personal
 * address after a contact cue (else the first one at all) and the name just
 * before it, or a name after "please contact" when no address is given. Role
 * inboxes (info@, support@, noreply@) and the sender's own address never count.
 */
export function extractSuccessor(
  text: string,
  exclude: readonly string[] = [],
): AutoReplySuccessor | null {
  const body = text.replace(/[’‘]/g, "'").slice(0, 2000);
  const emails = [...body.matchAll(EMAIL_RE)].filter((m) => !excludedAddress(m[0], exclude));
  if (emails.length > 0) {
    const cued =
      emails.find((m) => CONTACT_CUE_RE.test(body.slice(Math.max(0, m.index! - 120), m.index!))) ??
      emails[0]!;
    const email = cued[0].replace(/\.+$/, "").toLowerCase();
    const name = nameBefore(body, cued.index!);
    return { email, ...(name ? { name } : {}) };
  }
  const named = body.match(
    /\b(?:contact|reach out to|write to|get in touch with)\s+(?:(?:Mr|Ms|Mrs|Miss|Dr)\.?\s+)?(\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){0,2})/u,
  );
  if (named) {
    const words = named[1]!.split(/\s+/).filter((w) => !NAME_STOP.has(w.toLowerCase()));
    if (words.length > 0) return { name: words.join(" ") };
  }
  return null;
}

/** Whether `email` appears in `text`, case-insensitively: a model's answer must quote the reply. */
export function textHasAddress(text: string, email: string): boolean {
  return text.toLowerCase().includes(email.trim().toLowerCase());
}

/** Validate a model-proposed successor against the reply text. */
export function successorFromModel(
  text: string,
  raw: { name?: unknown; email?: unknown },
  exclude: readonly string[] = [],
): AutoReplySuccessor | null {
  const email =
    typeof raw.email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email.trim()) &&
    textHasAddress(text, raw.email) &&
    !excludedAddress(raw.email.trim(), exclude)
      ? raw.email.trim().toLowerCase()
      : null;
  const name =
    typeof raw.name === "string" &&
    raw.name.trim().length > 1 &&
    raw.name.trim().length <= 80 &&
    text.toLowerCase().includes(raw.name.trim().toLowerCase())
      ? raw.name.trim()
      : null;
  if (!email && !name) return null;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

// ── The fast path ───────────────────────────────────────────────────────────

const OOO_RE =
  /\b(?:out of (?:the )?office|out of the country|on (?:annual|parental|maternity|paternity|sick|medical|holiday|vacation) leave|on (?:vacation|holiday|leave|sabbatical|a (?:business )?trip)|away (?:from|until|till|through)|currently (?:away|out|travell?ing|offline)|offline until|limited access|travell?ing (?:until|till|through)|(?:will|i'?ll) be back|i(?:'m| am) back on|return(?:ing)? (?:to the office )?on|until i(?:'m| am) back|parental leave|medical leave|abwesend|absent)\b/i;
const OOO_SUBJECT_RE = /^\s*(?:out of (?:the )?office|ooo[:\s]|abwesenheit)/i;
const DATE_HINT_RE = new RegExp(`\\d|\\b(?:${MONTH_ALT}|${WEEKDAYS.join("|")})\\b`, "i");

export interface AutoReplyFastResult extends AutoReplyFacts {
  /** The rules could not settle something a model might: reason, a date or a successor. */
  needsModel: boolean;
}

/** The reply text the rules and the model read: subject, then the quote-stripped body. */
export function autoReplyText(subject: string | null | undefined, body: string | null | undefined) {
  return `${subject ?? ""}\n${stripQuotedChain(body ?? "")}`.slice(0, 2400);
}

/**
 * Rules-only reading of an automatic reply. `needsModel` is true when a model
 * could add something: the reason is unclear, an out-of-office gives a date
 * the rules could not read, or a "left" notice names a contact the rules could
 * not pick out.
 */
export function classifyAutoReplyFast(input: AutoReplyInput): AutoReplyFastResult {
  const text = autoReplyText(input.subject, input.body);
  const exclude = input.fromEmail ? [input.fromEmail] : [];
  const permanent =
    input.kind === "auto_permanent" || isPermanentAutoText(input.subject, input.body);
  if (permanent) {
    const successor = extractSuccessor(text, exclude);
    return {
      reason: "left_company",
      returnDate: null,
      successor,
      needsModel: !successor?.email && CONTACT_CUE_RE.test(text),
    };
  }
  if (OOO_RE.test(text) || OOO_SUBJECT_RE.test(input.subject ?? "")) {
    const returnDate = resolveReturnDate(text, input.receivedAt);
    return {
      reason: "out_of_office",
      returnDate,
      successor: null,
      needsModel: returnDate == null && DATE_HINT_RE.test(stripQuotedChain(input.body ?? "")),
    };
  }
  return { reason: "other", returnDate: null, successor: null, needsModel: true };
}

/**
 * When the next step may go after an out-of-office: the return date plus
 * `oooBufferDays`, or `now` plus `undatedDelayDays` when no date was given.
 */
export function autoReplyHoldUntil(
  facts: Pick<AutoReplyFacts, "reason" | "returnDate">,
  cfg: Pick<Required<AutoReplyConfig>, "oooBufferDays" | "undatedDelayDays">,
  now: Date = new Date(),
): string | null {
  if (facts.reason !== "out_of_office") return null;
  if (facts.returnDate) {
    const back = Date.parse(`${facts.returnDate}T00:00:00.000Z`);
    if (Number.isFinite(back)) return new Date(back + cfg.oooBufferDays * DAY_MS).toISOString();
  }
  return new Date(now.getTime() + cfg.undatedDelayDays * DAY_MS).toISOString();
}

/** The company domain of an address, lowercased; null for garbage. */
export function emailDomainOf(email: string | null | undefined): string | null {
  const at = (email ?? "").lastIndexOf("@");
  if (at < 0) return null;
  const d = (email ?? "")
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return d.includes(".") ? d : null;
}
