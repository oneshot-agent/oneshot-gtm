import { getLedger, loadConfig, receiptUrlForId, sendEmail, verifyEmail } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

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

export function lintEmail(subject: string, body: string, maxBodyWords = 110): string[] {
  const flags: string[] = [];
  if (subject.length === 0) flags.push("empty-subject");
  if (subject.length > 60) flags.push("subject-too-long");
  if (/[A-Z]{2,}/.test(subject)) flags.push("subject-shouty");
  if (body.length === 0) flags.push("empty-body");
  if (body.split(/\s+/).length > maxBodyWords) flags.push("body-too-long");
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
      // Collapse surrounding spaces so `a — b` becomes `a, b`, not `a ,  b`.
      .replace(/\s*—\s*/g, ", ")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      // Strip emoji + the trailing variation-selector (U+FE0F) and ZWJ
      // (U+200D) that compound emoji rely on; otherwise `☀️` leaves a
      // dangling U+FE0F glyph behind. Two passes so the character class
      // doesn't form a combining sequence the linter flags.
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
      .replace(/\u{FE0F}|\u{200D}/gu, "")
      .replace(/!\s*!+/g, "!")
      .trim()
  );
}

export async function draftEmailFromPrompt(opts: {
  promptName: string;
  inputBlock: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<DraftedEmail> {
  const system = loadPrompt(opts.promptName);
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
  };
  metadata?: Record<string, unknown>;
  dryRun: boolean;
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
    const send = await sendEmail(
      { to: opts.to, subject: opts.draft.subject, body: opts.draft.body },
      { playName: opts.playName },
    );
    receiptIds.push(send.receiptId);
    const prospectId = ledger.upsertProspect(opts.prospectMeta);
    ledger.recordSequenceEvent({
      prospectId,
      playName: opts.playName,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: opts.draft.subject, ...opts.metadata },
    });
    sent = true;
  }
  return { receiptIds, sent };
}

export function receiptUrls(receiptIds: number[]): string[] {
  return receiptIds.map(receiptUrlForId);
}

export interface VerifyAndFilterResult<T> {
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
