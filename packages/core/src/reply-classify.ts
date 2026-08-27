/**
 * Deterministic inbound-reply classifier. Every email from a prospect's
 * address used to count as a reply; real inboxes answer with vacation
 * autoresponders, "no longer at this company" notices, and "take me off your
 * list" one-liners — each of which must steer the pipeline differently
 * (see kind docs below). Heuristic on purpose: this runs inside the 5-minute
 * scheduler tick, so no LLM call, no network, no nondeterminism.
 */

/**
 * What an inbound email from a prospect actually is:
 * - `human`          — a person wrote back. The only kind that counts as a
 *                      reply (metric, cadence stop, RoCS tag, friends push).
 * - `auto`           — temporary autoresponder (OOO/vacation). Stored for the
 *                      conversation history; changes nothing else — follow-ups
 *                      continue as scheduled.
 * - `auto_permanent` — autoresponder saying the mailbox is dead ("retired",
 *                      "no longer with the company"). A human-layer hard
 *                      bounce: stops active cadences, never counts as a reply.
 * - `unsubscribe`    — a human wrote "remove me / do not contact". Stops ALL
 *                      cadences and excludes the prospect from every campaign.
 */
export type ReplyKind = "human" | "auto" | "auto_permanent" | "unsubscribe";

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

// Subject prefixes mail servers stamp on autoresponses, across the locales
// that have actually shown up in the inbox plus the common European ones.
// Anchored at the start: a human writing "out of office" mid-subject is rare,
// an autoresponder putting it anywhere else is rarer.
const AUTO_SUBJECT_RE = new RegExp(
  "^\\s*(?:" +
    [
      "automatic reply",
      "auto[- ]?reply",
      "auto[- ]?response",
      "autosvar",
      "out of office",
      "ooo[:\\s]",
      "abwesenheit(?:snotiz)?",
      "automatische antwort",
      "r[ée]ponse automatique",
      "respuesta autom[áa]tica",
      "automatisch(?:e|) antwoord",
      "自动回复",
      "自動回覆",
      "부재중",
    ].join("|") +
    ")",
  "i",
);

// Body phrases an autoresponder opens with. Checked against the head of the
// quote-stripped body only — deep in a long human reply these read as prose
// ("I was out of office last week"), near the top they read as a bot.
const AUTO_BODY_RE = new RegExp(
  [
    "\\bout of (?:the )?office\\b",
    "\\bon (?:annual|parental|maternity|paternity|sick) leave\\b",
    "\\baway from (?:my|the) (?:email|office|desk)\\b",
    "\\bon (?:vacation|holiday)\\b",
    "\\blimited access to (?:my )?e-?mail\\b",
    "\\bauto-?generated (?:message|response|reply)\\b",
    "\\bi(?:'m| am) currently (?:away|out|travell?ing)\\b",
    "自动回复",
    "自動回覆",
  ].join("|"),
  "i",
);

// Escalates an `auto` to `auto_permanent` — the responder says the mailbox or
// the person is gone for good, not on leave. Only consulted once something
// already classified as auto: "retired" alone in a human reply must not trip.
const PERMANENT_RE = new RegExp(
  [
    "\\bno longer (?:with|at|using|working|employed)\\b",
    "\\bhas left\\b",
    "\\bretired\\b",
    "\\bis not with .{0,40}\\banymore\\b",
    "\\b(?:mailbox|email|address|account) (?:is )?(?:no longer|not) (?:monitored|active|in use)\\b",
  ].join("|"),
  "i",
);

// A human asking off the list. Deliberately tight — a bare "not interested"
// is a soft no and stays human; these are explicit removal requests. Checked
// on the quote-stripped body so OUR OWN footer in the quoted chain can't trip.
const UNSUBSCRIBE_RE = new RegExp(
  [
    "\\bunsubscribe\\b",
    "\\bremove me\\b",
    "\\btake me off\\b",
    "\\bstop (?:emailing|contacting|messaging)\\b",
    "\\bdo not (?:contact|email) me\\b",
    "\\bdon'?t (?:contact|email) me\\b",
    "\\bopt me out\\b",
    "\\bnot interested\\b.{0,80}\\b(?:stop|remove|unsubscribe|don'?t)\\b",
  ].join("|"),
  "i",
);

// Autoresponders front-load their message; humans might mention a vacation
// anywhere. Only this many chars of the (quote-stripped) body vote.
const BODY_HEAD_CHARS = 400;

/**
 * Classify one inbound email. `autoSubmitted` is the header-level verdict the
 * Gmail source computes from Auto-Submitted / X-Autoreply / Precedence —
 * authoritative when present (OneShot-sourced mail never has it and relies on
 * the subject/body heuristics alone).
 */
export function classifyReply(input: {
  subject?: string | null;
  body?: string | null;
  autoSubmitted?: boolean;
}): ReplyKind {
  const subject = input.subject ?? "";
  const stripped = stripQuotedChain(input.body ?? "");
  const head = stripped.slice(0, BODY_HEAD_CHARS);

  const isAuto =
    input.autoSubmitted === true || AUTO_SUBJECT_RE.test(subject) || AUTO_BODY_RE.test(head);
  if (isAuto) {
    return PERMANENT_RE.test(subject) || PERMANENT_RE.test(head) ? "auto_permanent" : "auto";
  }
  if (UNSUBSCRIBE_RE.test(head)) return "unsubscribe";
  return "human";
}
