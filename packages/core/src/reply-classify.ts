/**
 * Deterministic inbound-reply classifier. Every email from a prospect's
 * address used to count as a reply; real inboxes answer with vacation
 * autoresponders, "no longer at this company" notices, and "take me off your
 * list" one-liners. Each of which must steer the pipeline differently
 * (see kind docs below). Heuristic on purpose: this runs inside the 5-minute
 * scheduler tick, so no LLM call, no network, no nondeterminism.
 */

/**
 * What an inbound email from a prospect actually is:
 * - `human`. A person wrote back. The only kind that counts as a
 *                      reply (metric, cadence stop, RoCS tag, friends push).
 * - `auto`: temporary autoresponder (OOO/vacation). Stored for the
 *                      conversation history, never a reply. What it says is
 *                      read afterwards (auto-reply.ts): an out-of-office holds
 *                      the next step until the person is back.
 * - `auto_permanent`: autoresponder saying the mailbox is dead ("retired",
 *                      "no longer with the company"). A human-layer hard
 *                      bounce: stops active cadences, never counts as a reply.
 * - `unsubscribe`. A human wrote "remove me / do not contact". Stops ALL
 *                      cadences and excludes the prospect from every campaign.
 */
export type ReplyKind = "human" | "auto" | "auto_permanent" | "unsubscribe";

/**
 * Drop the quoted prior-thread chain mail clients top-post beneath the new
 * reply. Without this, a blind head-truncation can keep 2000 chars of OUR
 * own quoted email and cut off the prospect's actual new text below it. Cuts
 * at the first attribution line ("On <date>, <name> wrote:") or the first run
 * of `>`-quoted lines: whichever comes first. Falls back to the full body
 * when no quote marker is found (plain replies, or clients we don't match).
 */
export function stripQuotedChain(body: string): string {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Gmail/Apple/Outlook attribution line that precedes the quoted block.
    if (/^On\b.*\bwrote:$/.test(line)) return lines.slice(0, i).join("\n").trim();
    // A quoted line with real content above it. The chain has started.
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
// quote-stripped body only: deep in a long human reply these read as prose
// ("I was out of office last week"), near the top they read as a bot. The
// past-tense lookbehinds keep a human's "sorry, I was out of the office last
// week" from reading as a live responder: machines announce in present/future
// tense, humans apologize in past tense.
const AUTO_BODY_RE = new RegExp(
  [
    "(?<!\\bwas )(?<!\\bbeen )\\bout of (?:the )?office\\b",
    "(?<!\\bwas )(?<!\\bbeen )\\bon (?:annual|parental|maternity|paternity|sick|medical) leave\\b",
    "(?<!\\bwas )(?<!\\bbeen )\\bout of the country\\b",
    "(?<!\\bwas )(?<!\\bbeen )\\baway from (?:my|the) (?:email|office|desk)\\b",
    "(?<!\\bwas )(?<!\\bbeen )\\bon (?:vacation|holiday)\\b",
    "\\blimited access to (?:my )?e-?mail\\b",
    "\\bauto-?generated (?:message|response|reply)\\b",
    "\\bi(?:'m| am) currently (?:away|out|travell?ing)\\b",
    "自动回复",
    "自動回覆",
  ].join("|"),
  "i",
);

// What follows "left"/"departed" when the absence is temporary.
const TEMPORARY_LEAVE =
  "(?!\\s+(?:the\\s+)?(?:office|building|desk)\\b|\\s+(?:for|on)\\s+(?:the\\s+|a\\s+|my\\s+)?(?:day|night|week|weekend|holidays?|vacation|leave|trip|break|travel))";

// Escalates an `auto` to `auto_permanent`. The responder says the mailbox or
// the person is gone for good, not on leave. Only consulted once something
// already classified as auto: "retired" alone in a human reply must not trip.
const PERMANENT_RE = new RegExp(
  [
    "\\bno longer (?:with|at|using|working|employed|receiving)\\b",
    "\\bno longer work(?:s|ed|ing)? (?:at|for|with)\\b",
    "\\b(?:formerly|previously) work(?:ed)? (?:at|for)\\b",
    "\\bdecided to move on\\b",
    "\\bnot part of .{0,60}\\banymore\\b",
    "\\bretired\\b",
    "\\bis not with .{0,40}\\banymore\\b",
    "\\b(?:mailbox|email|address|account) (?:is )?(?:no longer|not) (?:monitored|active|in use)\\b",
  ].join("|"),
  "i",
);

// "Has left" / "departed" read as gone for good only when nothing in the same
// text says they come back: "I have left for the Web Summit and will be back
// on 9 November" is a trip. The lookahead also keeps the plain trips ("left
// for vacation", "left the office for the day") temporary on their own.
// "Left" counts only as a departure, never with a thing left behind ("I've
// left instructions with my team"): said on its own ("Sam has left."), to
// join or pursue something, or before a capitalised name ("has left
// Halyard"; that one is case-sensitive on purpose).
const LEFT_RE = new RegExp(
  [
    "(?:\\bhas|\\bhave|'ve) (?:left|departed|moved on)(?=\\s*(?:[.,;:!)]|$))",
    "(?:\\bhas|\\bhave|'ve) left to (?:join|pursue|start|take)\\b",
    "(?:\\bhas|\\bhave|'ve) (?:departed|moved on)\\b" + TEMPORARY_LEAVE,
    "\\bdeparted (?:from|the)\\b" + TEMPORARY_LEAVE,
  ].join("|"),
  "im",
);
const LEFT_NAMED_RE = /(?:\b[Hh]as|\b[Hh]ave|'ve) left (?!The\b|For\b|On\b)[A-Z][\w&'.-]*/;
// Leaving the company itself is a departure whatever else the text says
// ("Sam has left the company. Contact Jane until a replacement is hired."),
// but not leaving its premises ("left the company office for a conference").
const LEFT_COMPANY_RE =
  /(?:\bhas|\bhave|'ve) (?:left|departed(?: from)?) (?:the |our )?(?:company|organi[sz]ation|firm|business)\b(?!\s+(?:offices?|building|premises|campus|site|headquarters|hq)\b)/i;
// A return cue names when they are back: "will be back", "back on …",
// "returning on …", or until/through followed by a day or a date. A bare
// "until" ("until a replacement is hired") is not one.
const RETURN_CUE_RE =
  /\b(?:(?:will|i'?ll|i will) be back|back (?:on|in|by|from|at)|return(?:ing|s)? (?:on|to|in)|(?:until|till|through) (?:the )?(?:\d|(?:mon|tues|wednes|thurs|fri|satur|sun)day|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;

function permanentIn(text: string): boolean {
  return (
    PERMANENT_RE.test(text) ||
    LEFT_COMPANY_RE.test(text) ||
    ((LEFT_RE.test(text) || LEFT_NAMED_RE.test(text)) && !RETURN_CUE_RE.test(text))
  );
}

// A human asking off the list. Deliberately tight. A bare "not interested"
// is a soft no and stays human; these are explicit removal requests. Checked
// on the quote-stripped body so OUR OWN footer in the quoted chain can't trip.
const UNSUBSCRIBE_RE = new RegExp(
  [
    "\\bunsubscribe\\b",
    "\\bremove me\\b",
    "\\btake me off\\b",
    "\\bstop (?:emailing|contacting|messaging)\\b",
    "\\bdo not (?:ever )?(?:contact|email) me\\b",
    "\\bdon'?t (?:ever )?(?:contact|email) me\\b",
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
 * Gmail source computes from Auto-Submitted / X-Autoreply / Precedence:
 * authoritative when present (OneShot-sourced mail never has it and relies on
 * the subject/body heuristics alone).
 */
export function classifyReply(input: {
  subject?: string | null;
  body?: string | null;
  autoSubmitted?: boolean;
}): ReplyKind {
  const subject = (input.subject ?? "").replace(/[’‘]/g, "'");
  const stripped = stripQuotedChain(input.body ?? "").replace(/[’‘]/g, "'");
  const head = stripped.slice(0, BODY_HEAD_CHARS);
  const permanent = permanentIn(subject) || permanentIn(`${subject}\n${head}`);

  // The header verdict is authoritative machine mail: no human wrote it, so
  // it can never be an unsubscribe: even if the responder's boilerplate
  // happens to contain the word.
  if (input.autoSubmitted === true) return permanent ? "auto_permanent" : "auto";
  // For text-classified mail an explicit removal request wins over OOO
  // phrasing: "heading out on vacation — please remove me from your list" is
  // a human opting out, not a responder.
  if (UNSUBSCRIBE_RE.test(subject) || UNSUBSCRIBE_RE.test(head)) return "unsubscribe";
  if (AUTO_SUBJECT_RE.test(subject) || AUTO_BODY_RE.test(head)) {
    return permanent ? "auto_permanent" : "auto";
  }
  return "human";
}

function headOf(subject: string | null | undefined, body: string | null | undefined) {
  return {
    subject: (subject ?? "").replace(/[’‘]/g, "'"),
    head: stripQuotedChain(body ?? "")
      .replace(/[’‘]/g, "'")
      .slice(0, BODY_HEAD_CHARS),
  };
}

/**
 * Whether autoresponder text says the person or the mailbox is gone for good:
 * the check `classifyReply` escalates `auto` to `auto_permanent` with, for mail
 * already known to be automatic (a stored row read again by the backfill).
 */
export function isPermanentAutoText(
  subject: string | null | undefined,
  body: string | null | undefined,
): boolean {
  const t = headOf(subject, body);
  return permanentIn(t.subject) || permanentIn(`${t.subject}\n${t.head}`);
}

/** Whether the subject or the head of the body reads as an autoresponder. */
export function isAutoReplyText(
  subject: string | null | undefined,
  body: string | null | undefined,
): boolean {
  const t = headOf(subject, body);
  return AUTO_SUBJECT_RE.test(t.subject) || AUTO_BODY_RE.test(t.head);
}
