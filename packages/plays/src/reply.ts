import { loadConfig, stripQuotedChain } from "@oneshot-gtm/core";
import { complete, type LlmMessage, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { getPriorStepsForProspect, type PriorStepRow } from "./_cadence.ts";
import { firstNameFrom, humanizeDraft, lintEmail, signatureDirective } from "./_lib.ts";

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
 * Body-only lint: a reply keeps the inbound "Re: …", so subject flags are not
 * ours to raise — lintEmail gets a dummy subject and they're dropped.
 */
function lintReply(body: string, maxWords: number, priorTexts: readonly string[]): string[] {
  const flags = lintEmail("x", body, maxWords).filter((f) => !f.startsWith("subject-"));
  if (repeatsPriorText(body, priorTexts)) flags.push("repeats-prior-email");
  return flags;
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
  /** Replies the founder already sent in this thread (oldest first) — round 2+ must not repeat round 1. */
  threadSent?: Array<{ body: string; sentAt: string }>;
  /** The prospect's earlier inbound messages (oldest first) — the other half of the exchange. */
  priorInbound?: Array<{ body: string; subject: string | null; receivedAt: string }>;
}

/**
 * Draft a reply to an inbound prospect email, in the founder's voice. Same
 * scaffolding as cadence follow-ups (signature directive, social proof, prior
 * touches, humanizer autofixes) but answering THEIR message rather than
 * continuing a sequence. Returns the body only — the subject stays "Re: …".
 * Throws on LLM/provider errors; the route maps that to a 4xx message.
 */
export async function draftInboxReply(input: DraftInboxReplyInput): Promise<{ body: string }> {
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

  // No SOCIAL PROOF block here, deliberately. It is an instruction ("pick the
  // ONE beat that best fits this play"), and in a reply it contradicts the
  // prompt's "do not re-introduce yourself or the product" — the credentials
  // and portfolio lines only render as a self-introduction, which the prospect
  // already read in the intro email. Social proof belongs in outbound drafts.
  const firstName = firstNameFrom(input.matched?.name ?? null);
  const user = [
    `FOUNDER: ${cfg.founderName ?? "(unknown)"}`,
    `PRODUCT: ${cfg.productOneLiner ?? "(unknown)"}`,
    ...(cfg.icpOneLiner ? [`ICP: ${cfg.icpOneLiner}`] : []),
    `PROSPECT: ${input.matched?.name ?? "(unknown)"}`,
    `EMAIL: ${input.fromEmail}`,
    `COMPANY: ${input.matched?.company ?? "(unknown)"}`,
    ...(input.matched?.playName ? [`PLAY: ${input.matched.playName}`] : []),
    ...(cfg.productBrief?.trim()
      ? ["", `PRODUCT BRIEF (facts and the ONLY links you may cite):\n${cfg.productBrief.trim()}`]
      : []),
    ...(input.dossier?.trim()
      ? ["", `SENDER DOSSIER (research about who wrote this):\n${input.dossier.trim()}`]
      : []),
    ...(priorBlock ? ["", priorBlock] : []),
    ...(priorInboundBlock ? ["", priorInboundBlock] : []),
    ...(threadBlock ? ["", threadBlock] : []),
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
  // flags. A reply has no send gate (the founder reviews it in the composer),
  // so the gate is a single repair pass instead: cheaper than shipping a
  // three-paragraph pitch at a one-line question.
  const priorTexts = [...prior.map((r) => r.body!), ...(input.threadSent ?? []).map((t) => t.body)];
  const budget = replyWordBudget(input.body);
  const flags = lintReply(body, budget, priorTexts);
  if (flags.length > 0) {
    const repaired = await repairReply({ messages, first: res.content, flags, budget, input });
    // Keep the rewrite only if it actually cleared flags — a repair that trades
    // one violation for another is not an improvement worth the swap.
    if (repaired && lintReply(repaired, budget, priorTexts).length < flags.length) body = repaired;
  }
  return { body };
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
            "re-introduces you or the product, or repeats wording from an email already in this thread.",
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
