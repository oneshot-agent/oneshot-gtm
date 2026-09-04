import {
  cadenceGoalId,
  ENRICH_CACHE_TTL_MS,
  ENRICH_DEADLINE_MS,
  ENRICH_FAILURE_TTL_MS,
  enrichProfile,
  getLedger,
  isTransientToolError,
  loadConfig,
  logEvent,
  receiptUrlForId,
  sendEmail,
  throwIfCancelled,
  trackSend,
  verifyEmail,
  withDeadline,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

/** The shape safeEnrich returns when enrichment failed (live or negative-cached). */
const FAILED_ENRICH = { status: "failed", profile: null, cost: 0 };

/**
 * enrichProfile that never throws and caches by email (the SDK call is slow
 * and billed). A cache hit returns receiptId 0 (no spend); on failure, returns
 * an empty result so callers' `enr.result` / `enr.receiptId` usage keeps working.
 */
export async function safeEnrich(
  input: Parameters<typeof enrichProfile>[0],
  ctx: Parameters<typeof enrichProfile>[1],
): Promise<Awaited<ReturnType<typeof enrichProfile>>> {
  const ledger = getLedger();
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : null;

  if (email) {
    const cached = ledger.getCachedEnrichment(email);
    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
      // Negative entry: recent SDK failure — don't retry until the TTL expires.
      if (cached.status === "failed") {
        if (ageMs < ENRICH_FAILURE_TTL_MS) {
          return { result: FAILED_ENRICH, receiptId: 0 } as unknown as Awaited<
            ReturnType<typeof enrichProfile>
          >;
        }
      } else if (ageMs < ENRICH_CACHE_TTL_MS) {
        try {
          return { result: JSON.parse(cached.result_json), receiptId: 0 } as Awaited<
            ReturnType<typeof enrichProfile>
          >;
        } catch {
          // corrupt cache row — fall through and refetch
        }
      }
    }
  }

  try {
    // Default audit context so even ad-hoc callers that pass only {playName}
    // get a useful decisionContext on the receipt. Caller-supplied keys win.
    const enrichedCtx = {
      ...ctx,
      decisionContext: {
        source: "play.enrich",
        ...(email ? { prospectEmail: email } : {}),
        ...(input.linkedinUrl ? { linkedinUrl: input.linkedinUrl } : {}),
        ...(input.companyDomain ? { companyDomain: input.companyDomain } : {}),
        ...ctx.decisionContext,
      },
    };
    const live = enrichProfile(input, enrichedCtx);
    // Cache writes ride on the LIVE promise, not the deadline race — a call
    // that outlives the deadline still records its outcome when it settles
    // (late success overwrites the failure marker written below).
    live.then(
      (out) => {
        if (email) {
          try {
            ledger.setCachedEnrichment(email, JSON.stringify(out.result));
          } catch {
            // cache write is best-effort
          }
        }
      },
      () => {
        // Rejection is handled by the race's catch below (or already raced
        // out); this handler only exists to silence unhandled-rejection noise
        // from the abandoned promise.
      },
    );
    return await withDeadline(live, ENRICH_DEADLINE_MS, "enrichProfile");
  } catch (err) {
    const message = (err as Error)?.message ?? "";
    logEvent("enrich.failed", { play: ctx.playName, message_120: message.slice(0, 120) }, "warn");
    // Only negative-cache a GENUINE failure (no data for this email). A
    // transient platform/transport error must NOT be cached, or the email stays
    // un-enrichable for ENRICH_FAILURE_TTL_MS after the platform recovers.
    if (email && !isTransientToolError(err)) {
      try {
        ledger.setCachedEnrichmentFailure(email, message);
      } catch {
        // cache write is best-effort
      }
    }
    return {
      result: FAILED_ENRICH,
      receiptId: 0,
    } as unknown as Awaited<ReturnType<typeof enrichProfile>>;
  }
}

export const SLOP_PHRASES: Array<[RegExp, string]> = [
  [/\bI noticed\b/i, "banned-opener:I-noticed"],
  [/\bI came across\b/i, "banned-opener:I-came-across"],
  [/\bHope this (?:email )?finds you well\b/i, "banned-opener:hope-this-finds"],
  [/\bQuick question\b/i, "banned-opener:quick-question"],
  [/\bLoved your launch\b/i, "banned-opener:loved-your-launch"],
  [/\bReaching out because\b/i, "banned-opener:reaching-out"],
  [/\bI'd love to (?:chat|connect|jump on a call|hear)\b/i, "banned-cta:love-to-chat"],
  // Any time-boxed meeting ask, not just the 15-minute one: "worth a 10-min
  // back and forth" shipped 291 times past the literal 15 in this pattern.
  [/\bWorth a \d+.?min/i, "banned-cta:worth-n-min"],
  [/\bMind if I\b/i, "banned-cta:mind-if-i"],
  [/\bJust wanted to\b/i, "banned-filler:just-wanted-to"],
  // A meeting ask dressed as a small one (_humanizer.md -> Banned CTAs). Prompt
  // text alone did not hold it: 120 of 312 repo-interest second touches shipped
  // with one, because several play prompts quoted the phrase while banning it.
  [/\b(?:compare notes|swap takes|back.?and.?forth|trade notes)\b/i, "banned-cta:compare-notes"],
  [/\bcurious to (?:learn|hear)\b/i, "banned-filler:curious-to"],
  [
    /\b(?:additionally|crucial|delve|enduring|enhance|fostering|garner|highlight|interplay|intricate|pivotal|showcase|tapestry|testament|underscore|leverage|navigate|elevate|empower|seamless|robust|comprehensive|vibrant|profound|groundbreaking|revolutionary)\b/i,
    "ai-vocab",
  ],
  [
    /\b(?:serves as|stands as|represents a|marks a|functions as|boasts a|features a)\b/i,
    "copula-avoidance",
  ],
  [/^(?:Great question|Certainly|Of course|Absolutely)[!,]/i, "sycophantic-opener"],
  [
    /\b(?:as of my last training|based on available information|while specific details are limited)\b/i,
    "knowledge-cutoff-hedge",
  ],
  [/\bIt'?s not (?:just|merely) [^.]+, it'?s\b/i, "negative-parallelism"],
  [
    /\b(?:the future looks bright|exciting times lie ahead|journey toward)\b/i,
    "generic-positive-ending",
  ],
  [/\b(?:hope this helps|let me know if you'?d like|happy to expand)\b/i, "servile-closer"],
];

/**
 * Trailing signature lines the signatureDirective forces the LLM to append,
 * in last-line-first order so callers can peel from the end. Empty when
 * neither name nor domain is configured.
 */
function configuredSigLines(): string[] {
  const cfg = loadConfig();
  const out: string[] = [];
  if (cfg.mobileSignature === true) out.push("Sent from my iPhone");
  const domain = (cfg.productDomain ?? "").trim();
  if (domain) out.push(domain);
  const name = (cfg.founderName ?? "").trim();
  if (name) out.push(name);
  return out;
}

/**
 * Word count for body-too-long lint, minus the trailing signature lines the
 * signatureDirective forces — so those deterministic words don't eat the
 * prompt's word budget. `sigLines` (last-line-first) is exposed for tests;
 * production passes nothing and reads config.
 */
export function bodyWordsForLint(body: string, sigLines?: string[]): number {
  const lines = sigLines ?? configuredSigLines();
  let trimmed = body.replace(/\s+$/, "");
  // Peel each sig line off the tail only if it matches the current last line —
  // never chop content that merely contains the founder's name mid-paragraph.
  for (const line of lines) {
    const i = trimmed.lastIndexOf("\n");
    const last = (i < 0 ? trimmed : trimmed.slice(i + 1)).trim();
    if (last !== line) break;
    trimmed = trimmed.slice(0, i < 0 ? 0 : i).replace(/\s+$/, "");
  }
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/**
 * Words of the body that make up an opener fingerprint. Two, measured: across
 * 411 sent follow-ups the opener "still curious" held 55% at two words but
 * fragmented to 18% by six, so a longer stem slips under any usable cap while
 * the mail still reads identically to anyone who sees two of them.
 */
const OPENER_STEM_WORDS = 2;

/** Below this many prior sends the share is noise, so the cap never fires. */
const OPENER_MIN_SAMPLE = 8;

/** Share of recent sends one stem may hold before it counts as a fingerprint. */
const OPENER_MAX_SHARE = 0.25;

/**
 * The body's first `words` words, minus a greeting line, lowercased and
 * stripped of punctuation — the unit the opener-frequency cap compares.
 *
 * The greeting goes because it is generated from the prospect's name: leaving
 * "Hey Sam," in would make every stem unique and the cap would never fire.
 */
export function openerStem(body: string, words = OPENER_STEM_WORDS): string {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const first = lines[0] ?? "";
  const rest =
    lines.length > 1 &&
    /^(?:hey|hi|hello|good (?:morning|afternoon))\b[^,]{0,40}[,\-–—]?$/i.test(first)
      ? lines.slice(1)
      : lines;
  const normalized = rest
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  return normalized.split(" ").filter(Boolean).slice(0, words).join(" ");
}

/**
 * Flags a draft whose opening words already carry more than their share of
 * this play + step's recent sends.
 *
 * A frequency cap rather than a ban: the goal is not that every opener be
 * unique, it is that no single opener speaks for the majority of a domain's
 * touches. Prompt text alone did not hold this — the prompts advertise four
 * shapes and the model still reached for the same one — so it is gated here,
 * where a rule cannot be talked out of.
 *
 * `recentBodies` is the caller's window (newest first); an empty or short
 * window returns no flags rather than guessing.
 *
 * Paired with `overusedOpeners`, which the follow-up builder feeds to the
 * model BEFORE it drafts — the flag alone would only reject, and every
 * rejection costs another paid draft.
 */
export function overusedOpeners(
  recentBodies: readonly string[],
  opts: { minSample?: number; maxShare?: number } = {},
): string[] {
  const minSample = opts.minSample ?? OPENER_MIN_SAMPLE;
  const maxShare = opts.maxShare ?? OPENER_MAX_SHARE;
  if (recentBodies.length < minSample) return [];
  const counts = new Map<string, number>();
  for (const prior of recentBodies) {
    const stem = openerStem(prior);
    if (stem.length > 0) counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n / recentBodies.length >= maxShare)
    .toSorted((a, b) => b[1] - a[1])
    .map(([stem]) => stem);
}

export function lintOpenerFrequency(
  body: string,
  recentBodies: readonly string[],
  opts: { minSample?: number; maxShare?: number } = {},
): string[] {
  const stem = openerStem(body);
  if (stem.length === 0) return [];
  return overusedOpeners(recentBodies, opts).includes(stem) ? ["opener-overused"] : [];
}

/**
 * A run of 2+ consecutive uppercase letters normally reads as shouting
 * (the humanizer's own rule: "lowercase the whole subject line ... acronyms
 * (`api` not `API`)"). But a token shaped like a SAM.gov solicitation number
 * — hyphen-separated alphanumeric segments such as `W912DY-26-R-0042` — is an
 * identifier the play is REQUIRED to reproduce verbatim
 * (packages/prompts/sources-sought-email.md line 11/20), not a shouted word
 * choice. Exempt only that hyphenated identifier shape so a compliant
 * sources-sought subject doesn't get flagged and held from the guarded send
 * path (finding PRRT_kwDOSKzrBs6ewQdB).
 *
 * round-2 correction: exempting ANY token with a letter+digit mix (regardless
 * of hyphens) let plain shouty promo tokens like "SAVE20NOW" or "URGENT2"
 * slip past. round-3 correction (finding PRRT_kwDOSKzrBs6ewQdB, round 3):
 * even WITH the hyphen-count guard, a purely alphabetic shouty phrase written
 * with hyphens instead of spaces — "SAVE-20-NOW" — still matched, because the
 * regex only checked segment SHAPE (alphanumeric), not that at least one
 * segment carries digits the way a real SAM.gov solicitation number's suffix
 * segments do. round-4 correction (finding PRRT_kwDOSKzrBs6ewQdB, round 4):
 * the round-3 fix required the final segment to be all-digits, but real
 * SAM.gov/DoD PIID serial segments can be alphanumeric — e.g.
 * `N00164-24-Q-GR04` (final segment `GR04`) or a multi-segment procurement
 * type such as `N00164-26-RFPREQ-CR-JXN-0036`. Match the real shape: a
 * leading alphanumeric agency code, a 2-digit fiscal year, one or more
 * alphabetic procurement-type segments, then a final alphanumeric serial
 * segment that carries at least one digit (so a purely alphabetic phrase like
 * "SAVE-20-NOW" still fails to match and stays flagged as shouty).
 */
const SOLICITATION_NUMBER_RE =
  /^[A-Za-z0-9]{4,8}-\d{2}(?:-[A-Za-z]{1,8})*-[A-Za-z0-9]{0,6}\d[A-Za-z0-9]{0,6}$/;

function subjectShouty(subject: string): boolean {
  return subject.split(/\s+/).some((token) => {
    return !SOLICITATION_NUMBER_RE.test(token) && /[A-Z]{2,}/.test(token);
  });
}

export function lintEmail(subject: string, body: string, maxBodyWords = 110): string[] {
  const flags: string[] = [];
  if (subject.length === 0) flags.push("empty-subject");
  if (subject.length > 60) flags.push("subject-too-long");
  if (subjectShouty(subject)) flags.push("subject-shouty");
  if (body.length === 0) flags.push("empty-body");
  if (bodyWordsForLint(body) > maxBodyWords) flags.push("body-too-long");
  if (body.includes("—")) flags.push("em-dash");
  if (/[“”‘’]/.test(body)) flags.push("curly-quotes");
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(body)) flags.push("emoji");
  for (const [re, label] of SLOP_PHRASES) {
    if (re.test(body)) flags.push(label);
  }
  if (/(\b\w+\b),\s+(\b\w+\b),\s+and\s+\b\w+\b/.test(body)) flags.push("rule-of-three");
  if ((body.match(/!/g) ?? []).length > 1) flags.push("excess-exclamations");
  if (body.toLowerCase().includes("calendly")) flags.push("calendar-link");
  if (citesPublicRecordLeverage(`${subject}\n${body}`)) flags.push("public-record-leverage");
  return flags;
}

/**
 * A public record (health inspection, license status, registration) may
 * establish RELEVANCE, never LEVERAGE — see issue #460's copy guardrail. A
 * draft that opens on a failed inspection, a violation, a score, or a
 * lapsed/revoked licence is both a bad look and the fastest way to burn a
 * sending domain, so it's held here where a rule can't be talked out of it
 * rather than trusted to prompt text alone.
 *
 * Deliberately broad and word-based (not tied to any one finder's payload
 * shape): the guard has to hold regardless of which registry/adapter fed the
 * draft, including ones that don't exist yet.
 */
export function citesPublicRecordLeverage(body: string): boolean {
  return (
    /\b(?:failed|flunked)\s+(?:your\s+|the\s+|a\s+|an\s+)?(?:health\s+)?inspections?\b/i.test(
      body,
    ) ||
    /\b(?:inspection|health)\s+(?:scores?|grades?)\b/i.test(body) ||
    // Bare `/\bviolation\b/` also flagged legitimate non-leverage copy like
    // "we help teams avoid compliance violations" (finding
    // PRRT_kwDOSKzrBs6exPH6) — a violation only reads as public-record
    // LEVERAGE when the copy points at a specific one on record (cited,
    // reported, flagged, found, noted), in either word order.
    /\b(?:cit(?:e|es|ed|ation)|report(?:ed)?|flagged|found|noted)\b[\s\S]{0,60}\bviolation(?:s)?\b/i.test(
      body,
    ) ||
    /\bviolation(?:s)?\b[\s\S]{0,60}\b(?:cit(?:e|es|ed|ation)|report(?:ed)?|flagged|found|noted)\b/i.test(
      body,
    ) ||
    /\b(?:licen[sc]e|permit|registration)s?\s+(?:lapsed|expired|revoked|suspended)\b/i.test(body) ||
    // Adjective-first phrasing ("expired permit", "revoked license") reused
    // the SAME state alternation the noun-first check above uses, instead of
    // matching only `lapsed` — the other three states passed the guardrail
    // reversed (finding PRRT_kwDOSKzrBs6fCBd-). Plural nouns ("licenses",
    // "permits", "registrations") added alongside plural inspections/scores
    // above — the singular-only regexes missed "failed inspections",
    // "inspection scores", and "expired licenses" (shipped-regression
    // finding on PR #473).
    /\b(?:lapsed|expired|revoked|suspended)\s+(?:licen[sc]e|permit|registration)s?\b/i.test(body)
  );
}

export interface DraftedEmail {
  subject: string;
  body: string;
}

/**
 * Stub drafted-row for a target whose per-target processing threw, so the rest
 * of the batch keeps going. Same shape `drain.ts` synthesizes — one source of
 * truth for the error envelope.
 */
interface ErrorDraft {
  subject: string;
  body: string;
  flags: string[];
  sent: boolean;
  receiptIds: number[];
}
export function errorDraft(message: string | null | undefined): ErrorDraft {
  const msg = (message ?? "play failed").slice(0, 80);
  return {
    subject: "(error)",
    body: "",
    flags: [`error: ${msg}`],
    sent: false,
    receiptIds: [],
  };
}

/**
 * Record WHY a single target failed, next to every `errorDraft` call site: the
 * queue row only carries an 80-char message slice, while the SDK error's status
 * code and response body hold the actual reason. Without this a failed drain
 * leaves nothing in events.jsonl to diagnose from.
 */
export function logTargetError(input: {
  playName: string;
  /**
   * Recipient address. Only its DOMAIN is logged — events.jsonl is a PII-free
   * sink. Redaction lives here, not at call sites, so no caller can leak the
   * address by accident.
   */
  to?: string | null;
  err: unknown;
}): void {
  const e = input.err as Error & {
    cause?: unknown;
    statusCode?: number;
    responseBody?: string;
  };
  // Nothing here may throw: this runs INSIDE the per-target catch, so a
  // TypeError while logging would abort the entire drain. Thrown values are
  // `unknown` — coerce, don't assume.
  try {
    logTargetErrorUnsafe(e, input);
  } catch {
    // A hostile shape must not turn a logged failure into a dead batch.
  }
}

/** Coerce an unknown thrown field to a string — never assume `.slice()` exists. */
function text(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function logTargetErrorUnsafe(
  e: Error & { cause?: unknown; statusCode?: number; responseBody?: string },
  input: { playName: string; to?: string | null },
): void {
  const causeMsg =
    e?.cause instanceof Error ? text(e.cause.message) : e?.cause ? text(e.cause) : null;
  logEvent(
    "play.target_error",
    {
      play: input.playName,
      ...(typeof input.to === "string" && input.to.includes("@")
        ? { to_domain: input.to.split("@")[1] }
        : {}),
      message_200: text(e?.message).slice(0, 200),
      // OneShot SDK ToolError carries the failing call's HTTP status + server
      // response body — the real reason, vs the generic message.
      status_code: typeof e?.statusCode === "number" ? e.statusCode : null,
      response_body_400: typeof e?.responseBody === "string" ? e.responseBody.slice(0, 400) : null,
      cause_200: causeMsg ? causeMsg.slice(0, 200) : null,
      stack_300: text(e?.stack).slice(0, 300),
    },
    "error",
  );
}

/**
 * Deterministic, semantics-preserving cleanups the LLM occasionally slips
 * through. Applied silently inside `draftEmailFromPrompt` so these flags
 * never surface in the UI.
 */
export function humanizeDraft(input: DraftedEmail): DraftedEmail {
  return {
    subject: applyAutofixes(input.subject),
    body: applyAutofixes(input.body),
  };
}

function applyAutofixes(s: string): string {
  return (
    s
      // Collapse only horizontal whitespace around the em-dash. Using `\s*`
      // here would eat a trailing newline when an em-dash ends a paragraph,
      // silently merging paragraphs.
      .replace(/[ \t]*—[ \t]*/g, ", ")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      // Emoji ranges: main BMP+SMP block, dingbats, and the regional-
      // indicator pair used for country flags (🇺🇸 = 1F1FA + 1F1F8).
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, "")
      // Variation-selector + ZWJ stripped in a second pass — leaving them
      // would produce a dangling glyph after the emoji itself is gone
      // (e.g. `☀️` → `️`).
      .replace(/\u{FE0F}|\u{200D}/gu, "")
      .replace(/!\s*!+/g, "!")
      // Strip trailing horizontal whitespace left by em-dash/emoji removal.
      .replace(/[ \t]+\n/g, "\n")
      .trim()
  );
}

/**
 * Binding sign-off directive appended to every email system prompt. Returns ""
 * when no domain is configured (name-only sign-off). Loaded fresh each call so
 * a /setup change takes effect without a process restart.
 */
export function signatureDirective(): string {
  const cfg = loadConfig();
  const domain = (cfg.productDomain ?? "").trim();
  if (!domain) return "";
  const name = (cfg.founderName ?? "").trim() || "[founder name]";
  const mobile = cfg.mobileSignature === true;
  const sigLines = [name, domain];
  if (mobile) sigLines.push("Sent from my iPhone");
  return [
    "",
    "",
    "## Signature (binding — overrides any sign-off rule above)",
    mobile
      ? "End the email with the founder's name, then their domain, then a literal 'Sent from my iPhone' line. Three lines total, in this order:"
      : "End the email with the founder's name, then their domain on the very next line:",
    "",
    ...sigLines,
    "",
    `Always include the domain line, even if a rule above says "no links" or "no tagline" — a bare domain beneath the name is the signature, not an inline link. Write it plain: no "https://", no "www.", no hyperlink, no text after it.`,
    ...(mobile
      ? [
          `The "Sent from my iPhone" line is a literal proof-of-human artifact. Always exactly that string, no variation, no quotes.`,
        ]
      : []),
  ].join("\n");
}

/**
 * SOCIAL PROOF input block from the founder's three optional config fields.
 * Null when none are set, so the prompt's conditional skips the beat. At most
 * ONE beat per email, never stacked.
 */
export function socialProofBlock(): string | null {
  const cfg = loadConfig();
  const lines: string[] = [];
  const cred = cfg.founderCredentials?.trim();
  const built = cfg.productPortfolio?.trim();
  const partners = cfg.partners?.trim();
  if (cred) lines.push(`CREDENTIALS: ${cred}`);
  if (built) lines.push(`PORTFOLIO: ${built}`);
  if (partners) lines.push(`PARTNERS: ${partners}`);
  if (lines.length === 0) return null;
  return [
    "SOCIAL PROOF (pick the ONE beat that best fits this play — CREDENTIALS for founder-trust, PORTFOLIO for peer-founder, PARTNERS for brand-recognition; never stack two):",
    ...lines,
  ].join("\n");
}

/**
 * ADMISSION line for the prompt's damaging-admission beat — surfaced only when
 * the founder set one AND this prospect drew the slot, so the model can never
 * invent a weakness. The roughly-1-in-3 cap lives HERE, not in the prompt: a
 * model cannot hold a frequency across independent calls. Keyed on the
 * prospect so a regenerate makes the same decision instead of flapping.
 */
export function admissionBlock(prospectEmail: string): string | null {
  const admission = loadConfig().founderAdmission?.trim();
  if (!admission || !admissionSlot(prospectEmail)) return null;
  return `ADMISSION (a true concession about the sender; use it in THIS email, inside the Identity beat, rephrased but never extended): ${admission}`;
}

/** Stable per-prospect draw: true for roughly one in three addresses. */
export function admissionSlot(prospectEmail: string): boolean {
  let h = 0;
  for (const ch of prospectEmail.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 3 === 0;
}

export async function draftEmailFromPrompt(opts: {
  promptName: string;
  inputBlock: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<DraftedEmail> {
  const system = loadPrompt(opts.promptName) + signatureDirective();
  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: opts.inputBlock },
    ],
    temperature: opts.temperature ?? 0.65,
    maxTokens: opts.maxTokens ?? 500,
  });
  return humanizeDraft(parseSubjectBody(res.content));
}

function parseSubjectBody(raw: string): DraftedEmail {
  const parsed = tryParseJsonObject<{ subject?: string; body?: string }>(raw, {});
  return {
    subject: (parsed.subject ?? "").trim(),
    body: (parsed.body ?? "").trim(),
  };
}

export interface SendDraftedOpts {
  playName: string;
  to: string;
  draft: DraftedEmail;
  flags: string[];
  prospectMeta: {
    name?: string | null;
    email?: string | null;
    company?: string | null;
    linkedin_url?: string | null;
    phone?: string | null;
    source?: string | null;
    /** Profile URL the finder sourced this person from (GitHub / X / Luma).
     *  Never repurposed, so it survives as a re-enrichment key when the
     *  LinkedIn lookup misses. */
    source_profile_url?: string | null;
    /** Job title at contact time, from the person-level ICP gate. */
    title?: string | null;
    /** Research the play assembled for this person while drafting. Persisted so
     *  the reply drafter's free Tier-1 read (_reply-research.ts) has something
     *  to use — before this it was always empty and every reply draft paid for
     *  enrich + webRead again. Read as TEXT, never parsed. */
    dossier_json?: string | null;
  };
  metadata?: Record<string, unknown>;
  dryRun: boolean;
  /**
   * Allow a first-touch even if another play already touched the prospect.
   * Off by default; only breakup-revive sets this.
   */
  allowRecontact?: boolean;
  /** Manual override of the cross-workspace `contacted-elsewhere` hold (queue send-draft only). */
  allowContactedElsewhere?: boolean;
}

export interface SendDraftedResult {
  receiptIds: number[];
  sent: boolean;
}

export async function sendDraftedEmail(opts: SendDraftedOpts): Promise<SendDraftedResult> {
  const ledger = getLedger();
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const receiptIds: number[] = [];
  let sent = false;
  if (!opts.dryRun && opts.flags.length === 0) {
    // Pre-send dedupe: never send step-0 twice to the same (prospect, play).
    // Residual microsecond race between this read and recordSequenceEvent is
    // accepted.
    const existing = ledger.findProspectByEmail(opts.to);
    if (existing) {
      const prior = ledger.listSequenceEventsForProspectPlay(existing.id, opts.playName);
      if (prior.some((e) => e.step_index === 0)) {
        opts.flags.push("already-enrolled");
        return { receiptIds: [], sent: false };
      }
      // Cross-play guard: never first-touch someone a DIFFERENT play already
      // first-touched. breakup-revive opts out.
      if (!opts.allowRecontact && ledger.prospectHasFirstTouch(existing.id)) {
        opts.flags.push("already-contacted");
        return { receiptIds: [], sent: false };
      }
    }
    // Track as in-flight for the WHOLE send-and-record span (SDK call →
    // sequence_events row), so a graceful shutdown drains it before exiting and
    // never leaves a sent-but-unrecorded email the dedup can't see.
    const receiptId = await trackSend(async () => {
      const send = await sendEmail(
        {
          to: opts.to,
          ...(opts.allowContactedElsewhere ? { allowContactedElsewhere: true } : {}),
          subject: opts.draft.subject,
          body: opts.draft.body,
        },
        {
          playName: opts.playName,
          memo: `${opts.playName} step 0 → ${opts.to}`,
          decisionContext: {
            source: "play.initial",
            goalId: cadenceGoalId(opts.playName, opts.to),
            prospectEmail: opts.to,
            prospectName: opts.prospectMeta.name ?? null,
            company: opts.prospectMeta.company ?? null,
            subject: opts.draft.subject,
          },
        },
      );
      const prospectId = ledger.upsertProspect(opts.prospectMeta);
      ledger.recordSequenceEvent({
        prospectId,
        playName: opts.playName,
        stepIndex: 0,
        channel: "email",
        status: "sent",
        receiptId: send.receiptId,
        metadata: { subject: opts.draft.subject, body: opts.draft.body, ...opts.metadata },
      });
      return send.receiptId;
    });
    receiptIds.push(receiptId);
    sent = true;
  }
  return { receiptIds, sent };
}

export function receiptUrls(receiptIds: number[]): string[] {
  return receiptIds.map(receiptUrlForId);
}

/** Domain portion of an email address, or undefined if it has no `@`. */
export function emailDomain(email: string): string | undefined {
  const at = email.indexOf("@");
  if (at < 0) return undefined;
  return email.slice(at + 1);
}

const HONORIFIC_TOKENS = new Set([
  "dr.",
  "dr",
  "mr.",
  "mr",
  "mrs.",
  "mrs",
  "ms.",
  "ms",
  "prof.",
  "prof",
  "sr.",
  "sr",
  "jr.",
  "jr",
  // "Md. Naimur Rahman" — Mohammed, abbreviated; common in South Asian names.
  "md.",
  "md",
  "eng.",
  "eng",
  "ir.",
  "sir",
]);

// An opening token that is a role or mailbox, not a person. "Hey CEO," went
// out once; that is the bar for this list.
const ROLE_TOKENS = new Set([
  "ceo",
  "cto",
  "cfo",
  "coo",
  "cmo",
  "cpo",
  "vp",
  "founder",
  "cofounder",
  "co-founder",
  "owner",
  "admin",
  "administrator",
  "info",
  "hello",
  "hi",
  "hey",
  "team",
  "support",
  "sales",
  "contact",
  "marketing",
  "staff",
  "hr",
  "user",
  "guest",
  "test",
  "noreply",
  "no-reply",
  "null",
  "none",
  "unknown",
  "na",
  "n/a",
]);

// A token anywhere in the name that says "this is a company, not a person".
// Deliberately excludes words that are also first names ("Dev", "Prince").
const ORG_TOKENS = new Set([
  "inc",
  "inc.",
  "llc",
  "ltd",
  "ltd.",
  "gmbh",
  "corp",
  "corp.",
  "co.",
  "labs",
  "lab",
  "team",
  "group",
  "studio",
  "studios",
  "technologies",
  "software",
  "solutions",
  "systems",
  "ventures",
  "capital",
  "agency",
  "company",
]);
const ORG_SUFFIX_RE = /(labs?|team|studios?|\.(dev|ai|io|com|app|xyz|net|org|co))$/i;

/**
 * Best-effort first-name extraction from a prospect's `name` field. Returns
 * `null` whenever a greeting shouldn't be used (handle, company, role word,
 * initial, non-capitalized token) — a wrong greeting is worse than none. The
 * LLM owns the decision to actually greet; this helper only gates whether
 * `PROSPECT_FIRST_NAME` is present in the input block.
 */
export function firstNameFrom(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed === "(unknown)") return null;
  const tokens = trimmed.split(/\s+/);

  // Company, not a person: any org word anywhere ("Bytedance Inc.", "Megabyte
  // Labs") or a glued org/domain suffix ("MyriaLabs", "Arcade.dev").
  if (tokens.some((t) => ORG_TOKENS.has(t.replace(/,$/, "").toLowerCase()))) return null;
  if (tokens.some((t) => ORG_SUFFIX_RE.test(t.replace(/,$/, "")))) return null;

  let i = 0;
  while (i < tokens.length && HONORIFIC_TOKENS.has(tokens[i]!.toLowerCase())) {
    i++;
  }
  let first = tokens[i]?.replace(/,$/, "");
  if (!first) return null;

  // "LAST, First" — the comma marks the family name; greet with what follows.
  if (tokens[i]!.endsWith(",") && tokens[i + 1]) first = tokens[i + 1]!.replace(/,$/, "");

  if (ROLE_TOKENS.has(first.toLowerCase())) return null;
  // Handles carry digits; names don't ("Kiyotaka29", "n3on").
  if (/\d/.test(first)) return null;
  // An initial is not a greeting ("J. Eduardo", "K.O", "Mrs. J Doe").
  if (/^[A-Za-z]\.?$/.test(first) || /^[A-Z]\.[A-Z]\.?$/.test(first)) return null;
  // Dotted pair "Wei.Jiang" — greet with the half before the dot.
  const dotted = first.match(/^([A-Z][a-z]+)\.[A-Z][a-z]+$/);
  if (dotted) first = dotted[1]!;

  // ALL CAPS: a whole name shouted ("JAGADISH SUNIL PEDNEKAR") is a name with
  // the shift key stuck — title-case it. A lone shouted token ("KEVINWONG",
  // "KERNEL", "CEO") is a handle or a word, not a greeting. Two letters ("KC")
  // read as a nickname and pass through as written.
  if (/^[A-Z]{3,}$/.test(first)) {
    const allShouted = tokens.slice(i).every((t) => /^[A-Z]+\.?,?$/.test(t));
    if (tokens.length - i < 2 || !allShouted) return null;
    first = first[0]! + first.slice(1).toLowerCase();
  }

  // Handle-looking inputs ("schen", "samaralihussain") almost always come from
  // a finder pre-screen failure; greeting "Hey schen," is worse than no greeting.
  if (!/^[A-Z]/.test(first)) return null;
  return first;
}

interface VerifyAndFilterResult<T> {
  verified: T[];
  dropped: Array<{ target: T; email: string; reason: string; index?: number }>;
  receiptIds: number[];
  costUsd: number;
}

/**
 * Verify a batch of target emails BEFORE drafting + sending, for direct-input
 * entry points (CLI motion commands + dashboard /run). Skips on dryRun and
 * empty input; de-dupes verifyEmail calls so duplicates don't double-bill.
 * Finder-sourced rows through /queue → drain do NOT call this — they were
 * verified at enqueue time.
 *
 * `signal` is the run's cancellation signal: the whole batch fires in one
 * Promise.all, so the boundary that matters is the one before it — a run
 * cancelled during the pre-flight buys no verifications at all.
 */
export async function verifyAndFilterTargets<T>(
  targets: T[],
  getEmail: (target: T) => string | null | undefined,
  opts: { playName: string; dryRun: boolean; signal?: AbortSignal },
): Promise<VerifyAndFilterResult<T>> {
  throwIfCancelled(opts.signal, `${opts.playName} verify`);
  if (opts.dryRun || targets.length === 0) {
    return { verified: targets, dropped: [], receiptIds: [], costUsd: 0 };
  }

  const emailFor = new Map<T, string>();
  for (const t of targets) {
    const e = (getEmail(t) ?? "").trim().toLowerCase();
    if (e.length > 0) emailFor.set(t, e);
  }

  const uniqueEmails = [...new Set(emailFor.values())];
  // Catch SDK throws and drop the affected target rather than aborting the
  // whole run — one bad verify call shouldn't kill the batch.
  const verifications = await Promise.all(
    uniqueEmails.map(async (email) => {
      try {
        const r = await verifyEmail({ email }, { playName: opts.playName });
        return {
          email,
          deliverable: Boolean(r.result.deliverable),
          receiptId: r.receiptId,
          costUsd: r.result.cost ?? 0,
          errored: false as const,
        };
      } catch (err) {
        return {
          email,
          deliverable: false,
          receiptId: 0,
          costUsd: 0,
          errored: true as const,
          message: ((err as Error).message ?? "verify failed").slice(0, 120),
        };
      }
    }),
  );
  const byEmail = new Map(verifications.map((v) => [v.email, v]));

  const verified: T[] = [];
  const dropped: VerifyAndFilterResult<T>["dropped"] = [];
  let costUsd = 0;
  const receiptIds: number[] = [];
  for (const v of verifications) {
    costUsd += v.costUsd;
    if (v.receiptId > 0) receiptIds.push(v.receiptId);
  }

  let i = 0;
  for (const t of targets) {
    const email = emailFor.get(t);
    if (!email) {
      dropped.push({ target: t, email: "", reason: "missing email", index: i });
      i++;
      continue;
    }
    const v = byEmail.get(email);
    if (!v) {
      dropped.push({ target: t, email, reason: "undeliverable", index: i });
      i++;
      continue;
    }
    if (v.errored) {
      dropped.push({ target: t, email, reason: `verify-error: ${v.message}`, index: i });
      i++;
      continue;
    }
    if (!v.deliverable) {
      dropped.push({ target: t, email, reason: "undeliverable", index: i });
      i++;
      continue;
    }
    verified.push(t);
    i++;
  }

  return { verified, dropped, receiptIds, costUsd };
}
