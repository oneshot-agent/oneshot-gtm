import { loadConfig } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { getPriorStepsForProspect, type PriorStepRow } from "./_cadence.ts";
import { firstNameFrom, humanizeDraft, signatureDirective, socialProofBlock } from "./_lib.ts";

/** Mirror triage.ts's truncation — inbound bodies can be huge (quoted chains). */
const INBOUND_BODY_MAX = 2000;

/**
 * Drop the quoted prior-thread chain mail clients top-post beneath the new
 * reply. Without this, a blind head-truncation can keep 2000 chars of OUR
 * own quoted email and cut off the prospect's actual new text below it. Cuts
 * at the first attribution line ("On <date>, <name> wrote:") or the first run
 * of `>`-quoted lines — whichever comes first. Falls back to the full body
 * when no quote marker is found (plain replies, or clients we don't match).
 */
export function stripQuotedChain(body: string): string {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Gmail/Apple/Outlook attribution line that precedes the quoted block.
    if (/^On\b.*\bwrote:$/.test(line)) return lines.slice(0, i).join("\n").trim();
    // A quoted line with real content above it — the chain has started.
    if (line.startsWith(">") && i > 0) return lines.slice(0, i).join("\n").trim();
  }
  return body.trim();
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

  const proofBlock = socialProofBlock();
  const firstName = firstNameFrom(input.matched?.name ?? null);
  const user = [
    `FOUNDER: ${cfg.founderName ?? "(unknown)"}`,
    `PRODUCT: ${cfg.productOneLiner ?? "(unknown)"}`,
    `PROSPECT: ${input.matched?.name ?? "(unknown)"}`,
    `EMAIL: ${input.fromEmail}`,
    `COMPANY: ${input.matched?.company ?? "(unknown)"}`,
    ...(input.matched?.playName ? [`PLAY: ${input.matched.playName}`] : []),
    ...(priorBlock ? ["", priorBlock] : []),
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
