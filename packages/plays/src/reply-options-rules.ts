/**
 * Everything about a LinkedIn reply draft that the model does not decide:
 * the prompt, the register signal derived from the founder's own turns, the
 * response parser, and the post-generation lint gate. Pure functions so the
 * whole thing is testable without an LLM call; `reply-worker.ts` is the only
 * caller that talks to the model.
 *
 * Why this exists (2026-09-11): the three variants were tone variants of one
 * answer, and that answer affirmed a prospect's framing of the product because
 * nothing separated "what the brief says" from "what they just said". Moves
 * force three different positions; the claim-grounding block and the lint
 * gate keep the product description inside the brief.
 */
import { lintEmail, humanizeDraft } from "./_lib.ts";
import { repeatsPriorText, bodyCommitsTerms, replyWordBudget } from "./reply.ts";
import { loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { angleBlockFromJson } from "@oneshot-gtm/core";

export type Variant = "direct" | "technical" | "warm";
export const VARIANTS: readonly Variant[] = ["direct", "technical", "warm"];

/** The stance menu. Each option declares one; the three must differ. */
export const MOVES = {
  answer:
    "answer their actual question or point plainly, using only what PRODUCT BRIEF establishes; a capability the brief names does not license a claim about how it behaves",
  concede:
    "grant the point they got right, where PRODUCT BRIEF does not refute it, and correct any earlier overreach in YOUR turns",
  reframe:
    "say what the product is and is not for their case, in the brief's own words, and name the boundary honestly",
  ask: "answer in one clause at most, then ask one question about their priorities, tradeoff, or what they are working on next",
  peer: "engage with what they built, using only sourced dossier or thread facts, with no product mention at all",
  park: "accept a not-now or a mismatch without a counter-pitch, leaving one low-pressure door open",
  check:
    "answer at the level PRODUCT BRIEF actually supports, say plainly that the mechanism detail is one you would confirm rather than guess at, and ask what they need it to do",
} as const;
export type Move = keyof typeof MOVES;
export const MOVE_NAMES = Object.keys(MOVES) as Move[];

export type Register = "lowercase-casual" | "standard" | "unknown";

export interface ThreadTurn {
  direction: "inbound" | "outbound";
  body: string;
  at: string;
}

export interface DraftInput {
  channel?: "email" | "linkedin";
  founderVoice?: string;
  steer?: string;
  founder: string;
  founderCalendarUrl: string;
  primaryWorkspace: string;
  primaryProduct: string;
  primaryBrief: string;
  secondaryProducts: Array<{ workspace: string; oneLiner: string; brief: string }>;
  prospect: { name: string; company: string; title: string; profileUrl: string };
  dossier: string;
  priorOutreach: string[];
  thread: ThreadTurn[];
  casualTexture: boolean;
  /** `prospects.icp_verdict` + reason: a title-based gate decided before this conversation. */
  icp?: { verdict: string; reason: string } | null;
  /** The sent queue row that opened the relationship: which edge the first email argued. */
  firstTouch?: { play: string; edge: string; fitReason: string } | null;
  /** `prospects.angle_json`, verbatim; rendered through the shared ANGLE block. */
  angleJson?: string | null;
}

export type Drafts = Record<Variant, string>;
export type Moves = Partial<Record<Variant, string>>;

export interface DraftFlags {
  perVariant: Record<Variant, string[]>;
  set: string[];
}

export interface DraftMeta {
  read: string;
  moves: Moves;
  flags: DraftFlags;
  repaired: boolean;
}

export interface ParsedDraftResponse {
  drafts: Drafts;
  moves: Moves;
  read: string;
}

const MAX_WORDS = 100;
const NEAR_DUPLICATE_JACCARD = 0.6;
const STOPWORDS = new Set(
  "a an the and or but if so of to in on at for from by with as is are was were be been being it its this that these those we you your our they their i me my he she his her them us not no yes do does did have has had can could would should will just also than then there here what which who how when where why one two about into over out up down more most very really".split(
    " ",
  ),
);

// ---------------------------------------------------------------------------
// Register: the founder's own voice in this thread, derived in code.
// ---------------------------------------------------------------------------

function sentenceStarts(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^[^A-Za-z]+/, "").charAt(0))
    .filter((c) => c.length > 0);
}

/**
 * How the founder has been writing in this thread. Skips the first outbound
 * turn (the templated connection note) and ignores turns under six words. The
 * prompt anchors all three options to this, not to the prospect's latest
 * message, so a polished inbound does not flip the founder into brochure prose.
 */
export function founderRegister(thread: readonly ThreadTurn[]): Register {
  const outbound = thread.filter((m) => m.direction === "outbound");
  const substantive = outbound.slice(1).filter((m) => m.body.trim().split(/\s+/).length >= 6);
  if (substantive.length === 0) return "unknown";
  let lower = 0;
  let total = 0;
  let lowercaseI = false;
  for (const turn of substantive) {
    for (const c of sentenceStarts(turn.body)) {
      total++;
      if (c === c.toLowerCase()) lower++;
    }
    if (/(?:^|[\s(])i(?:'m|'ve|'d|'ll|\s)/.test(turn.body)) lowercaseI = true;
  }
  if (total === 0) return "unknown";
  return lowercaseI || lower / total >= 0.4 ? "lowercase-casual" : "standard";
}

function registerDirective(register: Register): string {
  switch (register) {
    case "lowercase-casual":
      return "lowercase-casual. All three options keep it: lowercase sentence starts, lowercase i, contractions, plain punctuation. Do not switch to polished prose because their latest message was polished.";
    case "standard":
      return "standard capitalisation, still conversational. All three options keep it.";
    default:
      return "not established yet. Mirror their casing and punctuation; if they write casually or mostly lowercase, do the same.";
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildDraftSystemPrompt(channel: "email" | "linkedin" = "linkedin"): string {
  const moves = MOVE_NAMES.map((m) => `  ${m}: ${MOVES[m]}`).join("\n");
  return `${loadPrompt("_humanizer")}

${channel.toUpperCase()} REPLY TASK:
- This is a real 1:1 ${channel === "email" ? "email" : "LinkedIn"} conversation after the person replied. ${channel === "email" ? "Return only the reply body, without a subject; follow the email signature directive below." : "Never add a signature, greeting, or subject."} The humanizer's "Hey {first name}" opener and lowercase-subject rules do not apply here; every other humanizer rule does.
- Return one JSON object with these fields: read (string), direct (string), technical (string), warm (string), moves (object with keys direct, technical, warm).
- read is one sentence for the founder, not for the prospect: what their latest message asks or claims, whether it asks at CAPABILITY level (does the product do X) or MECHANISM level (how does X behave), and whether PRODUCT BRIEF answers it at that level. Write it before the options and let it govern them.
- Each option must answer the latest message with quote-level specificity. Never merely acknowledge it, repeat an earlier message, or turn immediately into a pitch.

THREE MOVES, NOT THREE TONES:
- Each option declares exactly one move in moves, chosen from this menu, and the three moves must be different:
${moves}
- The move decides the substance of the option. The labels are only a secondary texture: direct is the shortest, technical engages one concrete mechanism or tradeoff, warm sounds most like a person. Three wordings of the same position are a failure even when their tone differs.
- When their latest message challenges something YOU said earlier, or argues a limitation of your approach, one of the three moves must be concede. Use concede only when there is something real to concede: a thumbs-up or a one-word acceptance is not a challenge, and apologising for your own opener is not a concession.
- When they share a project and there is no honest, specific product fit, use peer for at least one option: engage with what they built using only sourced dossier or thread facts, name one detail that is actually interesting, and ask about their priorities or what is next. Never twist their project into a product pitch. A good peer conversation with no product mention is a successful outcome.

CLAIM GROUNDING (binding):
- PRODUCT BRIEF is the only source of product facts. Describe the product in the brief's own terms or in plain words. Never describe it using the prospect's architecture vocabulary from the thread (their words for stores, logs, layers, replay, truth, projections, or anything else), even when it sounds like a fit.
- If they ask whether the product does or is X and PRODUCT BRIEF does not establish X, do not say yes. Say what it does do and where the boundary is.
- If they make a correct point that PRODUCT BRIEF does not refute, concede it plainly. "you're right on the split" beats any defence.
- No war stories, no "saved us from", no customer anecdotes, no incidents, no numbers, no roadmap, unless PRODUCT BRIEF states them.
- Do not claim research facts unless they appear in the dossier. Treat every URL in the thread as opaque unless its contents are described in the dossier: you may repeat its domain or say they shared it, but never say you opened, checked, saw, liked, or evaluated it, and never attribute a stack, feature, quality, or use case to it without sourced dossier evidence.
- Links: at most ONE URL per option, and only a URL that appears VERBATIM in PRODUCT BRIEF or is exactly FOUNDER CALENDAR URL. Never construct, guess, or adapt a URL. No PRODUCT BRIEF means no links. Include a link only when they asked for it or the move needs it.

CAPABILITY VS MECHANISM (binding):
- PRODUCT BRIEF establishes what the product does. It almost never establishes how a behaviour works: what blocks versus queues, what happens when a limit is reached, ordering, retries, failure modes, or what is synchronous. A capability the brief names is not a mechanism you may describe.
- Composing two brief phrases into a mechanism is an invention even though every phrase is quoted. "Requests human approval when needed" next to "enforces budgets" does not establish what happens when a budget is exceeded mid-run.
- When their latest message asks a mechanism question and PRODUCT BRIEF only names the capability, use check for at least one option. Telling an engineer you would confirm the detail is a strong answer; a confident wrong mechanism ends the thread.
- Never settle an either/or mechanism question ("is it X or Y") by picking a side PRODUCT BRIEF does not state.

LEDGER GROUNDING (present only when the input carries it):
- ICP GATE is a title-based verdict made before this conversation, with its reason. The thread outranks it: if they show they build, run, or buy agent systems, treat the gate as stale and say nothing about it. A reject means stay at peer or ask moves and mention the product only when they ask. A pass never licenses a pitch.
- FIRST TOUCH is the argument the opening email already made. Never re-run that argument or its wording on LinkedIn; every option must add something the email did not say.
- ANGLE is a synthesized read on this prospect. Its "Do NOT say" list is binding: never restate one of those premises, even rephrased. Its Hook is material for a specific opener only when it fits what they actually wrote.

PRESSURE:
- The objective is to keep a useful conversation moving toward founder discovery, product feedback, adoption, partnership, or a genuine peer relationship. Optimize for the next reply, not an immediate meeting.
- Use the smallest next move the conversation has earned:
  1. LIGHT: for a greeting, short answer, polite question, or early exchange, answer plainly and ask one easy, relevant question about what they are building or how they handle the problem. A natural open loop is enough.
  2. INTEREST: after they describe a real problem or meaningful overlap, offer one useful angle and softly test interest in seeing or trying the relevant part. Do not demand time.
  3. ACTION: only after explicit interest, a concrete use case, partnership language, or several substantive turns, suggest one low-pressure call, hands-on test, introduction, or integration discussion.
- Do not force a question or CTA into every option. A specific answer that naturally invites a response can end as a statement. Never put multiple asks in one option.
- The three options may sit at adjacent pressure levels, but none may jump more than one stage beyond what the thread earned. Most early threads should contain zero or one meeting-oriented option, not three.
- SCHEDULING: FOUNDER CALENDAR URL is the founder's own booking link. Use that exact URL only when the conversation has earned a meeting: they explicitly agree, ask for a call, ask how to schedule, or the thread is already at ACTION stage. Never call it the prospect's calendar and never say the founder will book through it. Invite them naturally to pick a time, for example: "google meet works, grab whatever time works here: {FOUNDER CALENDAR URL}". Do not include the link in early-stage replies, do not ask another discovery question after they accept, do not pitch again, and never invent a time or claim a slot is booked. Keep it to one or two human sentences.
- Never invent availability, dates, times, calendar links, documents, actions, follow-ups, or promises.

VOICE:
- YOUR REGISTER IN THIS THREAD is given in the input. Match it in all three options; it is the founder's own voice, and the prospect's latest message does not override it. Fragments and contractions are welcome when they fit.
- The input says whether CASUAL TEXTURE is enabled. When enabled, exactly ONE of the three options may contain exactly ONE harmless imperfection: lowercase i, one missed comma, or a plausible minor typo in an ordinary word. Keep the other two clean. When disabled, do not deliberately add an error. Never misspell a person's name, company, product, technical term, number, or URL. Never make an error that changes meaning.
- Humanizer wording bans apply. Never say "compare notes", "swap takes", "worth a 15-min", "curious to", or "I'd love to chat".
- PRIOR OUTREACH includes emails sent to this person across the workspace. Continue that relationship, do not repeat claims, and do not ask for facts they already supplied by email. Never reuse a run of wording from PRIOR OUTREACH or from YOUR earlier turns.
- Mirror their length and energy. Prefer 20-60 words; never exceed 100. Mention only the product detail needed to answer them.

Before answering, silently verify: read written first; three different moves; concede present when they challenged you; no product claim outside PRODUCT BRIEF; no mechanism described that PRODUCT BRIEF does not state; no prospect vocabulary used as a product description; at most one link and only a verbatim one; register matches YOUR REGISTER; natural pressure for this stage; one ask at most; controlled texture matches its flag; no humanizer violation.
Output only {"read":string,"direct":string,"technical":string,"warm":string,"moves":{"direct":string,"technical":string,"warm":string}}.`;
}

export function buildDraftUserPrompt(i: DraftInput): string {
  const transcript = i.thread
    .map((m) => `${m.direction === "inbound" ? "THEM" : "YOU"} (${m.at}): ${m.body}`)
    .join("\n");
  return [
    `FOUNDER: ${i.founder}`,
    `FOUNDER CALENDAR URL: ${i.founderCalendarUrl || "(none)"}`,
    `PRIMARY WORKSPACE: ${i.primaryWorkspace}`,
    `PRODUCT: ${i.primaryProduct}`,
    `PRODUCT BRIEF (the only source of product facts and the only links you may cite):\n${i.primaryBrief || "(none; make no product claims and cite no links)"}`,
    i.secondaryProducts.length
      ? `OTHER WORKSPACE CONTEXT (use only if the thread explicitly concerns it):\n${i.secondaryProducts.map((p) => `${p.workspace}: ${p.oneLiner}\n${p.brief}`).join("\n---\n")}`
      : "",
    `PROSPECT: ${i.prospect.name} | ${i.prospect.title} | ${i.prospect.company}`,
    `PROFILE: ${i.prospect.profileUrl}`,
    `SENDER DOSSIER:\n${i.dossier || "(none; rely only on profile fields and the thread)"}`,
    i.priorOutreach.length ? `PRIOR OUTREACH:\n${i.priorOutreach.join("\n---\n")}` : "",
    i.icp?.verdict
      ? `ICP GATE (title-based, decided before this conversation; the thread outranks it): ${i.icp.verdict}${i.icp.reason ? ` - ${i.icp.reason}` : ""}`
      : "",
    i.firstTouch?.edge
      ? `FIRST TOUCH (play ${i.firstTouch.play || "unknown"}; the argument the opening email already made, never re-run it):\n${i.firstTouch.edge}${i.firstTouch.fitReason ? `\nFit reason at queue time: ${i.firstTouch.fitReason}` : ""}`
      : "",
    angleBlockFromJson(i.angleJson) ?? "",
    `YOUR REGISTER IN THIS THREAD: ${registerDirective(founderRegister(i.thread))}`,
    `CASUAL TEXTURE: ${i.casualTexture ? "enabled" : "disabled"}`,
    `FOUNDER VOICE: ${i.founderVoice || "Use the founder register below."}`,
    `FOUNDER INSTRUCTION: ${i.steer || "(none)"}`,
    `FULL ${(i.channel || "linkedin").toUpperCase()} THREAD (latest inbound message is the one to answer):\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function cleanDraft(value: unknown): string {
  if (typeof value !== "string") return "";
  return humanizeDraft({ subject: "linkedin", body: value.trim() }).body.replace(/\n{3,}/g, "\n\n");
}

function pick(record: Record<string, unknown>, key: string): unknown {
  return record[key] ?? record[key.charAt(0).toUpperCase() + key.slice(1)];
}

/**
 * Accepts the current shape ({read, direct, technical, warm, moves}), the
 * legacy three-key shape, a `replies` wrapper, per-variant {text, move}
 * objects, and a labelled-text fallback when the model ignored JSON.
 */
export function parseDraftResponse(content: string): ParsedDraftResponse {
  const parsed = tryParseJsonObject<Record<string, unknown>>(content, {});
  const nested =
    parsed.replies && typeof parsed.replies === "object"
      ? (parsed.replies as Record<string, unknown>)
      : parsed;
  const labelled = (name: string, next?: string): string => {
    const end = next ? `(?=\\n\\s*(?:${next})\\s*:)` : "$";
    return (
      content
        .match(new RegExp(`(?:^|\\n)\\s*${name}\\s*:\\s*([\\s\\S]*?)${end}`, "i"))?.[1]
        ?.trim() ?? ""
    );
  };
  const moveTable = (pick(nested, "moves") ?? pick(parsed, "moves")) as
    | Record<string, unknown>
    | undefined;
  const drafts = { direct: "", technical: "", warm: "" } as Drafts;
  const moves: Moves = {};
  const fallbackNext: Record<Variant, string | undefined> = {
    direct: "technical|warm",
    technical: "warm|direct",
    warm: undefined,
  };
  for (const v of VARIANTS) {
    const raw = pick(nested, v);
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      drafts[v] = cleanDraft(obj.text ?? obj.body ?? obj.reply);
      if (typeof obj.move === "string") moves[v] = obj.move.trim().toLowerCase();
    } else {
      drafts[v] = cleanDraft(raw ?? labelled(v, fallbackNext[v]));
    }
    const tableMove = moveTable && typeof moveTable === "object" ? moveTable[v] : undefined;
    if (!moves[v] && typeof tableMove === "string") moves[v] = tableMove.trim().toLowerCase();
  }
  const read =
    typeof pick(parsed, "read") === "string" ? (pick(parsed, "read") as string).trim() : "";
  return { drafts, moves, read };
}

// ---------------------------------------------------------------------------
// Lint gate
// ---------------------------------------------------------------------------

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()"'\]]+/gi;

const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", ")"]);

/** Trailing punctuation, slashes, and scheme/host case never distinguish two links; the path keeps its case. */
function normalizeUrl(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_PUNCT.has(url[end - 1]!)) end--;
  while (end > 0 && url[end - 1] === "/") end--;
  return url
    .slice(0, end)
    .replace(
      /^(https?:\/\/)?([^/?#]+)/i,
      (_m, scheme: string = "", host: string) => `${scheme.toLowerCase()}${host.toLowerCase()}`,
    );
}

function allowedUrls(input: DraftInput): Set<string> {
  const allowed = new Set<string>();
  for (const url of input.primaryBrief.match(URL_RE) ?? []) allowed.add(normalizeUrl(url));
  if (input.founderCalendarUrl) allowed.add(normalizeUrl(input.founderCalendarUrl));
  return allowed;
}

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function lintLinkedInDrafts(drafts: Drafts, moves: Moves, input: DraftInput): DraftFlags {
  const allowed = allowedUrls(input);
  const calendar = input.founderCalendarUrl ? normalizeUrl(input.founderCalendarUrl) : "";
  const theirs = input.thread.filter((m) => m.direction === "inbound").map((m) => m.body);
  const yours = [
    ...input.thread.filter((m) => m.direction === "outbound").map((m) => m.body),
    ...input.priorOutreach,
  ];
  const perVariant = { direct: [], technical: [], warm: [] } as Record<Variant, string[]>;

  for (const v of VARIANTS) {
    const body = drafts[v];
    const urls = (body.match(URL_RE) ?? []).map(normalizeUrl);
    const flags = lintEmail(
      "linkedin",
      body,
      input.channel === "email"
        ? replyWordBudget(input.thread.findLast((m) => m.direction === "inbound")?.body ?? "")
        : MAX_WORDS,
    ).filter((f) => !f.startsWith("subject-"));
    const onlyCalendar = urls.length > 0 && urls.every((u) => u === calendar);
    const out = onlyCalendar ? flags.filter((f) => f !== "calendar-link") : flags;
    if (urls.some((u) => !allowed.has(u))) out.push("link-not-in-brief");
    if (urls.length > 1) out.push("too-many-links");
    if (repeatsPriorText(body, theirs)) out.push("echoes-them");
    if (repeatsPriorText(body, yours)) out.push("repeats-you");
    if (bodyCommitsTerms(body)) out.push("commits-terms");
    perVariant[v] = out;
  }

  const set: string[] = [];
  const declared = VARIANTS.map((v) => moves[v] ?? "");
  const valid = declared.every((m) => (MOVE_NAMES as string[]).includes(m));
  if (!valid || new Set(declared).size !== VARIANTS.length) set.push("same-move");
  const words = VARIANTS.map((v) => contentWords(drafts[v]));
  for (let a = 0; a < VARIANTS.length; a++) {
    for (let b = a + 1; b < VARIANTS.length; b++) {
      if (jaccard(words[a]!, words[b]!) > NEAR_DUPLICATE_JACCARD) {
        set.push(`near-duplicate:${VARIANTS[a]}+${VARIANTS[b]}`);
      }
    }
  }
  return { perVariant, set };
}

export function flagCount(flags: DraftFlags): number {
  return flags.set.length + VARIANTS.reduce((n, v) => n + flags.perVariant[v].length, 0);
}

/**
 * What the repair loop compares. A set-level flag (same-move, near-duplicate)
 * means the founder got fewer than three real options, so it outweighs a
 * wording flag on one variant: a repair that fixes the set at the cost of one
 * per-variant flag is still the better draft.
 */
export function flagPenalty(flags: DraftFlags): number {
  return flags.set.length * 2 + VARIANTS.reduce((n, v) => n + flags.perVariant[v].length, 0);
}

export function emptyFlags(): DraftFlags {
  return { perVariant: { direct: [], technical: [], warm: [] }, set: [] };
}

/**
 * For a set that failed same-move: which variants must change and to what.
 * The first variant to declare a move keeps it; later duplicates and invalid
 * or missing moves are reassigned the first unused move in menu order, so
 * the repair turn can name the exact rewrite instead of restating the rule.
 */
/** Reassignment preference: moves that fit any thread first; concede and park need a reason the code cannot see. */
const REASSIGN_ORDER: readonly Move[] = [
  "answer",
  "ask",
  "peer",
  "reframe",
  "concede",
  "park",
  "check",
];

export function reassignMoves(moves: Moves): Partial<Record<Variant, Move>> {
  const used = new Set<string>();
  const out: Partial<Record<Variant, Move>> = {};
  const valid = (m: string | undefined): m is Move =>
    Boolean(m) && (MOVE_NAMES as string[]).includes(m!);
  for (const v of VARIANTS) {
    const m = moves[v];
    if (valid(m) && !used.has(m)) used.add(m);
  }
  for (const v of VARIANTS) {
    const m = moves[v];
    if (
      valid(m) &&
      used.has(m) &&
      !Object.values(out).includes(m) &&
      VARIANTS.find((x) => moves[x] === m) === v
    )
      continue;
    const next = REASSIGN_ORDER.find((c) => !used.has(c));
    if (!next) break;
    used.add(next);
    out[v] = next;
  }
  return out;
}

/** The corrective turn after a flagged first draft. */
export function repairInstruction(flags: DraftFlags, moves: Moves = {}): string {
  const lines: string[] = [];
  for (const v of VARIANTS) {
    if (flags.perVariant[v].length) lines.push(`${v}: ${flags.perVariant[v].join(", ")}`);
  }
  if (flags.set.length) lines.push(`across the set: ${flags.set.join(", ")}`);
  const reassigned = flags.set.includes("same-move") ? reassignMoves(moves) : {};
  const rewrites = VARIANTS.filter(
    (v) =>
      flags.perVariant[v].length > 0 ||
      reassigned[v] ||
      flags.set.some((f) => f.startsWith("near-duplicate:") && f.includes(v)),
  );
  const keep = VARIANTS.filter((v) => !rewrites.includes(v));
  const assignments = (Object.entries(reassigned) as Array<[Variant, Move]>).map(
    ([v, m]) => `${v} must now declare the move ${m} (${MOVES[m]}) and take that position`,
  );
  return [
    `Those drafts failed the reply gate. ${lines.join("; ")}.`,
    assignments.length ? `${assignments.join("; ")}.` : "",
    rewrites.length && keep.length
      ? `Rewrite only ${rewrites.join(" and ")}; return ${keep.join(" and ")} word for word as they were, with their moves unchanged.`
      : "Rewrite all three. Each option declares a different move from the menu and takes that position, not a different wording of the same one.",
    "Describe the product only in PRODUCT BRIEF terms; never restate their own vocabulary as a claim about it; concede what they got right.",
    "At most one link per option and only one that appears verbatim in PRODUCT BRIEF or is exactly FOUNDER CALENDAR URL.",
    `Stay under ${MAX_WORDS} words, keep YOUR REGISTER, and do not reuse a run of wording from their messages or from your earlier turns.`,
    "Same JSON shape, including read and moves.",
  ]
    .filter(Boolean)
    .join(" ");
}
