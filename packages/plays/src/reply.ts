import { loadConfig, stripQuotedChain, angleBlockFromJson } from "@oneshot-gtm/core";
import { complete, type LlmMessage, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { getPriorStepsForProspect, type PriorStepRow } from "./_cadence.ts";
import {
  bodyWordsForLint,
  firstNameFrom,
  founderSteerBlock,
  humanizeDraft,
  intentDirectiveBlock,
  lintEmail,
  meetingBlock,
  signatureDirective,
} from "./_lib.ts";

// stripQuotedChain moved to core (reply-classify.ts) — the classifier needs it
// too. Re-exported so existing imports of this module keep working.
export { stripQuotedChain };

/** Mirror triage.ts's truncation — inbound bodies can be huge (quoted chains). */
const INBOUND_BODY_MAX = 2000;

/** Words in a body, quoted chain stripped — the unit both length rules use. */
function wordCount(text: string): number {
  return stripQuotedChain(text).split(/\s+/).filter(Boolean).length;
}

/**
 * Mirror-their-length word budget, tracking the ladder in reply-email.md (a
 * one-liner gets under 40 words back, a substantive message 40-90, a
 * substantive technical one up to 130) with a little headroom so the gate
 * fires on real overruns rather than on a draft landing a few words over.
 */
export function replyWordBudget(inboundBody: string): number {
  const words = wordCount(inboundBody);
  if (words <= 25) return 45;
  if (words <= 90) return 95;
  return 135;
}

/**
 * Longest run of words a draft may share with an email already in this thread.
 * The re-introduction that motivated this gate ("i previously shipped a zoom
 * competitor to 500k mau", lifted from the intro into the reply) walked past a
 * prose "do not re-introduce yourself" rule; an n-gram check does not care how
 * the model justified it.
 */
const REPEAT_NGRAM = 8;

function normalizeWords(text: string): string[] {
  return stripQuotedChain(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when the draft reuses REPEAT_NGRAM consecutive words from prior text. */
export function repeatsPriorText(body: string, priorTexts: readonly string[]): boolean {
  const draft = normalizeWords(body);
  if (draft.length < REPEAT_NGRAM) return false;
  const seen = new Set<string>();
  for (const text of priorTexts) {
    const words = normalizeWords(text);
    for (let i = 0; i + REPEAT_NGRAM <= words.length; i++) {
      seen.add(words.slice(i, i + REPEAT_NGRAM).join(" "));
    }
  }
  if (seen.size === 0) return false;
  for (let i = 0; i + REPEAT_NGRAM <= draft.length; i++) {
    if (seen.has(draft.slice(i, i + REPEAT_NGRAM).join(" "))) return true;
  }
  return false;
}

/**
 * A commitment pattern paired with how strictly it must be gated. Each entry
 * names one commitment shape; ANY match is one `commits-terms` flag, not one
 * per pattern — `replyPenalty` counts flags, and a draft that trips three of
 * these is not three times worse than one that trips one.
 *
 * `requireAffirmative`: some keywords (pricing, discount) show up just as
 * often in a neutral or declining sentence ("Our pricing is public, check
 * the website.") as in an actual commitment ("Sure, I can do a 20% discount
 * for the first year."). For those, a bare keyword match is not enough —
 * the sentence must also carry an affirmative commitment cue (can/could/
 * will/would/I'll/we'll/happy to/etc).
 */
interface CommitPattern {
  regex: RegExp;
  requireAffirmative?: boolean;
}

const COMMITS_TERMS_PATTERNS: CommitPattern[] = [
  // Pricing, discounts, free tiers. Bare mentions ("our pricing is public")
  // are common in ordinary, harmless replies — only count it when the same
  // sentence also affirmatively offers something.
  {
    regex: /\b(?:pric(?:e|es|ing)|discount(?:s|ed)?|% off|free tier|for free)\b/i,
    requireAffirmative: true,
  },
  // Distribution / traffic promises ("point our builders toward X", "route users to Y").
  // Round-2 correction (#480): a bare mention ("we read about your distribution
  // model") is as common as an actual promise — same affirmative-cue gate as pricing.
  {
    regex:
      /\bdistribution\b|\btraffic\b|\bpoint\b[^.]{0,60}\btoward\b|\brout(?:e|ing)\b[^.]{0,40}\b(?:users|traffic|customers|people)\b/i,
    requireAffirmative: true,
  },
  // Partnership / exclusivity language. Round-2 correction (#480): "thanks for
  // explaining the partnership, that makes sense" is not a commitment.
  { regex: /\bpartner(?:ship)?\b|\bexclusiv(?:e|ity)\b/i, requireAffirmative: true },
  // Roadmap dates. Round-2 correction (#480): "could you clarify your roadmap?"
  // is a question, not a commitment — gated the same way (QUESTION_CUE below
  // also strips the "could you"/"can you" phrasing the bare cue list would miss).
  {
    regex: /\broadmap\b|\bby (?:Q[1-4]\s?\d{0,4}|\d{4})\b|\bnext (?:quarter|month)\b/i,
    requireAffirmative: true,
  },
  // Headcount / hiring commitments. Round-2 correction (#480): "how is your
  // hiring going this quarter?" is small talk, not a commitment.
  { regex: /\bheadcount\b|\bhir(?:e|ing)\b/i, requireAffirmative: true },
  // Documentation placement ("adding X to our documentation").
  {
    regex: /\b(?:add(?:ing)?|list(?:ing)?)\b[^.]{0,60}\b(?:documentation|docs)\b/i,
    requireAffirmative: true,
  },
  // "Recommended / preferred partner" (or environment/integration/provider) designations.
  {
    regex:
      /\b(?:recommended|preferred)\b[^.]{0,40}\b(?:partner|environment|integration|provider|option|vendor|choice)\b/i,
    requireAffirmative: true,
  },
  // Featuring the sender in a reference implementation / case study / website.
  {
    regex:
      /\bfeatur(?:e|ing)\b[^.]{0,60}\b(?:reference implementation|case study|website|repo|documentation)\b/i,
  },
];

/** A sentence that declines, refuses, or is otherwise negative about its topic is not a commitment. */
const NEGATION_CUE = /\b(?:not|no|never|nobody|nothing|unable|cannot)\b|n['’]t\b/i;

/**
 * Trailing hedge idioms that use the word "no" without negating anything —
 * "no problem" / "no worries" acknowledge a commitment just made, they don't
 * retract it. Stripped before the negation check so `bodyCommitsTerms` can
 * check the whole sentence for real negations (round-2 correction, #558)
 * instead of a hand-rolled clause boundary that both let this idiom through
 * AND cut off genuine refusals elsewhere in the same sentence (see below).
 */
const TRAILING_HEDGE = /,?\s*no (?:problem|worries|issue|big deal)\b[.!?]?/gi;

/**
 * A sentence that affirmatively offers or agrees to something. Includes
 * "plan(ning) to" / "aim to" (round-2 correction, #480) so a founder stating a
 * roadmap intent ("we're planning to ship SSO by Q1") still counts as a
 * commitment — only the *question* form ("could you clarify your roadmap?")
 * is meant to fall through, and that's excluded separately by QUESTION_CUE.
 */
const AFFIRMATIVE_CUE =
  /\b(?:can|could|will|would|able to|happy to|glad to|going to|planning to|plan to|aim to|let's|sure)\b|['’]ll\b/i;

/**
 * A modal cue addressed AT the recipient ("could you", "can you", "would
 * you", "will you") — a question, never a commitment, even though it shares
 * the same modal verbs AFFIRMATIVE_CUE looks for ("we could hire someone" is
 * a commitment; "could you clarify your roadmap?" is not). Round-2
 * correction (#480): without this, "Could you clarify your roadmap?" still
 * tripped the roadmap pattern's affirmative-cue guard on the bare "could".
 */
const QUESTION_CUE = /\b(?:could|can|would|will)\s+you\b/i;

/** Body split into sentence-ish chunks — the unit `bodyCommitsTerms` reasons about, so a
 *  commitment made in one sentence can't be masked by a negation two sentences away. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True when the body makes (or looks like it's making) a commitment the
 * founder never authorised. `NEGATION_CUE` is checked against the WHOLE
 * sentence — matching main's original behaviour — after stripping
 * `TRAILING_HEDGE` idioms ("no problem"/"no worries"/etc), which use "no"
 * without negating anything.
 *
 * Round-3 correction (#480/#558) tried to fix "Sure, I can do a 20%
 * discount, no problem." (should stay `true`) by scoping the negation check
 * to the leading clause up to the next comma. Round-4 correction (#558) then
 * had to special-case the clause boundary again for a parenthetical aside
 * ("We will not, under any circumstances, offer a discount." — the
 * comma-delimited clause split "not" from "discount" and flipped this to
 * `true`). Round-2 correction (#558, THIS round): the clause-scoping
 * approach itself is unsound — ANY clause boundary drawn on commas cuts off
 * a genuine refusal that legitimately follows a comma in the same sentence
 * ("We can review pricing, but cannot offer a discount." regressed to
 * `true` against main's `false`). Stripping the specific hedge idiom instead
 * of truncating the sentence fixes the "no problem" false-negative without
 * narrowing the negation check's scope at all, so it can go back to
 * matching main: the whole sentence, no clause games.
 */
export function bodyCommitsTerms(body: string): boolean {
  const sentences = splitSentences(body);
  return COMMITS_TERMS_PATTERNS.some(({ regex, requireAffirmative }) =>
    sentences.some((sentence) => {
      if (!regex.test(sentence)) return false;
      const negationCheckText = sentence.replace(TRAILING_HEDGE, "");
      if (NEGATION_CUE.test(negationCheckText)) return false;
      if (requireAffirmative && (QUESTION_CUE.test(sentence) || !AFFIRMATIVE_CUE.test(sentence))) {
        return false;
      }
      return true;
    }),
  );
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()"'\]]+/gi;

/** Trailing punctuation and slashes never distinguish two links. */
function normalizeUrl(url: string): string {
  return url
    .replace(/[.,;:!?)]+$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** The links a reply may cite: every URL that appears in the product brief. */
export function briefUrls(brief: string | null | undefined): Set<string> {
  return new Set((brief?.match(URL_RE) ?? []).map(normalizeUrl));
}

/**
 * True when the body cites a URL that is not verbatim in the brief. The
 * prompt already says "only a URL that appears VERBATIM in PRODUCT BRIEF";
 * this is the check that holds when the model adapts a docs path anyway.
 * No brief means no link is allowed.
 */
export function citesLinkOutsideBrief(body: string, allowed: ReadonlySet<string>): boolean {
  return (body.match(URL_RE) ?? []).some((url) => !allowed.has(normalizeUrl(url)));
}

/**
 * Body-only lint: a reply keeps the inbound "Re: …", so subject flags are not
 * ours to raise — lintEmail gets a dummy subject and they're dropped.
 */
function lintReply(
  body: string,
  maxWords: number,
  priorTexts: readonly string[],
  allowedUrls: ReadonlySet<string>,
): string[] {
  const flags = lintEmail("x", body, maxWords).filter((f) => !f.startsWith("subject-"));
  if (repeatsPriorText(body, priorTexts)) flags.push("repeats-prior-email");
  if (bodyCommitsTerms(body)) flags.push("commits-terms");
  if (citesLinkOutsideBrief(body, allowedUrls)) flags.push("link-not-in-brief");
  return flags;
}

/**
 * How bad a draft is: flag count first, then how far over the word budget it
 * runs. The overage tiebreak matters — a repair that cuts 101 words to 60 is a
 * real improvement but still carries the single `body-too-long` flag, so
 * comparing flag counts alone would discard it and keep the worse draft.
 */
function replyPenalty(
  body: string,
  maxWords: number,
  priorTexts: readonly string[],
  allowedUrls: ReadonlySet<string>,
): [number, number] {
  const flags = lintReply(body, maxWords, priorTexts, allowedUrls);
  return [flags.length, Math.max(0, bodyWordsForLint(body) - maxWords)];
}

/** Lexicographic compare: true when `a` is strictly better than `b`. */
function better(a: [number, number], b: [number, number]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
}

/** Parse the model's JSON and apply the deterministic autofixes (em-dash,
 *  curly quotes, emoji) BEFORE linting — otherwise the gate burns a retry on
 *  what humanizeDraft already repairs. humanizeDraft wants a subject; the
 *  reply has none, so pass a dummy. */
function bodyFrom(raw: string): string {
  const parsed = tryParseJsonObject<{ body?: string }>(raw, {});
  const body = (parsed.body ?? "").trim();
  return body ? humanizeDraft({ subject: "x", body }).body : "";
}

/**
 * Sentences the founder already asked in this thread ("does that work for
 * you?", "what's the actual proposal here?") — extracted from every reply
 * already sent, so `draftInboxReply` can tell the model never to restate an
 * outstanding ask (issue #480, the Aladdin Aug 26/27 exchange: three
 * discovery questions in a row with no named purpose). A crude sentence
 * split on `.`/`?`/`!` is enough — this feeds a "don't repeat" instruction,
 * not a structured parse.
 */
export function priorAsks(threadSent: readonly { body: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of threadSent) {
    for (const raw of t.body.split(/(?<=[.?!])\s+/)) {
      const s = raw.trim();
      if (!s.endsWith("?")) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

export interface DraftInboxReplyInput {
  /** Normalized sender address of the inbound email. */
  fromEmail: string;
  /** Inbound subject (the reply keeps it as "Re: …" — only the body is drafted). */
  subject: string;
  /** Inbound plain-text body. */
  body: string;
  /** Prospect match, when the sender is a known prospect (name/company/play context). */
  matched?: {
    prospectId: number | null;
    name: string | null;
    company: string | null;
    playName: string | null;
  } | null;
  /**
   * Research about the sender — the prospect's stored dossier, or enrichment +
   * a read of their site gathered by the route. What lets the reply engage a
   * technical message with substance instead of curiosity questions.
   */
  dossier?: string | null;
  /**
   * Synthesized per-prospect angle JSON (issue #355), verbatim from
   * `prospects.angle_json`. Threaded through so the ANGLE block's
   * `doNotSay` can stop a reply re-asserting a premise the prospect already
   * corrected — the "not sure what you mean" / "starred for research"
   * cases. Missing/empty → no block, unchanged output (issue #356).
   */
  angleJson?: string | null;
  /**
   * The founder's most recently recorded outcome for this prospect's
   * calendar meeting(s) (issue #578) — a direct, structured fact from the
   * ledger, not inferred from prose. Only `held`/`no_show` render (a
   * cancelled/rescheduled meeting never happened, so there's nothing to
   * relay); the founder's optional pasted note is untrusted content to
   * reason from, never instructions to follow. Missing/null → no block,
   * unchanged output.
   */
  meeting?: { outcome: string; note: string | null; summary: string | null } | null;
  /** Replies the founder already sent in this thread (oldest first) — round 2+ must not repeat round 1. */
  threadSent?: Array<{ body: string; sentAt: string }>;
  /** The prospect's earlier inbound messages (oldest first) — the other half of the exchange. */
  priorInbound?: Array<{ body: string; subject: string | null; receivedAt: string }>;
  /** Sentiment classification of the inbound being answered (issue #480) — selects the intent directive block. */
  intent?: string | null;
  /** Founder's standing redraft instruction for this thread (issue #480) — binding on this draft. */
  steer?: string | null;
  /**
   * The ICP gate's call on this prospect (`prospects.icp_verdict` + reason):
   * title-based and made before the conversation. Rendered with the caveat
   * that the thread outranks it — a reject whose reply shows they build
   * agent systems is a stale verdict, not a reason to disengage. Missing or
   * null verdict → no line, unchanged output.
   */
  icp?: { verdict: string | null; reason: string | null } | null;
}

export interface DraftInboxReplyResult {
  body: string;
  /** Lint flags that survived the repair pass. Currently the only one the send gate cares about is `commits-terms`. */
  flags: string[];
}

/**
 * Draft a reply to an inbound prospect email, in the founder's voice. Same
 * scaffolding as cadence follow-ups (signature directive, social proof, prior
 * touches, humanizer autofixes) but answering THEIR message rather than
 * continuing a sequence. Returns the body plus any lint flags that survived
 * the repair pass — the subject stays "Re: …". Throws on LLM/provider
 * errors; the route maps that to a 4xx message.
 */
export async function draftInboxReply(input: DraftInboxReplyInput): Promise<DraftInboxReplyResult> {
  const cfg = loadConfig();
  const system = loadPrompt("reply-email") + signatureDirective();

  const prior: PriorStepRow[] =
    input.matched?.prospectId && input.matched.playName
      ? getPriorStepsForProspect(input.matched.prospectId, input.matched.playName).filter(
          (r) => r.body !== null && r.body.length > 0,
        )
      : [];
  const priorBlock =
    prior.length > 0
      ? [
          "PRIOR EMAILS (what you already sent this prospect — this is what they're replying to):",
          ...prior.flatMap((r) => [
            `--- step ${r.stepIndex} (${r.label}) ---`,
            `Subject: ${r.subject}`,
            r.body!,
          ]),
        ].join("\n")
      : null;

  // Round 2+ context: what you already answered in this thread, so a fresh
  // draft never repeats it (and can pick up where it left off).
  const threadBlock =
    input.threadSent && input.threadSent.length > 0
      ? [
          "THREAD — REPLIES YOU ALREADY SENT (do not repeat these; continue the conversation):",
          ...input.threadSent.flatMap((t) => [`--- sent ${t.sentAt} ---`, t.body]),
        ].join("\n")
      : null;

  // ASKS ALREADY MADE (issue #480): outstanding questions from your own prior
  // replies. An ask you've already made must be answered or waited on, never
  // restated — this is the "circling" half of the Aladdin failure.
  const asks = input.threadSent ? priorAsks(input.threadSent) : [];
  const asksBlock =
    asks.length > 0
      ? [
          "ASKS ALREADY MADE (from your own earlier replies in this thread — an outstanding ask is never restated; answer it yourself if they didn't, or wait, do not ask it again):",
          ...asks.map((a) => `- ${a}`),
        ].join("\n")
      : null;

  // The other half of the exchange: what THEY said before this message, so the
  // draft carries the conversation instead of treating each email as the first.
  const priorInboundBlock =
    input.priorInbound && input.priorInbound.length > 0
      ? [
          "THEIR EARLIER MESSAGES (what the prospect already told you — don't re-ask any of it):",
          // Newest 6, each capped at 1000 chars — a long exchange must not
          // grow the prompt without bound (the recent messages carry the
          // conversation; ancient ones add tokens, not context).
          ...input.priorInbound
            .slice(-6)
            .flatMap((m) => [
              `--- received ${m.receivedAt}${m.subject ? ` · ${m.subject}` : ""} ---`,
              stripQuotedChain(m.body).slice(0, 1000),
            ]),
        ].join("\n")
      : null;

  // Structured intent directive (issue #480) — code-gated per classified
  // sentiment, the same way admissionBlock/socialProofBlock are code-gated
  // rather than left to the model to infer "are they interested?" from prose.
  const intentBlock = intentDirectiveBlock(input.intent);
  // Founder steer (issue #480) — a binding redraft instruction from /inbox.
  const steerBlock = founderSteerBlock(input.steer);
  // MEETING (issue #578) — the direct outcome-to-draft path.
  const meetingBlockText = meetingBlock(input.meeting ?? null);

  // No SOCIAL PROOF block here, deliberately. It is an instruction ("pick the
  // ONE beat that best fits this play"), and in a reply it contradicts the
  // prompt's "do not re-introduce yourself or the product" — the credentials
  // and portfolio lines only render as a self-introduction, which the prospect
  // already read in the intro email. Social proof belongs in outbound drafts.
  const firstName = firstNameFrom(input.matched?.name ?? null);
  const angleBlock = angleBlockFromJson(input.angleJson);
  // ICP GATE — a free ledger fact, rendered with its caveat inline so the
  // model never reads a title-based reject as an instruction to disengage.
  const icpGateLine = input.icp?.verdict
    ? `ICP GATE (title-based, decided before this conversation; the thread outranks it): ${input.icp.verdict}${input.icp.reason ? ` - ${input.icp.reason}` : ""}`
    : null;
  const user = [
    `FOUNDER: ${cfg.founderName ?? "(unknown)"}`,
    `PRODUCT: ${cfg.productOneLiner ?? "(unknown)"}`,
    ...(cfg.icpOneLiner ? [`ICP: ${cfg.icpOneLiner}`] : []),
    `PROSPECT: ${input.matched?.name ?? "(unknown)"}`,
    `EMAIL: ${input.fromEmail}`,
    `COMPANY: ${input.matched?.company ?? "(unknown)"}`,
    ...(input.matched?.playName ? [`PLAY: ${input.matched.playName}`] : []),
    ...(icpGateLine ? [icpGateLine] : []),
    ...(cfg.productBrief?.trim()
      ? ["", `PRODUCT BRIEF (facts and the ONLY links you may cite):\n${cfg.productBrief.trim()}`]
      : []),
    ...(input.dossier?.trim()
      ? ["", `SENDER DOSSIER (research about who wrote this):\n${input.dossier.trim()}`]
      : []),
    ...(angleBlock ? ["", angleBlock] : []),
    ...(meetingBlockText ? ["", meetingBlockText] : []),
    ...(priorBlock ? ["", priorBlock] : []),
    ...(priorInboundBlock ? ["", priorInboundBlock] : []),
    ...(threadBlock ? ["", threadBlock] : []),
    ...(asksBlock ? ["", asksBlock] : []),
    ...(intentBlock ? ["", intentBlock] : []),
    ...(steerBlock ? ["", steerBlock] : []),
    "",
    "INBOUND EMAIL (the message you are answering):",
    `Subject: ${input.subject}`,
    stripQuotedChain(input.body).slice(0, INBOUND_BODY_MAX),
    ...(firstName ? ["", `PROSPECT_FIRST_NAME: ${firstName}`] : []),
  ].join("\n");

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const res = await complete({ messages, temperature: 0.6, maxTokens: 500 });
  let body = bodyFrom(res.content);
  if (!body) throw new Error("the model returned an empty reply draft — try again");

  // The outbound plays lint their drafts and let sendDraftedEmail block on the
  // flags. A reply has no send gate for most flags (the founder reviews it in
  // the composer), so the gate is a single repair pass — except `commits-terms`
  // (issue #480), which DOES get a send gate: see the route's needsDecision.
  const priorTexts = [...prior.map((r) => r.body!), ...(input.threadSent ?? []).map((t) => t.body)];
  const budget = replyWordBudget(input.body);
  const allowedUrls = briefUrls(cfg.productBrief);
  let flags = lintReply(body, budget, priorTexts, allowedUrls);
  if (flags.length > 0) {
    const repaired = await repairReply({ messages, first: res.content, flags, budget, input });
    // Keep the rewrite only when it is strictly better — fewer flags, or the
    // same flags but closer to the budget. A repair that trades one violation
    // for another is not an improvement worth the swap.
    if (
      repaired &&
      better(
        replyPenalty(repaired, budget, priorTexts, allowedUrls),
        replyPenalty(body, budget, priorTexts, allowedUrls),
      )
    ) {
      body = repaired;
      flags = lintReply(body, budget, priorTexts, allowedUrls);
    }
  }
  return { body, flags };
}

/** One corrective turn, naming the flags the draft tripped. Returns "" when the
 *  retry fails for any reason — a linted-but-imperfect draft still beats none. */
async function repairReply(opts: {
  messages: LlmMessage[];
  first: string;
  flags: string[];
  budget: number;
  input: DraftInboxReplyInput;
}): Promise<string> {
  const inboundWords = wordCount(opts.input.body);
  try {
    const res = await complete({
      messages: [
        ...opts.messages,
        { role: "assistant", content: opts.first },
        {
          role: "user",
          content: [
            `That draft failed the reply gate: ${opts.flags.join(", ")}.`,
            `They wrote ${inboundWords} words; yours must come in under ${opts.budget}, signature excluded.`,
            "Rewrite it. Answer only what they actually said, and cut every sentence that pitches,",
            "re-introduces you or the product, repeats wording from an email already in this thread,",
            "cites a link that is not verbatim in PRODUCT BRIEF, describes the product in their words",
            "rather than the brief's, or affirms something the brief does not establish,",
            "or commits the founder to pricing, discounts, partnership terms, distribution, documentation",
            "placement, exclusivity, roadmap dates, or headcount that were never authorised.",
            "Same JSON shape.",
          ].join(" "),
        },
      ],
      temperature: 0.5,
      maxTokens: 500,
    });
    return bodyFrom(res.content);
  } catch {
    return "";
  }
}
