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
  trackSend,
  verifyEmail,
  withDeadline,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

/** The shape safeEnrich returns when enrichment failed (live or negative-cached). */
const FAILED_ENRICH = { status: "failed", profile: null, cost: 0 };

/**
 * enrichProfile that (a) never throws and (b) caches by email. The dossier is a
 * nice-to-have for drafting, the SDK call is slow (~70s) and billed, and the
 * same person can recur across plays / repeated previews / re-sends — so we
 * cache the result by email (TTL) and reuse it. A cache hit returns receiptId 0
 * (no new SDK call, no spend). On failure: log a warn and return an empty
 * result so callers' `enr.result` / `enr.receiptId` usage keeps working.
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
      // Negative entry: the SDK job failed recently — don't burn another ~70s
      // attempt; draft from payload context. Expired failures fall through
      // and retry below.
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
    // transient platform/transport error (e.g. "Tool execution failed" during
    // the 2026-06 outage) must NOT be cached, or every email it touched stays
    // un-enrichable for ENRICH_FAILURE_TTL_MS even after the platform recovers.
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
  [/\bWorth a 15.?min\b/i, "banned-cta:worth-15-min"],
  [/\bMind if I\b/i, "banned-cta:mind-if-i"],
  [/\bJust wanted to\b/i, "banned-filler:just-wanted-to"],
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
 * Trailing signature lines that the signatureDirective forces the LLM to
 * append (founder name, then product domain, then optional "Sent from my
 * iPhone"). Returned in last-line-first order so callers can peel from the
 * end. Empty when neither name nor domain is configured (no sig to strip).
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
 * Word count for body-too-long lint. Strips the trailing signature lines so
 * the LLM isn't penalized for the 2-3 deterministic words the
 * signatureDirective forces it to append. Otherwise a prompt that says "≤110
 * words" only really gives the LLM ~107 for content, and borderline drafts
 * trip body-too-long even when they're inside the contract.
 *
 * `sigLines` (last-line-first order) is exposed for tests so they don't have
 * to mock loadConfig — production passes nothing and reads config.
 */
export function bodyWordsForLint(body: string, sigLines?: string[]): number {
  const lines = sigLines ?? configuredSigLines();
  let trimmed = body.replace(/\s+$/, "");
  // Peel each sig line off the tail, but only if it matches the current
  // last line — guarantees we never chop content that happens to contain
  // the founder's name mid-paragraph.
  for (const line of lines) {
    const i = trimmed.lastIndexOf("\n");
    const last = (i < 0 ? trimmed : trimmed.slice(i + 1)).trim();
    if (last !== line) break;
    trimmed = trimmed.slice(0, i < 0 ? 0 : i).replace(/\s+$/, "");
  }
  return trimmed.split(/\s+/).filter(Boolean).length;
}

export function lintEmail(subject: string, body: string, maxBodyWords = 110): string[] {
  const flags: string[] = [];
  if (subject.length === 0) flags.push("empty-subject");
  if (subject.length > 60) flags.push("subject-too-long");
  if (/[A-Z]{2,}/.test(subject)) flags.push("subject-shouty");
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
  return flags;
}

export interface DraftedEmail {
  subject: string;
  body: string;
}

/**
 * Stub drafted-row for a target whose per-target processing threw (LLM API
 * error, SDK JobTimeoutError, ledger write failure, etc.). Plays wrap their
 * per-target body in try/catch and push this on failure so the rest of the
 * batch can keep going. Same shape `drain.ts` synthesizes when its outer
 * `dispatchOneTarget` catches — one source of truth for the error envelope.
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
 * Record WHY a single target failed, next to every `errorDraft` call site.
 *
 * What reaches the queue row (and the founder's screen) is errorDraft's 80-char
 * slice of `err.message` — for an SDK ToolError that's the generic "Tool
 * request failed", true and useless. The status code and response body carry
 * the actual reason (`403 domain_not_owned`, the last time one was captured).
 * Without this, a drain could fail every send and leave nothing in
 * events.jsonl to diagnose from.
 *
 * Mirrors the whole-run handler in apps/server/src/api/run.ts, which already
 * logs these fields; per-target failures were the gap.
 */
export function logTargetError(input: {
  playName: string;
  /**
   * Recipient address. Only its DOMAIN is logged — events.jsonl is a
   * PII-free sink (see the `email_domain` precedent in core/send-routing.ts),
   * and the domain is the diagnostic half anyway: it tells you whether one
   * receiving domain is rejecting. Redaction lives here, not at the call
   * sites, so no caller can leak the address by accident.
   */
  to?: string | null;
  err: unknown;
}): void {
  const e = input.err as Error & {
    cause?: unknown;
    statusCode?: number;
    responseBody?: string;
  };
  // Nothing here may throw. This runs INSIDE the per-target catch whose whole
  // job is to stop one bad target from killing the batch — a TypeError raised
  // while logging would escape that catch and abort the entire drain. A thrown
  // value is `unknown`: `{ message: 500 }` is legal, so is a rejected string,
  // and `.slice()` on either blows up. Coerce, don't assume.
  try {
    logTargetErrorUnsafe(e, input);
  } catch {
    // Belt and braces: a hostile shape (a throwing `message` getter, a
    // String()-hostile object) must not turn a logged failure into a dead
    // batch. Losing the diagnosis is bad; losing the run is worse.
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
 * Deterministic, semantics-preserving cleanups that the LLM occasionally
 * slips through despite the humanizer rules being in its system prompt.
 * Applied silently inside `draftEmailFromPrompt` so these four flags never
 * surface in the UI.
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
      // Strip trailing horizontal whitespace before a newline. Catches the
      // `paragraph,_\n` artifact left by an em-dash at end-of-line, plus
      // any stray trailing space from emoji removal.
      .replace(/[ \t]+\n/g, "\n")
      .trim()
  );
}

/**
 * Binding sign-off directive appended to every email system prompt. Forces
 * the founder's product domain onto its own line beneath their name, even on
 * prompts that say "no links / no tagline" (a bare domain is a signature, not
 * a hyperlink). Returns "" when no domain is configured, so founders who
 * haven't set one keep the prior name-only sign-off. Loaded fresh each call
 * so a /setup change takes effect without a process restart.
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
 * Build a SOCIAL PROOF input block from the founder's three optional config
 * fields. Returns null when none are set — callers skip the line entirely
 * so the prompt's "if SOCIAL PROOF is in the inputs" conditional kicks in.
 * Each prompt should weave AT MOST ONE beat (credentials OR built-with OR
 * partners) into the email, not stack them.
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
 * ADMISSION line for the prompt's optional damaging-admission beat — a true
 * concession, surfaced only when the founder set one AND this prospect drew
 * the slot. The prompt is told to use ONLY what this line carries and to skip
 * the beat when it is absent, so the model can never invent a weakness (the
 * same lie as inventing a strength).
 *
 * The "roughly a third of emails" cap lives HERE, not in the prompt: a model
 * cannot hold a frequency across independent calls (given "at most 1 in 3" it
 * used the admission on 3 of 4 drafts, the same way the optional "Hey {name}"
 * opener runs at 4 of 4). Gating whether the material is supplied is the only
 * honest way to get the rate — and it is keyed on the prospect, so a
 * regenerate makes the same decision instead of flapping.
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
     *  Unlike `linkedin_url` this is never repurposed, so it survives as a
     *  re-enrichment key when the LinkedIn lookup misses on the first pass. */
    source_profile_url?: string | null;
    /** Job title at contact time, from the person-level ICP gate. Persisting
     *  it makes re-runs and the off-ICP audit free. (This field existing here
     *  is what makes it persistable at all — `dossier_json` stayed dead schema
     *  for months precisely because it was never added to this type.) */
    title?: string | null;
  };
  metadata?: Record<string, unknown>;
  dryRun: boolean;
  /**
   * Allow a first-touch even if the prospect was already touched by ANOTHER
   * play. Off by default (we never first-touch the same person twice). Only
   * breakup-revive sets this — deliberately re-contacting cold prospects is its
   * whole job, mirroring how its finder bypasses isDuplicate.
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
    // Pre-send dedupe: refuse to send step-0 a second time to the same
    // (prospect, play). Catches double-fire from drain-after-drain, /run
    // resubmits, two-tab races, etc. Residual race window is microseconds
    // between this read and recordSequenceEvent; documented as acceptable.
    const existing = ledger.findProspectByEmail(opts.to);
    if (existing) {
      const prior = ledger.listSequenceEventsForProspectPlay(existing.id, opts.playName);
      if (prior.some((e) => e.step_index === 0)) {
        opts.flags.push("already-enrolled");
        return { receiptIds: [], sent: false };
      }
      // Cross-play guard: never first-touch someone a DIFFERENT play already
      // first-touched. The authoritative dedup for the "same person queued
      // under two plays before either sent" race. breakup-revive opts out.
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
 * `null` when we shouldn't use a greeting at all: missing data, the placeholder
 * "(unknown)", a username-looking handle, a company name, a role or mailbox
 * word, an initial, or a non-capitalized opening token (which usually signals
 * a handle fragment rather than a real first name). A wrong greeting is worse
 * than none — "Hey CEO," and "Hey Bytedance," both shipped before this gate.
 *
 * Used to optionally surface `PROSPECT_FIRST_NAME` to the LLM input block so
 * prompts can occasionally open with `Hey {firstName},`. The LLM owns the
 * decision to actually greet — this helper just gates whether the field is
 * present.
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
  dropped: Array<{ target: T; email: string; reason: string }>;
  receiptIds: number[];
  costUsd: number;
}

/**
 * Verify a batch of target emails BEFORE drafting + sending. Used by
 * direct-input entry points (CLI motion commands + dashboard /run) where
 * the founder pastes targets directly without going through a finder.
 * Drops undeliverable rows so the caller skips ~$0.005-0.02 of LLM
 * drafting cost per bad email AND avoids the send attempt itself.
 *
 * Skips on dryRun (no real spend during preview) and on empty input.
 * De-dupes the underlying verifyEmail calls so a duplicated email in
 * the input doesn't double-bill.
 *
 * Finder-sourced rows that flow through /queue → drain do NOT call this
 * — they were already verified at finder enqueue time.
 */
export async function verifyAndFilterTargets<T>(
  targets: T[],
  getEmail: (target: T) => string | null | undefined,
  opts: { playName: string; dryRun: boolean },
): Promise<VerifyAndFilterResult<T>> {
  if (opts.dryRun || targets.length === 0) {
    return { verified: targets, dropped: [], receiptIds: [], costUsd: 0 };
  }

  const emailFor = new Map<T, string>();
  for (const t of targets) {
    const e = (getEmail(t) ?? "").trim().toLowerCase();
    if (e.length > 0) emailFor.set(t, e);
  }

  const uniqueEmails = [...new Set(emailFor.values())];
  // Catch SDK throws (transient network / rate-limit / invalid-format errors)
  // and treat the affected target as dropped rather than aborting the whole
  // run. Mirrors the per-candidate handling finders already do — one bad
  // verify call shouldn't kill a 25-target batch.
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

  for (const t of targets) {
    const email = emailFor.get(t);
    if (!email) {
      dropped.push({ target: t, email: "", reason: "missing email" });
      continue;
    }
    const v = byEmail.get(email);
    if (!v) {
      dropped.push({ target: t, email, reason: "undeliverable" });
      continue;
    }
    if (v.errored) {
      dropped.push({ target: t, email, reason: `verify-error: ${v.message}` });
      continue;
    }
    if (!v.deliverable) {
      dropped.push({ target: t, email, reason: "undeliverable" });
      continue;
    }
    verified.push(t);
  }

  return { verified, dropped, receiptIds, costUsd };
}
