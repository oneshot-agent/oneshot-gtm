import { loadConfig, stripQuotedChain } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { getPriorStepsForProspect, type PriorStepRow } from "./_cadence.ts";
import { firstNameFrom, humanizeDraft, signatureDirective, socialProofBlock } from "./_lib.ts";

// stripQuotedChain moved to core (reply-classify.ts) — the classifier needs it
// too. Re-exported so existing imports of this module keep working.
export { stripQuotedChain };

/** Mirror triage.ts's truncation — inbound bodies can be huge (quoted chains). */
const INBOUND_BODY_MAX = 2000;

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

  const proofBlock = socialProofBlock();
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
    ...(proofBlock ? ["", proofBlock] : []),
    ...(firstName ? ["", `PROSPECT_FIRST_NAME: ${firstName}`] : []),
  ].join("\n");

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.6,
    maxTokens: 500,
  });
  const parsed = tryParseJsonObject<{ body?: string }>(res.content, {});
  const body = (parsed.body ?? "").trim();
  if (!body) throw new Error("the model returned an empty reply draft — try again");
  // Same deterministic autofixes the outbound drafts get (em-dash, curly
  // quotes, emoji). humanizeDraft wants a subject — pass a dummy.
  return { body: humanizeDraft({ subject: "x", body }).body };
}
