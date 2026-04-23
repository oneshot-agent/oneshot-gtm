import { getLedger, loadConfig, receiptUrlForId, sendEmail } from "@oneshot-gtm/core";
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
  return parseSubjectBody(res.content);
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
