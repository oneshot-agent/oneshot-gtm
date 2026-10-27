/**
 * The prospect offer: the founder's offer made specific to one prospect's
 * firm. It is the outcome the founder's product would deliver there, written
 * from everything known about the person and the firm. Every outreach
 * message opens with it.
 *
 * Product facts come only from config: `productOneLiner`, `productBrief`, and
 * `pilotOffer` (the general terms: a pilot, a trial, a partnership). The kinds
 * of goal a founder never offers come from `offerExclusions`: the writer is
 * told them and the judge rates such an offer `irrelevant`. `offerAnchor`
 * says which anchor to prefer where the research allows a choice. Nothing
 * here names a product or assumes what kind of offer a founder makes.
 *
 * Before the first send it is stored on the queue row (`payload.offer`, with
 * the ranked `offerCandidates`). The send hands it to the sequence it starts
 * (`cadence_state.offer_json`, see `_sequence-offer.ts`), which owns it from
 * then on, so every later touch carries the same one. An offer the founder
 * edited is never re-derived.
 *
 * The writer may decline (`{"skip": true, "why": ...}`). Its reason is kept
 * where the offer would be (`payload.offerSkip`, or the cadence's
 * `offer_json.skip`) with the hash of the input it read, so the founder sees
 * why, and the writer is not asked again until that input changes.
 */
import { createHash } from "node:crypto";
import {
  isPersonResearchDossier,
  loadConfig,
  logEvent,
  offerAnchorOf,
  offerExclusionsOf,
  productBriefText,
  type OfferAnchor,
} from "@oneshot-gtm/core";
import {
  callDecisions,
  complete,
  loadPrompt,
  topDecisionLabels,
  tryParseJsonObject,
  type DecisionsChoiceQuestion,
} from "@oneshot-gtm/intel";
import { nearDuplicateOffer } from "@oneshot-gtm/shared-types";
import {
  ANGLE_SEPARATOR,
  angleTextKey,
  describeTargetForAngle,
  edgeFieldOf,
  splitEdgeAngles,
} from "./_angles.ts";
import { slopFlags } from "./_lib.ts";
import { recentPosts } from "./_recent-posts.ts";

type AppConfig = ReturnType<typeof loadConfig>;
type JsonRecord = Record<string, unknown>;

/** Bump when the prompt or the lint changes: unedited offers re-derive. */
export const OFFER_PROMPT_VERSION = "offer-v6";

export const OFFER_MAX = {
  offer: 140,
  steps: 260,
  evidence: 200,
  return: 120,
  fit: 160,
  angle: 300,
} as const;

/** Offers written per prospect, ranked by return; the first is active. */
export const OFFER_COUNT = 5;
/** Angles written per active offer: the intro takes one, each follow-up another. */
export const OFFER_ANGLE_COUNT = 5;

const RESEARCH_MAX = 12_000;
const BRIEF_MAX = 6_000;
const THREAD_EMAIL_MAX = 1_500;
const THREAD_MAX = 4_000;

export interface ProspectOffer {
  /** The outcome for their firm, imperative, in their terms. */
  offer: string;
  /** How the product delivers it: verb phrases, material for the writer only. */
  steps: string;
  /** Short quotes from the research the offer rests on. Empty at role level. */
  evidence: string[];
  /** The firm's stage as the writer judged it, e.g. "scaling startup", "enterprise". */
  stage: string;
  /** `researched`: built on firm facts. `role`: research was thin, built on role and firm type. */
  level: "researched" | "role";
  /** What the firm gets back when the job is done, and how they would count it. */
  return?: string;
  /** The anchor it rests on (their product, or their firm) and the fact behind it. */
  fit?: string;
  /**
   * Which anchor it rests on, as the writer named it: the machine-readable
   * half of `fit`, which states the same thing in prose. Absent on every
   * offer written before the field existed, and on a founder's own edit, so
   * a reader treats absent as unknown rather than as `firm`.
   */
  anchor?: OfferAnchorKind;
  /**
   * The relevance judge's label (see `judgeOffers`). A `weak` offer is kept
   * only to make up the five when too few were judged relevant.
   */
  relevance?: OfferRelevance;
  /** 0–1: the probability of `relevant`, when the judge gives one. */
  relevanceScore?: number;
  /** One line: why the judge labelled it so. */
  relevanceWhy?: string;
  /** `<engine>:<model>` that judged it. */
  relevanceClassifier?: string;
  /**
   * Reasons this offer pays back, one per touch: the draft's angle pool when
   * set (see `overlayOfferAngles` in core). Written for the active offer.
   */
  angles?: string[];
  version: string;
  /** Hash of the inputs it was written from. */
  inputHash: string;
  /** Hash of the product config alone (one-liner, brief, terms): its claims rest on it. */
  productHash?: string;
  /** Set when the founder wrote or edited it. Never re-derived. */
  editedBy?: "founder";
  /**
   * When the founder approved this offer although the judge rated it `weak`.
   * Lives on this offer object only: picking another offer or writing new
   * ones starts without it, so the approval never carries over.
   */
  weakApprovedAt?: string;
  derivedAt: string;
}

export type OfferRelevance = "relevant" | "weak" | "irrelevant";

/** Which of the two anchors one offer rests on. */
export type OfferAnchorKind = "product" | "firm";

/** Longest skip reason kept: the writer's one line, clipped. */
export const OFFER_SKIP_WHY_MAX = 300;

/**
 * The writer's own refusal: it read the research and wrote no offer. Kept so
 * the founder is told why, and so the writer is not paid again for the same
 * answer: it stands while `inputHash` matches (as an offer's does) and is
 * replaced by any offer written or chosen.
 */
export interface OfferSkip {
  /** What the writer said, clipped. */
  why: string;
  version: string;
  /** Hash of the inputs it read (`offerInputHash`). */
  inputHash: string;
  /** Hash of the product config alone (`offerProductHash`). */
  productHash: string;
  skippedAt: string;
}

export function isOfferSkip(value: unknown): value is OfferSkip {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Partial<OfferSkip>;
  return (
    typeof o.why === "string" &&
    typeof o.version === "string" &&
    typeof o.inputHash === "string" &&
    typeof o.productHash === "string" &&
    typeof o.skippedAt === "string"
  );
}

/** True when a stored skip still answers to today's inputs: the writer would read the same. */
export function offerSkipIsCurrent(stored: unknown, inputHash: string): stored is OfferSkip {
  return (
    isOfferSkip(stored) && stored.version === OFFER_PROMPT_VERSION && stored.inputHash === inputHash
  );
}

/** The writer's skip a queue payload carries, when it has one. */
export function offerSkipOf(payload: Record<string, unknown>): OfferSkip | null {
  const s = payload["offerSkip"];
  return isOfferSkip(s) ? s : null;
}

export function isProspectOffer(value: unknown): value is ProspectOffer {
  if (!value || typeof value !== "object") return false;
  const o = value as Partial<ProspectOffer>;
  return typeof o.offer === "string" && o.offer.trim().length > 0 && typeof o.steps === "string";
}

/**
 * Plays whose message is not an offer: a learning interview, a survey, a
 * customer's onboarding call, a missed demo, a launch repost, a public reply.
 * They get no prospect offer and no OFFER block. `multiplier` pitches the
 * founder's member offer verbatim from config, never a written one.
 */
export const NO_OFFER_PLAYS: ReadonlySet<string> = new Set([
  "discovery-interview",
  "pmf-survey",
  "concierge",
  "demo-no-show",
  "x-amplify",
  "x-amplify-dm",
  "community-reply",
  "multiplier",
]);

export function playMakesOffer(playName: string): boolean {
  return !NO_OFFER_PLAYS.has(playName);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compactJson(value: unknown, drop: ReadonlySet<string>): string {
  return JSON.stringify(value, (key, v) => (drop.has(key) ? undefined : v));
}

const PERSON_NOISE = new Set(["version", "seed", "researchedAt", "status", "receiptIds", "cost"]);
const PRODUCT_NOISE = new Set(["version", "researchedAt", "status", "warning", "cost", "kind"]);

/** Longest GitHub record kept: the profile and their own repositories. */
const GITHUB_EVIDENCE_MAX = 3_000;

/**
 * True when offers of this prompt version read the row's `githubEvidence` as
 * its own section (from offer-v6). Older versions read the row alone, which
 * drops any field over 240 characters, so that record never reached them.
 */
function readsGithubEvidence(version: string): boolean {
  const n = /^offer-v(\d+)$/.exec(version)?.[1];
  return n === undefined || Number(n) >= 6;
}

/**
 * Everything known about the person and the firm, as one text the offer is
 * written from and its evidence and numbers are checked against. `version`
 * builds the text as that prompt version read it: an older one to check a
 * kept offer's input hash against the research it was written from.
 */
export function offerResearchText(
  target: object,
  dossier?: string | null,
  version: string = OFFER_PROMPT_VERSION,
): string {
  const t = target as JsonRecord;
  const parts: string[] = [];
  const github = readsGithubEvidence(version) ? githubEvidenceOf(t) : "";
  // A short record would also be a row line; it is read once, in its own section.
  const rowFields = github ? { ...t, githubEvidence: undefined } : t;
  const row = describeTargetForAngle(rowFields, null).trim();
  if (row) parts.push(`HOW THEY WERE FOUND AND WHAT THE ROW SAYS:\n${row}`);
  // What they build themselves: their profile and their own repositories.
  if (github) parts.push(`THEIR GITHUB:\n${clip(github, GITHUB_EVIDENCE_MAX)}`);
  const person = t["personResearch"];
  if (isPersonResearchDossier(person) && person.status !== "unavailable") {
    parts.push(`PERSON RESEARCH:\n${clip(compactJson(person, PERSON_NOISE), 4_000)}`);
  }
  const firm = t["productResearch"] as JsonRecord | undefined;
  if (firm && typeof firm === "object" && firm["status"] !== "unavailable") {
    const sources = Array.isArray(firm["sources"]) ? (firm["sources"] as JsonRecord[]) : [];
    const pages = sources
      .filter((s) => typeof s["excerpt"] === "string" && (s["excerpt"] as string).trim())
      .map((s) => `${String(s["url"] ?? "")}\n${clip(String(s["excerpt"]), 2_500)}`);
    if (pages.length > 0) parts.push(`THEIR OWN PAGES:\n${pages.join("\n\n")}`);
    if (firm["external"]) {
      parts.push(`FIRM RESEARCH:\n${clip(compactJson(firm["external"], PRODUCT_NOISE), 5_000)}`);
    }
  }
  const posts = recentPosts(t);
  if (posts.length > 0) parts.push(`THEIR RECENT POSTS:\n${posts.join("\n")}`);
  const extra = dossier?.trim();
  if (extra) parts.push(`ENRICHMENT:\n${clip(extra, 4_000)}`);
  return clip(parts.join("\n\n"), RESEARCH_MAX);
}

function githubEvidenceOf(t: JsonRecord): string {
  const v = t["githubEvidence"];
  return typeof v === "string" ? v.trim() : "";
}

const TITLE_KEYS = ["title", "newTitle", "jobTitle"];
const COMPANY_KEYS = ["company", "newCompany", "guestCompany", "businessName", "municipality"];

function firstString(t: JsonRecord, keys: string[]): string {
  for (const k of keys) {
    const v = t[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "(unknown)";
}

export function offerInputHash(
  research: string,
  cfg: Pick<AppConfig, "productOneLiner" | "productBrief" | "pilotOffer">,
  /** The prompt version the hash is for: an older one to check a kept offer. */
  version: string = OFFER_PROMPT_VERSION,
): string {
  return createHash("sha256")
    .update(
      [
        version,
        research,
        cfg.productOneLiner ?? "",
        productBriefText(cfg) ?? "",
        cfg.pilotOffer ?? "",
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Hash of the product config an offer's claims rest on. */
export function offerProductHash(
  cfg: Pick<AppConfig, "productOneLiner" | "productBrief" | "pilotOffer">,
): string {
  return createHash("sha256")
    .update(
      [cfg.productOneLiner ?? "", productBriefText(cfg) ?? "", cfg.pilotOffer ?? ""].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 16);
}

/** True when the founder approved this offer although the judge rated it `weak`. */
function offerWeakApproved(offer: Pick<ProspectOffer, "weakApprovedAt">): boolean {
  return typeof offer.weakApprovedAt === "string" && offer.weakApprovedAt.trim().length > 0;
}

/** True when the stored offer still answers to today's inputs, or the founder wrote it. */
export function offerIsCurrent(stored: unknown, inputHash: string): stored is ProspectOffer {
  if (!isProspectOffer(stored)) return false;
  if (stored.editedBy === "founder") return true;
  return stored.version === OFFER_PROMPT_VERSION && stored.inputHash === inputHash;
}

/**
 * True when an offer the founder approved (`weakApprovedAt`) was written from
 * the same research and product config as today's, under any prompt version.
 * The research is rebuilt as the offer's own version read it, so a prompt
 * bump alone, or a new section a later version reads, never rewrites an
 * offer the founder read and approved; new research or a new brief still does.
 */
function approvedOfferStands(
  stored: unknown,
  target: JsonRecord,
  dossier: string | null | undefined,
  cfg: Pick<AppConfig, "productOneLiner" | "productBrief" | "pilotOffer">,
): stored is ProspectOffer {
  return (
    isProspectOffer(stored) &&
    offerWeakApproved(stored) &&
    stored.inputHash ===
      offerInputHash(offerResearchText(target, dossier, stored.version), cfg, stored.version)
  );
}

const BANNED: Array<[flag: string, pattern: RegExp]> = [
  ["price", /[$€£¥]|\b(usd|eur|discount\w*|pricing|priced|per (month|seat|call|user))\b/i],
  ["link", /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ai|io|dev|co|org|net|app)\b/i],
  [
    "observation",
    /\b(you mentioned|i noticed|noticed (that|you|your)|saw (that|you|your)|i came across|congrat\w*|your recent post)\b/i,
  ],
  ["punctuation", /[!"“”—–]|--/],
  // A promise the founder never made: the offer states an outcome, not a warranty.
  ["guarantee", /\bguarantee\w*\b/i],
];

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const ECHO_STOPWORDS = new Set(
  (
    "a an the and or but of to in on at by for with from into onto over under your their our its " +
    "this that these those it they them you we i is are be been was were as so than then very " +
    "can will would could should may might each every any all one own do does did not no"
  ).split(" "),
);

/** Three-word phrases of a text, lowercased. */
function trigrams(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/**
 * Adjacent pairs of content words, lowercased, stopwords dropped and a plural
 * "s" trimmed: "done-checks outside your models" and "a done check outside the
 * model" share "done check" and "check outside model"'s pairs. Rephrasing the
 * product's own wording does not escape it.
 */
function contentBigrams(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[a-z0-9']+/g) ?? [])
    .filter((w) => !ECHO_STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/**
 * An offer that is awareness, not an execution: it leads with watching or
 * reporting, or promises visibility. Product-neutral: whatever a product
 * notices, the offer is what gets done about it. Steps and angles may still
 * name watching as the mechanism.
 */
const AWARENESS_LEAD =
  /^(?:track|monitor|watch|observe|alert|notify|surface|flag|report|ground|stay|keep|maintain)\b/i;
const AWARENESS_ANYWHERE = /\b(?:visibility|insights?|dashboards?|alerts?|alerting)\b/i;

/**
 * An offer that is one pass of checking, not a goal: it leads with a check
 * verb. Product-neutral: whatever a product checks, the offer is what the
 * checking wins, and the check belongs in steps. Only the first word counts,
 * so a goal that names a check later on still passes.
 */
const CHECK_LEAD = /^(?:vet|verify|validate|screen|scan|audit|check)\b/i;

export function isCheckOffer(offer: string): boolean {
  return CHECK_LEAD.test(offer.trim());
}

export function isAwarenessOffer(offer: string): boolean {
  const text = offer.trim();
  return AWARENESS_LEAD.test(text) || AWARENESS_ANYWHERE.test(text);
}

/**
 * Lint flags for a written offer, keyed on the output alone. An offer that
 * fails gets one repair round, then is dropped.
 */
export function lintOffer(
  parts: {
    offer: string;
    steps: string;
    evidence: string[];
    level: ProspectOffer["level"];
    return?: string;
    fit?: string;
  },
  research: string,
  /** The product's description (one-liner and brief). */
  product = "",
  /** The one-liner alone: positioning, never an outcome. */
  oneLiner = "",
): string[] {
  const flags: string[] = [];
  const offer = parts.offer.trim();
  const steps = parts.steps.trim();
  if (!offer || !steps) return ["empty"];
  const ret = (parts.return ?? "").trim();
  if (offer.length > OFFER_MAX.offer) flags.push("offer-too-long");
  if (steps.length > OFFER_MAX.steps) flags.push("steps-too-long");
  if (ret.length > OFFER_MAX.return) flags.push("return-too-long");
  const fit = (parts.fit ?? "").trim();
  if (fit.length > OFFER_MAX.fit) flags.push("fit-too-long");
  if (isAwarenessOffer(offer)) flags.push("offer-not-execution");
  if (isCheckOffer(offer)) flags.push("offer-is-a-check");
  if (parts.level === "researched" && !ret) flags.push("no-return");
  const both = `${offer} ${steps} ${ret}`;
  for (const [flag, pattern] of BANNED) if (pattern.test(both)) flags.push(flag);
  const haystack = normalizeForMatch(research);
  // The fit is the writer's reasoning, shown to the founder only: its
  // numbers must still come from the research.
  for (const n of `${both} ${fit}`.match(/\d[\d,.]*/g) ?? []) {
    if (!research.includes(n.replace(/[.,]$/, ""))) flags.push(`number-not-in-research:${n}`);
  }
  if (parts.level === "researched") {
    if (parts.evidence.length === 0) flags.push("no-evidence");
    for (const quote of parts.evidence) {
      const q = normalizeForMatch(quote).replace(/^["']|["']$/g, "");
      if (q && !haystack.includes(q)) flags.push(`evidence-not-in-research:${clip(quote, 40)}`);
    }
  }
  if (steps.split(/,| and /).filter((p) => p.trim()).length < 2) flags.push("steps-too-few");
  // The offer is their outcome, not the product's mechanism. The one-liner
  // is pure positioning, so any pair of its content words, however
  // rephrased, means it leaked in. The brief also names what the product
  // works on (filings, registries), which an offer may name, so only an exact
  // three-word phrase from it counts. Either is allowed when their own
  // research uses it.
  const researchPairs = contentBigrams(research);
  const linePairs = contentBigrams(oneLiner);
  const briefPhrases = trigrams(product);
  const researchPhrases = trigrams(research);
  const echoed = [
    ...[...contentBigrams(offer)].filter((g) => linePairs.has(g) && !researchPairs.has(g)),
    ...[...trigrams(offer)].filter((g) => briefPhrases.has(g) && !researchPhrases.has(g)),
  ];
  if (echoed.length > 0) flags.push(`offer-echoes-product:${echoed.join(", ")}`);
  return flags;
}

interface RawOffer {
  offer?: unknown;
  steps?: unknown;
  evidence?: unknown;
  stage?: unknown;
  level?: unknown;
  return?: unknown;
  fit?: unknown;
  anchor?: unknown;
  skip?: unknown;
}

function readRaw(raw: RawOffer): Omit<ProspectOffer, "version" | "inputHash" | "derivedAt"> | null {
  if (raw.skip === true) return null;
  const offer = typeof raw.offer === "string" ? raw.offer.trim().replace(/[.]+$/, "") : "";
  const steps = typeof raw.steps === "string" ? raw.steps.trim().replace(/[.]+$/, "") : "";
  if (!offer || !steps) return null;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
        .map((e) => clip(e.trim(), OFFER_MAX.evidence))
        .slice(0, 4)
    : [];
  const ret = typeof raw.return === "string" ? raw.return.trim().replace(/[.]+$/, "") : "";
  const fit = typeof raw.fit === "string" ? raw.fit.trim().replace(/[.]+$/, "") : "";
  // Absent or anything else stays absent: unknown, never a guessed "firm".
  const anchor = raw.anchor === "product" || raw.anchor === "firm" ? raw.anchor : null;
  return {
    offer,
    steps,
    evidence,
    stage: typeof raw.stage === "string" ? raw.stage.trim().slice(0, 60) : "",
    level: raw.level === "role" ? "role" : "researched",
    ...(ret ? { return: ret } : {}),
    ...(fit ? { fit } : {}),
    ...(anchor ? { anchor } : {}),
  };
}

/** The offers in a model reply: `{offers: [...]}`, or a lone offer object; a skip with its why. */
function readRawList(content: string): RawOffer[] | { skip: string } {
  const parsed = tryParseJsonObject<{ offers?: unknown; skip?: unknown; why?: unknown } & RawOffer>(
    content,
    {},
  );
  if (parsed.skip === true) {
    const why = typeof parsed.why === "string" ? parsed.why.replace(/\s+/g, " ").trim() : "";
    return { skip: clip(why, OFFER_SKIP_WHY_MAX) };
  }
  if (Array.isArray(parsed.offers)) {
    return parsed.offers.filter(
      (o): o is RawOffer => !!o && typeof o === "object" && !Array.isArray(o),
    );
  }
  return typeof parsed.offer === "string" ? [parsed] : [];
}

/** One email a sequence already sent, as the offer writer is shown it. */
export interface OfferThreadEmail {
  subject: string;
  body: string;
}

export interface DeriveOfferInput {
  target: object;
  /** Extra research the caller holds (a play's enrichment dossier). */
  dossier?: string | null;
  playName: string;
  cfg?: AppConfig;
  /**
   * The emails already sent in this sequence, oldest first, for an offer
   * written mid-sequence: the offer continues what they named. Context for
   * the writer only, never research: nothing in it grounds a number, a
   * quote or the evidence.
   */
  thread?: ReadonlyArray<OfferThreadEmail>;
  /**
   * Offers the writer must not write again: the set "New offers" replaces.
   * Its first message names them, and a reply that repeats one is dropped
   * as a repeat.
   */
  avoid?: ReadonlyArray<string>;
  /**
   * The queue row the target came from, for the company research a weak set
   * gets before it is written again (`registerOfferResearch`). Absent, that
   * round writes from what the target holds. `waitMs` bounds the wait on a
   * click (see `OfferResearch`).
   */
  research?: { queueRowId: number; source: string; waitMs?: number };
  /** Told what each model call and research read cost, in USD. */
  onCost?: (usd: number) => void;
}

/** What the registered company research gave: the target, with research added when any came back. */
export interface OfferResearchResult {
  target: JsonRecord;
  /** True when new research is on the target. */
  researched: boolean;
  costUsd: number;
}

/**
 * Reads the firm's pages and its outside research for an offer, from the
 * queue row the target came from. Registered by `@oneshot-gtm/find`
 * (offer-research.ts), which owns company research, its per-row spend cap and
 * which rows need it, so plays never imports find. With `waitMs`, a read
 * still running past it comes back with the target as it was, and lands on a
 * live queue row when it finishes. Never throws.
 */
export type OfferResearch = (input: {
  target: JsonRecord;
  playName: string;
  queueRowId: number;
  source: string;
  waitMs?: number;
}) => Promise<OfferResearchResult>;

let offerResearch: OfferResearch | null = null;

export function registerOfferResearch(fn: OfferResearch | null): void {
  offerResearch = fn;
}

/** The registered company research; the target as it was when none is registered. */
export async function researchForOffer(
  input: Parameters<OfferResearch>[0],
): Promise<OfferResearchResult> {
  if (!offerResearch) return { target: input.target, researched: false, costUsd: 0 };
  return offerResearch(input);
}

/** True when the target's company research has its outside half (`status: "complete"`). */
function hasCompleteResearch(target: JsonRecord): boolean {
  const firm = target["productResearch"];
  return !!firm && typeof firm === "object" && (firm as JsonRecord)["status"] === "complete";
}

/** A row's offers: the active one (with its angles) and the ranked list it came from. */
export interface OfferSet {
  offer: ProspectOffer;
  candidates: ProspectOffer[];
}

/** No offer, because the writer declined: its reason, for the caller to keep and show. */
export interface OfferSkipped {
  skipped: OfferSkip;
}

/** What one writer run gave: the offers that passed, or, when none came back, the writer's skip. */
export interface DerivedOffers {
  offers: ProspectOffer[];
  /** Set only when the writer declined and no offer came back. */
  skip: OfferSkip | null;
}

/** True when an offer lookup ended in the writer's skip rather than an offer. */
export function isOfferSkipped(value: unknown): value is OfferSkipped {
  return !!value && typeof value === "object" && isOfferSkip((value as OfferSkipped).skipped);
}

/** The THREAD SO FAR block: each sent email, capped, oldest first. */
function threadBlock(thread: ReadonlyArray<OfferThreadEmail> | undefined): string | null {
  const emails = (thread ?? []).filter((e) => e.body.trim());
  if (emails.length === 0) return null;
  const parts = emails.map(
    (e, i) =>
      `--- email ${i + 1} ---\nSubject: ${clip(e.subject.trim(), 200)}\n${clip(e.body.trim(), THREAD_EMAIL_MAX)}`,
  );
  return `THREAD SO FAR:\n${clip(parts.join("\n"), THREAD_MAX)}`;
}

function offerUserMessage(input: DeriveOfferInput, cfg: AppConfig, research: string): string {
  const t = input.target as JsonRecord;
  const thread = threadBlock(input.thread);
  const avoid = avoidList(input);
  return [
    `PRODUCT: ${cfg.productOneLiner ?? ""}`,
    `PRODUCT BRIEF:\n${productBriefText(cfg, undefined, { max: BRIEF_MAX }) ?? ""}`,
    ...(cfg.pilotOffer?.trim() ? [`OFFER TERMS: ${cfg.pilotOffer.trim()}`] : []),
    ...neverOfferBlock(offerExclusionsOf(cfg)),
    ...anchorBlock(offerAnchorOf(cfg)),
    `PLAY: ${input.playName}`,
    `PROSPECT: ${firstString(t, ["name", "founderName", "guestName", "hostName"])}`,
    `TITLE: ${firstString(t, TITLE_KEYS)}`,
    `COMPANY: ${firstString(t, COMPANY_KEYS)}`,
    `RESEARCH:\n${research || "(none)"}`,
    ...(thread ? [thread] : []),
    ...(avoid.length > 0
      ? [`ALREADY OFFERED:\n${avoid.map((o) => `- ${clip(o, OFFER_MAX.offer)}`).join("\n")}`]
      : []),
  ].join("\n\n");
}

/** The NEVER OFFER section the writer and the judge read; none without exclusions. */
function neverOfferBlock(exclusions: readonly string[]): string[] {
  return exclusions.length > 0
    ? [`NEVER OFFER:\n${exclusions.map((e) => `- ${e}`).join("\n")}`]
    : [];
}

/**
 * The ANCHOR section the writer and the judge read. Nothing under `either`,
 * so a workspace that has not set the preference sends the message it always
 * sent, byte for byte.
 */
function anchorBlock(anchor: OfferAnchor): string[] {
  return anchor === "prefer-product"
    ? [
        "ANCHOR: prefer their product. Where RESEARCH says what their own product does, " +
          "the strongest offers are goals it would carry to completion for its own users, " +
          "and the best of those leads. Where RESEARCH says nothing about their product, " +
          "a firm-anchored offer is right and is not penalised.",
      ]
    : [];
}

/** The offers to write around, trimmed, without blanks. */
function avoidList(input: Pick<DeriveOfferInput, "avoid">): string[] {
  return (input.avoid ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
}

type DraftOffer = Omit<ProspectOffer, "version" | "inputHash" | "derivedAt">;
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** One offer's relevance verdict. */
export interface OfferJudgement {
  label: OfferRelevance;
  /** 0–1: the probability of `relevant`, when the engine gives one. */
  score: number | null;
  why: string;
  /** `<engine>:<model>`. */
  classifier: string;
  /**
   * The top label is `relevant` and P(relevant) is at least
   * `offerJudge.minConfidence` (the decisions answer's `confidence` only when
   * it gives no probabilities). The `llm` engine gives labels only: its
   * `relevant` passes.
   */
  pass: boolean;
  /**
   * Set (always true) when the offer is of a kind the workspace never offers
   * (`offerExclusions`). Its label is then `irrelevant` and it never passes.
   */
  excluded?: true;
}

const OFFER_RELEVANCE_LABELS: readonly OfferRelevance[] = ["relevant", "weak", "irrelevant"];
const DEFAULT_JUDGE_MIN_CONFIDENCE = 0.5;
// The judge checks `fit` against RESEARCH, so it sees what the writer saw.
const JUDGE_RESEARCH_MAX = RESEARCH_MAX;
const JUDGE_WHY_MAX = 140;

/**
 * The decisions-engine criteria for one offer's relevance. With `exclusions`
 * (the workspace's `offerExclusions`), an offer of one of those kinds is
 * `irrelevant`; without, the criteria are the same as ever.
 */
export function offerRelevanceCriteria(
  exclusions: readonly string[] = [],
  anchor: OfferAnchor = "either",
): Record<OfferRelevance, string> {
  const excluded =
    exclusions.length > 0
      ? ` Also irrelevant, whatever else is true of it: a goal of a kind listed under NEVER OFFER, in any wording (${exclusions.join("; ")}).`
      : "";
  // Narrow on purpose: only where RESEARCH plainly says what their product
  // does. Thin research leaves a firm-anchored offer exactly as strong as it
  // was, so the preference never turns into a hold on rows that know little.
  const preferProduct =
    anchor === "prefer-product"
      ? " Also weak: an offer resting on their firm where RESEARCH plainly says what their own product does and a goal of that product was available instead."
      : "";
  return {
    relevant:
      "A goal this firm at its stage would put on its plan, carried over weeks of work (by machine, with outside parties, or both) to a counted return (money in or no longer spent, or something signed, closed, launched or shipped), owned by or one step from this person, resting on a specific fact about them: what their own product does for its customers, or work their own firm visibly has.",
    weak: `Plausible, but generic (it would fit most firms of this kind unchanged) or resting on an industry, sector or customer word rather than a fact about this firm. Also weak: a single pass of checking, screening, vetting, verifying, scanning, auditing, validating or patching offered as the job itself, a forecast or analysis offered without the plan it changes, a return that is not a counted outcome this person owns or is one step from, an offer about a third party's project the person only follows, starred, forked or attended an event about, or one that restates the product's own capability rather than a goal of the prospect's firm or own project.${preferProduct}`,
    irrelevant: `A job this firm does not have: work for a department a firm of its size and stage does not have, a process in a market it only sells into, or work far from this person's role.${excluded}`,
  };
}

/** The decisions-engine criteria for whether one offer is of a kind the founder never offers. */
function offerExclusionCriteria(
  exclusions: readonly string[],
): Record<"excluded" | "allowed", string> {
  const kinds = exclusions.join("; ");
  return {
    excluded: `The offer's goal is of one of these kinds, in any wording: ${kinds}.`,
    allowed: `The offer's goal is of none of these kinds: ${kinds}.`,
  };
}

function isOfferRelevance(v: unknown): v is OfferRelevance {
  return typeof v === "string" && (OFFER_RELEVANCE_LABELS as readonly string[]).includes(v);
}

function judgeMinConfidence(cfg: AppConfig): number {
  const v = cfg.offerJudge?.minConfidence;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : DEFAULT_JUDGE_MIN_CONFIDENCE;
}

function describeOffer(o: Pick<ProspectOffer, "offer" | "return" | "fit">): string {
  return [
    `offer: ${o.offer}`,
    ...(o.return?.trim() ? [`returns: ${o.return.trim()}`] : []),
    ...(o.fit?.trim() ? [`fit: ${o.fit.trim()}`] : []),
  ].join("\n");
}

function judgeState(
  offers: ReadonlyArray<Pick<ProspectOffer, "offer" | "return" | "fit">>,
  research: string,
  who: { company: string; title: string },
  exclusions: readonly string[],
  anchor: OfferAnchor,
): string {
  return [
    `COMPANY: ${who.company}`,
    `TITLE: ${who.title}`,
    ...neverOfferBlock(exclusions),
    ...anchorBlock(anchor),
    `RESEARCH:\n${clip(research, JUDGE_RESEARCH_MAX) || "(none)"}`,
    `OFFERS:\n${offers.map((o, i) => `${i + 1}.\n${describeOffer(o)}`).join("\n\n")}`,
  ].join("\n\n");
}

async function judgeWithDecisions(
  offers: ReadonlyArray<Pick<ProspectOffer, "offer" | "return" | "fit">>,
  state: string,
  model: string,
  key: string,
  min: number,
  exclusions: readonly string[],
  anchor: OfferAnchor,
  fetchImpl: typeof fetch | undefined,
  onCost: ((usd: number) => void) | undefined,
): Promise<OfferJudgement[]> {
  const criteria = offerRelevanceCriteria(exclusions, anchor);
  const exclusionCriteria = exclusions.length > 0 ? offerExclusionCriteria(exclusions) : null;
  const questions: Record<string, DecisionsChoiceQuestion> = {};
  offers.forEach((o, i) => {
    questions[`offer_${i + 1}`] = {
      type: "choice",
      instructions:
        `A founder wants to offer this prospect's firm a goal their product would carry to completion ` +
        `over weeks of work, by machine, with outside parties, or both. ` +
        `Judge offer ${i + 1} in the state on its own: is it a real goal for this firm and this person? ` +
        `A market the firm sells into is not a need of the firm. A check is a step, not a goal: ` +
        `the offer should be what the check wins. How they were found is not what they own: an offer ` +
        `about a third party's project they only follow, or one restating what the product does, is weak.` +
        (exclusionCriteria
          ? ` A goal of a kind listed under NEVER OFFER, in any wording, is irrelevant.`
          : "") +
        `\nOffer ${i + 1}:\n${describeOffer(o)}`,
      criteria,
    };
    // Its own question, so an excluded offer is known as excluded, not only as irrelevant.
    if (exclusionCriteria) {
      questions[`excluded_${i + 1}`] = {
        type: "choice",
        instructions:
          `The founder never offers a goal of a kind listed under NEVER OFFER in the state. ` +
          `Is offer ${i + 1} a goal of one of those kinds, however it is worded?` +
          `\nOffer ${i + 1}:\n${describeOffer(o)}`,
        criteria: exclusionCriteria,
      };
    }
  });
  const res = await callDecisions({
    model,
    key,
    questions,
    state,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const classifier = `decisions:${res.model}`;
  if (res.costUsd != null) onCost?.(res.costUsd);
  logEvent("prospect_offer.judged", {
    engine: "decisions",
    count: offers.length,
    cost_micros: res.costUsd == null ? null : Math.round(res.costUsd * 1_000_000),
  });
  return offers.map((_, i) => {
    const a = res.answers[`offer_${i + 1}`]!;
    const label = a.choice as OfferRelevance;
    const p = a.probabilities?.["relevant"];
    // The bar is P(relevant), the label's own probability. The API's
    // `confidence` is a separate, lower number ("relevant 0.66, weak 0.30"
    // can come with a confidence of 0.3), so it stands in only when no
    // probabilities came back.
    const score =
      typeof p === "number"
        ? p
        : label === "relevant" && a.confidence != null
          ? a.confidence
          : null;
    const ex = res.answers[`excluded_${i + 1}`];
    if (ex?.choice === "excluded") {
      return {
        label: "irrelevant",
        score,
        why: topDecisionLabels(ex.probabilities, 1) || "excluded",
        classifier,
        pass: false,
        excluded: true,
      };
    }
    return {
      label,
      score,
      why: topDecisionLabels(a.probabilities) || label,
      classifier,
      pass: label === "relevant" && (score ?? 0) >= min,
    };
  });
}

async function judgeWithLlm(
  offers: ReadonlyArray<Pick<ProspectOffer, "offer" | "return" | "fit">>,
  state: string,
  cfg: AppConfig,
  exclusions: readonly string[],
  onCost: ((usd: number) => void) | undefined,
): Promise<Array<OfferJudgement | null>> {
  const res = await complete({
    messages: [
      { role: "system", content: loadPrompt("prospect-offer-judge") },
      { role: "user", content: state },
    ],
    temperature: 0,
    maxTokens: 1500,
  });
  if (res.costUsd != null) onCost?.(res.costUsd);
  const parsed = tryParseJsonObject<{ judgements?: unknown }>(res.content, {});
  const list = Array.isArray(parsed.judgements) ? parsed.judgements : [];
  const classifier = `llm:${cfg.llmModel ?? res.model}`;
  const byIndex = new Map<number, { label: OfferRelevance; why: string; excluded?: true }>();
  list.forEach((raw, position) => {
    if (!raw || typeof raw !== "object") return;
    const j = raw as { offer?: unknown; label?: unknown; why?: unknown; excluded?: unknown };
    // Only with NEVER OFFER given: an excluded offer is irrelevant whatever
    // label came with it, including none.
    const excluded = exclusions.length > 0 && j.excluded === true;
    if (!excluded && !isOfferRelevance(j.label)) return;
    const n = typeof j.offer === "number" && Number.isInteger(j.offer) ? j.offer - 1 : position;
    if (n < 0 || n >= offers.length || byIndex.has(n)) return;
    const why = typeof j.why === "string" ? clip(j.why.trim(), JUDGE_WHY_MAX) : "";
    if (excluded) {
      const text = why || "of a kind never offered";
      byIndex.set(n, {
        label: "irrelevant",
        why: text.startsWith("excluded") ? text : clip(`excluded: ${text}`, JUDGE_WHY_MAX),
        excluded: true,
      });
      return;
    }
    if (!isOfferRelevance(j.label)) return;
    byIndex.set(n, { label: j.label, why: why || j.label });
  });
  logEvent("prospect_offer.judged", {
    engine: "llm",
    count: offers.length,
    judged: byIndex.size,
  });
  return offers.map((_, i) => {
    const j = byIndex.get(i);
    return j ? { ...j, score: null, classifier, pass: j.label === "relevant" } : null;
  });
}

/**
 * Judge each offer's relevance to this firm and this person, with the
 * workspace's `offerJudge` engine. `decisions` asks one choice question per
 * offer in one request, and falls back to the `llm` judge prompt on a missing
 * key or model or any failure, like the reply classifier. One entry per offer;
 * null where no engine gave that offer a verdict. Null overall when no engine
 * ran at all: the caller keeps the offers unjudged rather than lose them.
 */
export async function judgeOffers(
  offers: ReadonlyArray<Pick<ProspectOffer, "offer" | "return" | "fit">>,
  research: string,
  row: object,
  cfg: AppConfig,
  opts: { fetchImpl?: typeof fetch; onCost?: (usd: number) => void } = {},
): Promise<Array<OfferJudgement | null> | null> {
  if (offers.length === 0) return [];
  const t = row as JsonRecord;
  const exclusions = offerExclusionsOf(cfg);
  const anchor = offerAnchorOf(cfg);
  const state = judgeState(
    offers,
    research,
    { company: firstString(t, COMPANY_KEYS), title: firstString(t, TITLE_KEYS) },
    exclusions,
    anchor,
  );
  if (cfg.offerJudge?.engine === "decisions") {
    const model = cfg.offerJudge.model?.trim();
    const key = process.env["OPENROUTER_API_KEY"]?.trim();
    if (model && key) {
      try {
        return await judgeWithDecisions(
          offers,
          state,
          model,
          key,
          judgeMinConfidence(cfg),
          exclusions,
          anchor,
          opts.fetchImpl,
          opts.onCost,
        );
      } catch (err) {
        logEvent(
          "prospect_offer.judge_fallback",
          {
            reason: "decisions_failed",
            message_120: ((err as Error)?.message ?? "").slice(0, 120),
          },
          "warn",
        );
      }
    } else {
      logEvent(
        "prospect_offer.judge_fallback",
        { reason: !model ? "no_model" : "no_openrouter_key" },
        "warn",
      );
    }
  }
  try {
    return await judgeWithLlm(offers, state, cfg, exclusions, opts.onCost);
  } catch (err) {
    logEvent(
      "error.swallowed",
      { kind: "prospect-offer-judge", message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

/**
 * The label an offer is stored with after a verdict. A passing offer is
 * `relevant` and one the judge labelled `weak` is `weak`: the judge's own
 * label. Two cases are stored `weak` although the judge said otherwise,
 * because `weak` is the label that holds a send for the founder
 * (`offerHoldsSend`) and neither offer passed:
 * - a `relevant` whose P(relevant) is under `offerJudge.minConfidence`. Stored
 *   as `relevant` it would go out unreviewed although the judge did not pass it.
 * - an `irrelevant` one, only in a re-judge of stored offers (which keeps
 *   every candidate). A fresh set never keeps an irrelevant offer.
 * The judge's own label stays readable in `relevanceWhy`.
 */
export function storedRelevance(j: Pick<OfferJudgement, "label" | "pass">): OfferRelevance {
  return j.pass ? j.label : "weak";
}

/** The judge's fields for an offer: `relevance`, its score, why and classifier. */
export function judgementFields(
  j: OfferJudgement,
): Pick<ProspectOffer, "relevance" | "relevanceScore" | "relevanceWhy" | "relevanceClassifier"> {
  const relevance = storedRelevance(j);
  return {
    relevance,
    ...(j.score != null ? { relevanceScore: Math.round(j.score * 1000) / 1000 } : {}),
    // A decisions why already leads with the labels ("relevant 0.45, weak
    // 0.40"); an llm why is free text, so name the label it overrode.
    relevanceWhy:
      relevance === j.label || j.why.startsWith(j.label)
        ? j.why
        : clip(`${j.label}: ${j.why}`, JUDGE_WHY_MAX),
    relevanceClassifier: j.classifier,
  };
}

function withJudgement(o: DraftOffer, j: OfferJudgement | null): DraftOffer {
  if (!j) return o;
  return { ...o, ...judgementFields(j) };
}

/**
 * What a lint flag means, for the repair round: the flags that name a rule
 * of the prompt rather than spell out what is wrong.
 */
const OFFER_FLAG_HINTS: ReadonlyArray<[flag: string, hint: string]> = [
  [
    "offer-not-execution",
    "the offer watches or reports instead of doing; name the action taken and its result",
  ],
  [
    "offer-is-a-check",
    "the offer is one pass of checking; name the multi-week goal that checking wins, with a counted return, and put the check in steps",
  ],
];

/** The repair round's explanation of the flags in `failed`; empty when none needs one. */
function offerRepairHints(failed: ReadonlyArray<string>): string {
  const flags = new Set(
    failed.flatMap((f) => f.slice(f.indexOf(":") + 1).split(",")).map((f) => f.trim()),
  );
  const hints = OFFER_FLAG_HINTS.filter(([flag]) => flags.has(flag)).map(
    ([flag, hint]) => `${flag}: ${hint}`,
  );
  return hints.length > 0 ? ` What the flags mean: ${hints.join("; ")}.` : "";
}

/**
 * Lint each offer in a reply, dropping failures and repeats (near-duplicates
 * of one already seen, `offersNearDuplicate`). The ones that pass come back
 * in the model's order; `failed` names what was wrong.
 */
function lintReply(
  content: string,
  research: string,
  product: string,
  oneLiner: string,
  seen: Set<string>,
): { kept: DraftOffer[]; failed: string[]; skip: string | null } {
  const raws = readRawList(content);
  if (!Array.isArray(raws)) return { kept: [], failed: [], skip: raws.skip };
  const kept: DraftOffer[] = [];
  const failed: string[] = [];
  raws.forEach((raw, i) => {
    const parsed = readRaw(raw);
    if (!parsed) return;
    const flags = lintOffer(parsed, research, product, oneLiner);
    if (flags.length > 0) {
      failed.push(`offer ${i + 1}: ${flags.join(", ")}`);
      return;
    }
    // A repeat, exact or reworded, is dropped and named, so a short set
    // gets the repair round like a lint failure. `seen` holds the offers as
    // written: a "$", a "%" or a capitalized name tells two apart.
    if (nearDuplicateOffer(parsed.offer, seen) !== null) {
      failed.push(`offer ${i + 1}: the same job as another offer`);
      return;
    }
    seen.add(parsed.offer);
    kept.push(parsed);
  });
  return { kept, failed, skip: null };
}

/**
 * Write OFFER_COUNT offers, ranked by return, in one call. Each is linted on
 * its own; the ones that fail get one repair round together. The ones that
 * pass are judged for relevance (`judgeOffers`): those the judge does not
 * pass are dropped, and one replacement round asks for as many new ones,
 * told why the dropped ones failed. Passing offers keep the model's order.
 * When still short of five, the best-scored `weak` ones fill the places,
 * tagged weak; an `irrelevant` or lint-failing offer never does. When the
 * judge passed none, one rescue round (`rescueWeakSet`) reads the firm's
 * research if the row has none complete and writes five again another way.
 * No offers when there is no brief, the model skips, or nothing passes; a
 * skip with nothing else kept comes back as `skip`, with the writer's why
 * and the input hash it read.
 */
export async function deriveOffers(
  input: DeriveOfferInput & { fetchImpl?: typeof fetch },
): Promise<DerivedOffers> {
  if (!playMakesOffer(input.playName)) return { offers: [], skip: null };
  const cfg = input.cfg ?? loadConfig();
  // The steps may claim only what the product brief says the product does.
  // With no brief there is nothing to ground them in.
  if (!cfg.productBrief?.trim()) return { offers: [], skip: null };
  let research = offerResearchText(input.target as JsonRecord, input.dossier);
  const messages: ChatMessage[] = [
    { role: "system", content: loadPrompt("prospect-offer") },
    { role: "user", content: offerUserMessage(input, cfg, research) },
  ];
  const product = `${cfg.productOneLiner ?? ""}\n${productBriefText(cfg)}`;
  const oneLiner = cfg.productOneLiner ?? "";
  let kept: DraftOffer[] = [];
  // The offers being replaced count as written: a reply repeating one is a repeat.
  const seen = new Set<string>(avoidList(input));
  let lastReply = "";
  let skipWhy: string | null = null;
  const spend = (usd: number | undefined): void => {
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) input.onCost?.(usd);
  };
  try {
    for (let round = 0; round < 2; round++) {
      const res = await complete({ messages, temperature: 0.4, maxTokens: 3000 });
      spend(res.costUsd);
      lastReply = res.content;
      const out = lintReply(res.content, research, product, oneLiner, seen);
      if (out.skip !== null) {
        skipWhy = out.skip;
        logEvent("prospect_offer.skipped", {
          play: input.playName,
          round,
          why_200: out.skip.slice(0, 200),
        });
        break;
      }
      kept.push(...out.kept);
      if (kept.length >= OFFER_COUNT || out.failed.length === 0) break;
      logEvent("prospect_offer.lint_failed", {
        play: input.playName,
        round,
        kept: kept.length,
        flags_200: out.failed.join("; ").slice(0, 200),
      });
      messages.push(
        { role: "assistant", content: res.content },
        {
          role: "user",
          content:
            `These offers cannot be used: ${out.failed.join("; ")}.${offerRepairHints(out.failed)} ` +
            `Return all five again, best return ` +
            `first, each within every rule, or {"skip": true, "why": "..."} if nothing supports ` +
            `one. JSON only.`,
        },
      );
    }
    kept = kept.slice(0, OFFER_COUNT);
    if (kept.length > 0) {
      const ctx: OfferRoundContext = {
        input,
        cfg,
        research,
        product,
        oneLiner,
        seen,
        messages,
        lastReply,
        spend,
      };
      const judged = await judgeAndReplace(kept, ctx);
      kept = judged.offers;
      if (judged.rejected.length > 0 && kept.every((o) => o.relevance === "weak")) {
        const rescued = await rescueWeakSet(kept, judged.rejected, ctx);
        kept = rescued.offers;
        research = rescued.research;
      }
    }
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "prospect-offer",
        play: input.playName,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
  }
  kept = preferProductAnchor(kept, offerAnchorOf(cfg));
  // Hashed after any research the rescue read: the row holds it now.
  const inputHash = offerInputHash(research, cfg);
  const derivedAt = new Date().toISOString();
  const productHash = offerProductHash(cfg);
  const offers: ProspectOffer[] = kept
    .slice(0, OFFER_COUNT)
    .map((o) =>
      Object.assign(o, { version: OFFER_PROMPT_VERSION, inputHash, productHash, derivedAt }),
    );
  if (offers.length > 0) {
    logEvent("prospect_offer.derived", {
      play: input.playName,
      count: offers.length,
      level: offers[0]!.level,
      weak: offers.filter((o) => o.relevance === "weak").length,
      offer_120: offers[0]!.offer.slice(0, 120),
    });
  }
  // A skip after a round that kept offers is no skip: those offers stand.
  const skip: OfferSkip | null =
    offers.length === 0 && skipWhy !== null
      ? {
          why: skipWhy,
          version: OFFER_PROMPT_VERSION,
          inputHash,
          productHash,
          skippedAt: derivedAt,
        }
      : null;
  return { offers, skip };
}

/** What the judge and replacement rounds share with the writer's first round. */
interface OfferRoundContext {
  input: DeriveOfferInput & { fetchImpl?: typeof fetch };
  cfg: AppConfig;
  research: string;
  product: string;
  oneLiner: string;
  seen: Set<string>;
  /** The writer's conversation; each round appends its reply and the next ask. */
  messages: ChatMessage[];
  /** The writer's latest reply, not yet in `messages`. */
  lastReply: string;
  spend: (usd: number | undefined) => void;
}

/** One offer the judge did not pass, with its score for the fill. */
interface Rejected {
  offer: DraftOffer;
  judgement: OfferJudgement;
}

/**
 * The judge's pass over the linted offers, and the one replacement round.
 * Offers the judge gave no verdict are kept as they are: a judge outage
 * never empties a row. `rejected` lists every offer the judge did not pass,
 * irrelevant ones included, from both rounds.
 */
async function judgeAndReplace(
  kept: DraftOffer[],
  ctx: OfferRoundContext,
): Promise<{ offers: DraftOffer[]; rejected: Rejected[] }> {
  const { input, cfg, research } = ctx;
  const judgeOpts = {
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    onCost: ctx.spend,
  };
  const verdicts = await judgeOffers(kept, research, input.target, cfg, judgeOpts);
  if (!verdicts) return { offers: kept, rejected: [] };
  const passing: DraftOffer[] = [];
  const fill: Array<{ offer: DraftOffer; score: number | null }> = [];
  const rejected: Rejected[] = [];
  const dropped: string[] = [];
  kept.forEach((o, i) => {
    const j = verdicts[i] ?? null;
    const judged = withJudgement(o, j);
    if (!j || j.pass) {
      passing.push(judged);
      return;
    }
    rejected.push({ offer: judged, judgement: j });
    dropped.push(`"${o.offer}": ${j.label}, ${j.why}`);
    if (j.label !== "irrelevant") fill.push({ offer: judged, score: j.score });
  });
  if (dropped.length > 0) {
    logEvent("prospect_offer.judge_dropped", {
      play: input.playName,
      dropped: dropped.length,
      kept: passing.length,
      why_200: dropped.join("; ").slice(0, 200),
    });
  }
  const missing = OFFER_COUNT - passing.length;
  if (dropped.length > 0 && missing > 0) {
    const keptList = passing.map((o) => `- ${o.offer}`).join("\n");
    ctx.messages.push(
      { role: "assistant", content: ctx.lastReply },
      {
        role: "user",
        content:
          `A relevance check dropped these offers: ${dropped.join("; ")}. ` +
          `Write exactly ${missing} new ${missing === 1 ? "offer" : "offers"}, best return first, ` +
          `each a different job from ${keptList ? `the ones kept:\n${keptList}\n` : "the dropped ones, "}` +
          `each resting on an anchor (their product or their firm) and a fact in RESEARCH, ` +
          `never on an industry word alone, each a multi-week goal with a counted return this ` +
          `person owns (never one pass of checking), and within every rule. ` +
          `Return {"offers": [...]} with the same fields. JSON only.`,
      },
    );
    try {
      const res = await complete({ messages: ctx.messages, temperature: 0.4, maxTokens: 3000 });
      ctx.spend(res.costUsd);
      ctx.lastReply = res.content;
      const out = lintReply(res.content, research, ctx.product, ctx.oneLiner, ctx.seen);
      const fresh = out.kept.slice(0, missing);
      if (out.failed.length > 0) {
        logEvent("prospect_offer.lint_failed", {
          play: input.playName,
          round: "replacement",
          kept: fresh.length,
          flags_200: out.failed.join("; ").slice(0, 200),
        });
      }
      if (fresh.length > 0) {
        const more = await judgeOffers(fresh, research, input.target, cfg, judgeOpts);
        fresh.forEach((o, i) => {
          const j = more?.[i] ?? null;
          const judged = withJudgement(o, j);
          if (!j || j.pass) {
            passing.push(judged);
            return;
          }
          rejected.push({ offer: judged, judgement: j });
          if (j.label !== "irrelevant") fill.push({ offer: judged, score: j.score });
        });
      }
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "prospect-offer-replace",
          play: input.playName,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
  }
  return { offers: withFillers(passing, fill), rejected };
}

/**
 * The passing offers, then the best-scored ones that did not pass up to
 * five; equal (or no) scores keep the order written. Each filler carries the
 * label `withJudgement` stored (`storedRelevance`): `weak` as the judge
 * labelled it, or a `relevant` under the bar stored `weak`, so every filler
 * holds its send.
 */
function withFillers(
  passing: DraftOffer[],
  fill: ReadonlyArray<{ offer: DraftOffer; score: number | null }>,
): DraftOffer[] {
  if (passing.length >= OFFER_COUNT) return passing.slice(0, OFFER_COUNT);
  const fillers = fill
    .toSorted((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, OFFER_COUNT - passing.length)
    .map(({ offer }) => offer);
  return [...passing, ...fillers];
}

/**
 * The rescue round, for a set the judge passed none of. The writer had the
 * facts it had, and the judge says only how weak each offer was, so a plain
 * retry writes the same offers again. First, when the row's company research
 * is missing or lacks its outside half, it is read once (the registered
 * `OfferResearch`, within find's per-row cap). Then the writer is asked again
 * in the same conversation (`prospect-offer-rescue`): the rejected offers,
 * what the judge means by weak, and a different approach, built on the most
 * specific facts RESEARCH holds. Passing offers lead; the rest of the five
 * are the best-scored weak ones of every round. When nothing passes the set
 * stays as it was. Never throws.
 */
async function rescueWeakSet(
  weak: DraftOffer[],
  rejected: ReadonlyArray<Rejected>,
  ctx: OfferRoundContext,
): Promise<{ offers: DraftOffer[]; research: string }> {
  const { input, cfg } = ctx;
  let research = ctx.research;
  let cost = 0;
  const spend = (usd: number | undefined): void => {
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) cost += usd;
    ctx.spend(usd);
  };
  let target = input.target as JsonRecord;
  let researched = false;
  if (input.research && !hasCompleteResearch(target)) {
    const out = await researchForOffer({
      target,
      playName: input.playName,
      queueRowId: input.research.queueRowId,
      source: input.research.source,
      ...(input.research.waitMs !== undefined ? { waitMs: input.research.waitMs } : {}),
    });
    spend(out.costUsd);
    if (out.researched) {
      const next = offerResearchText(out.target, input.dossier);
      researched = next !== research;
      target = out.target;
      research = next;
    }
  }
  const criteria = offerRelevanceCriteria();
  const content = loadPrompt("prospect-offer-rescue")
    .replace("{{rejected}}", () =>
      rejected
        .map(({ offer, judgement }) => `- "${offer.offer}": ${judgement.label}, ${judgement.why}`)
        .join("\n"),
    )
    .replace("{{weak}}", () => criteria.weak)
    .replace("{{research}}", () =>
      researched ? `New research about this firm was read. RESEARCH is now:\n${research}\n\n` : "",
    );
  if (ctx.messages.at(-1)?.role !== "assistant") {
    ctx.messages.push({ role: "assistant", content: ctx.lastReply });
  }
  ctx.messages.push({ role: "user", content });
  let offers = weak;
  let passed = 0;
  try {
    const res = await complete({ messages: ctx.messages, temperature: 0.7, maxTokens: 3000 });
    spend(res.costUsd);
    const out = lintReply(res.content, research, ctx.product, ctx.oneLiner, ctx.seen);
    if (out.failed.length > 0) {
      logEvent("prospect_offer.lint_failed", {
        play: input.playName,
        round: "rescue",
        kept: out.kept.length,
        flags_200: out.failed.join("; ").slice(0, 200),
      });
    }
    const fresh = out.kept.slice(0, OFFER_COUNT);
    if (fresh.length > 0) {
      const judgeOpts = {
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        onCost: spend,
      };
      const verdicts = await judgeOffers(fresh, research, target, cfg, judgeOpts);
      if (verdicts) {
        const passing: DraftOffer[] = [];
        // The earlier rounds' weak offers keep their scores and come first
        // on a tie: they were written first.
        const fill = weak.map((o) => ({ offer: o, score: o.relevanceScore ?? null }));
        fresh.forEach((o, i) => {
          const j = verdicts[i] ?? null;
          // No verdict: unknown, so it never takes a place from a judged offer.
          if (!j) return;
          const judged = withJudgement(o, j);
          if (j.pass) passing.push(judged);
          else if (j.label !== "irrelevant") fill.push({ offer: judged, score: j.score });
        });
        passed = passing.length;
        offers = withFillers(passing, fill);
      }
    }
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "prospect-offer-rescue",
        play: input.playName,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
  }
  logEvent("prospect_offer.rescue", {
    play: input.playName,
    researched,
    passed,
    cost_micros: Math.round(cost * 1_000_000),
  });
  return { offers, research };
}

/** Flags for one written angle, keyed on its text alone. */
export function lintOfferAngle(angle: string, research: string, product: string): string[] {
  const flags: string[] = [];
  const text = angle.trim();
  if (!text) return ["empty"];
  if (text.length > OFFER_MAX.angle) flags.push("too-long");
  if (text.includes(ANGLE_SEPARATOR)) flags.push("separator");
  if (AWARENESS_LEAD.test(text)) flags.push("awareness-lead");
  for (const [flag, pattern] of BANNED)
    if (flag !== "punctuation" && pattern.test(text)) flags.push(flag);
  if (slopFlags(text).includes("negative-parallelism")) flags.push("negation-contrast");
  for (const n of text.match(/\d[\d,.]*/g) ?? []) {
    const bare = n.replace(/[.,]$/, "");
    if (!research.includes(bare) && !product.includes(bare)) flags.push(`number:${n}`);
  }
  return flags;
}

/**
 * Write OFFER_ANGLE_COUNT reasons the offer pays back, for its first message
 * and each follow-up. The founder's own angles on the row's edge are passed
 * as reasons the writer may reuse. Angles that fail lint are dropped; one
 * retry when fewer than two survive. A finished attempt returns what
 * survived, possibly nothing; a failed call (provider error) returns null, so
 * the caller can tell "none usable" from "try again later". With no angles
 * the draft falls back to the row's own edge.
 */
export async function deriveOfferAngles(
  input: DeriveOfferInput & { offer: Pick<ProspectOffer, "offer" | "steps" | "return"> },
): Promise<string[] | null> {
  const cfg = input.cfg ?? loadConfig();
  if (!cfg.productBrief?.trim()) return [];
  const t = input.target as JsonRecord;
  const research = offerResearchText(t, input.dossier);
  const field = edgeFieldOf(t);
  const founderAngles = field ? splitEdgeAngles(String(t[field])) : [];
  const brief = (productBriefText(cfg) ?? "").trim();
  const product = `${cfg.productOneLiner ?? ""}\n${brief}`;
  const user = [
    `OFFER: ${input.offer.offer}`,
    ...(input.offer.return?.trim() ? [`RETURN: ${input.offer.return.trim()}`] : []),
    ...(input.offer.steps.trim() ? [`HOW: ${input.offer.steps.trim()}`] : []),
    `PRODUCT: ${cfg.productOneLiner ?? ""}`,
    `PRODUCT BRIEF:\n${productBriefText(cfg, undefined, { max: BRIEF_MAX }) ?? ""}`,
    ...(founderAngles.length > 0
      ? [`FOUNDER'S ANGLES:\n${founderAngles.map((a) => `- ${a}`).join("\n")}`]
      : []),
    `PLAY: ${input.playName}`,
    `PROSPECT:\n${research || "(nothing known beyond the offer)"}`,
  ].join("\n\n");
  const offerKey = angleTextKey(input.offer.offer);
  try {
    for (let round = 0; round < 2; round++) {
      const res = await complete({
        messages: [
          { role: "system", content: loadPrompt("offer-angles") },
          { role: "user", content: user },
        ],
        temperature: 0.6,
        maxTokens: 2500,
      });
      if (res.costUsd != null && res.costUsd > 0) input.onCost?.(res.costUsd);
      const parsed = tryParseJsonObject<{ angles?: unknown }>(res.content, {});
      const raw = Array.isArray(parsed.angles) ? parsed.angles : [];
      const seen = new Set<string>([offerKey]);
      const out: string[] = [];
      const dropped: string[] = [];
      for (const value of raw) {
        const text = typeof value === "string" ? value.trim() : "";
        const flags = lintOfferAngle(text, research, product);
        const key = angleTextKey(text);
        if (flags.length > 0 || seen.has(key)) {
          dropped.push(flags.join(",") || "duplicate");
          continue;
        }
        seen.add(key);
        out.push(text);
      }
      if (dropped.length > 0) {
        logEvent("prospect_offer.angles_dropped", {
          play: input.playName,
          round,
          kept: out.length,
          flags_200: dropped.join("; ").slice(0, 200),
        });
      }
      if (out.length >= 2 || round === 1) return out.slice(0, OFFER_ANGLE_COUNT);
    }
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "offer-angles",
        play: input.playName,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
  return [];
}

/**
 * The offer with its angles written. A finished attempt is recorded even
 * when nothing usable came back (`angles: []`), so drafts do not pay for it
 * again; a failed call leaves the offer as it was, to be tried next time.
 */
export async function withOfferAngles(
  offer: ProspectOffer,
  input: DeriveOfferInput,
): Promise<ProspectOffer> {
  const angles = await deriveOfferAngles({ ...input, offer });
  return angles === null ? offer : { ...offer, angles };
}

/** True once an angle attempt finished for this offer, usable angles or not. */
export function offerAnglesWritten(offer: Pick<ProspectOffer, "angles">): boolean {
  return Array.isArray(offer.angles);
}

/**
 * Five ranked offers and the first one's angles. `skipped` when the writer
 * declined, with its why; null when no offer can be written otherwise: no
 * brief, or nothing passes lint.
 */
export async function deriveOfferSet(
  input: DeriveOfferInput,
): Promise<OfferSet | OfferSkipped | null> {
  const cfg = input.cfg ?? loadConfig();
  const { offers, skip } = await deriveOffers({ ...input, cfg });
  if (offers.length === 0) return skip ? { skipped: skip } : null;
  const offer = await withOfferAngles(offers[0]!, { ...input, cfg });
  return { offer, candidates: [offer, ...offers.slice(1)] };
}

/** The active offer of an offer lookup; null when it gave none, a skip included. */
function activeOf(set: OfferSet | OfferSkipped | null): ProspectOffer | null {
  return set && !isOfferSkipped(set) ? set.offer : null;
}

/** One offer, the best of a fresh set: for callers that keep only the active one. */
export async function deriveOffer(input: DeriveOfferInput): Promise<ProspectOffer | null> {
  return activeOf(await deriveOfferSet(input));
}

/** The ranked offers a queue payload carries, when it has any. */
export function offerCandidatesOf(payload: Record<string, unknown>): ProspectOffer[] {
  const list = payload["offerCandidates"];
  return Array.isArray(list) ? list.filter(isProspectOffer) : [];
}

/**
 * The offers a queue row should carry: the stored set when its active offer
 * is current (or the founder's), with angles written if they are missing,
 * else a fresh set. A writer skip stored on the target (`offerSkip`) that is
 * current stands in for a fresh set: the writer would read the same input,
 * so it is not asked again. `changed` says whether the caller has anything
 * to persist (a fresh set, or a fresh skip).
 */
export async function ensureOfferSet(
  input: DeriveOfferInput,
): Promise<((OfferSet | OfferSkipped) & { changed: boolean }) | null> {
  if (!playMakesOffer(input.playName)) return null;
  const cfg = input.cfg ?? loadConfig();
  const t = input.target as JsonRecord;
  const stored = t["offer"];
  const research = offerResearchText(t, input.dossier);
  const inputHash = offerInputHash(research, cfg);
  if (offerIsCurrent(stored, inputHash) || approvedOfferStands(stored, t, input.dossier, cfg)) {
    const candidates = offerCandidatesOf(t);
    if (offerAnglesWritten(stored) || !cfg.productBrief?.trim()) {
      return { offer: stored, candidates, changed: false };
    }
    const offer = await withOfferAngles(stored, { ...input, cfg });
    return { offer, candidates, changed: offer !== stored };
  }
  const skip = t["offerSkip"];
  if (cfg.productBrief?.trim() && offerSkipIsCurrent(skip, inputHash)) {
    return { skipped: skip, changed: false };
  }
  const fresh = await deriveOfferSet({ ...input, cfg });
  return fresh ? { ...fresh, changed: true } : null;
}

/**
 * The offer a queue row should carry: the stored one when current (or the
 * founder's), else a fresh one. The caller persists a fresh one.
 */
export async function ensureOffer(input: DeriveOfferInput): Promise<ProspectOffer | null> {
  return activeOf(await ensureOfferSet(input));
}

/**
 * The offer a draft is written around. A stored offer of the current version
 * is used as it stands, even though the play's enrichment adds research it
 * never saw: re-deriving on every draft would change the offer under the
 * founder's feet. A change to the product config is different: the offer's
 * claims rest on the brief, so it is written again. A founder's own offer is
 * always kept. With no brief there is no offer.
 */
export async function offerForDraft(input: DeriveOfferInput): Promise<ProspectOffer | null> {
  return activeOf(await offerSetForDraft(input));
}

/**
 * `offerForDraft` with where the offer came from: `derived` when this call
 * wrote it (nothing current was stored), with the ranked set it came from,
 * so a caller holding a queue row can store it there. A writer skip stored
 * on the target (`offerSkip`) under today's prompt and product config is
 * kept as it stands, as a stored offer is (the queue's `ensureOfferSet`
 * already asked the writer about the row's own research): `skipped`.
 */
export async function offerSetForDraft(
  input: DeriveOfferInput,
): Promise<((OfferSet | OfferSkipped) & { derived: boolean }) | null> {
  if (!playMakesOffer(input.playName)) return null;
  const cfg = input.cfg ?? loadConfig();
  const t = input.target as JsonRecord;
  const stored = t["offer"];
  if (isProspectOffer(stored) && stored.editedBy === "founder") {
    return { offer: stored, candidates: offerCandidatesOf(t), derived: false };
  }
  if (!cfg.productBrief?.trim()) return null;
  // A current-version offer is kept whatever research the play's enrichment
  // added (see `offerForDraft`). An approved one of an older version is kept
  // only while it answers to the research it was written from: the row's own
  // (as `ensureOfferSet` writes it) or the row's with this dossier (as a
  // draft that wrote it did). A prompt bump alone never rewrites it.
  if (
    isProspectOffer(stored) &&
    (stored.version === OFFER_PROMPT_VERSION ||
      approvedOfferStands(stored, t, null, cfg) ||
      approvedOfferStands(stored, t, input.dossier, cfg)) &&
    stored.productHash === offerProductHash(cfg)
  ) {
    return { offer: stored, candidates: offerCandidatesOf(t), derived: false };
  }
  const skip = t["offerSkip"];
  if (
    isOfferSkip(skip) &&
    skip.version === OFFER_PROMPT_VERSION &&
    skip.productHash === offerProductHash(cfg)
  ) {
    return { skipped: skip, derived: false };
  }
  const fresh = await deriveOfferSet({ ...input, cfg });
  return fresh ? { ...fresh, derived: true } : null;
}

/**
 * Plays whose sequence never carries the founder's general terms. Kept from
 * before prospect offers: an accelerator-batch sequence ends on a plain
 * breakup, never a pilot.
 */
const NO_TERMS_PLAYS: ReadonlySet<string> = new Set(["accelerator-batch"]);

/**
 * The lines every outreach writer gets: the offer for this prospect, how the
 * product delivers it, the founder's general terms and the product facts.
 */
export function offerBlock(
  offer: Pick<ProspectOffer, "offer" | "steps" | "return"> | null,
  cfg: Pick<AppConfig, "pilotOffer" | "productBrief">,
  playName: string,
  opts: { brief?: boolean } = {},
): string | null {
  if (!playMakesOffer(playName)) return null;
  const lines: string[] = [];
  if (offer) {
    lines.push(`OFFER (what you offer to do for them; the message opens with it): ${offer.offer}`);
    if (offer.return?.trim()) {
      lines.push(`RETURN (what they get back when it is done): ${offer.return.trim()}`);
    }
    if (offer.steps.trim()) {
      lines.push(
        `HOW (how the product delivers it; material, never a list in the message): ${offer.steps}`,
      );
    }
  }
  if (cfg.pilotOffer?.trim() && !NO_TERMS_PLAYS.has(playName)) {
    lines.push(
      `OFFER TERMS (the founder's general terms; never a price): ${cfg.pilotOffer.trim()}`,
    );
  }
  if (opts.brief !== false && cfg.productBrief?.trim()) {
    lines.push(
      `PRODUCT BRIEF (the only source of product claims):\n${productBriefText(cfg, undefined, { max: BRIEF_MAX }) ?? ""}`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** What the founder reads on a row held for a weak offer. */
export const WEAK_OFFER_HOLD_REASON =
  "The offer was rated a weak fit for this firm. Rewrite it, pick another, or approve it.";

/**
 * True when this offer must not go out as it stands: the relevance judge
 * rated it `weak` (kept only to make up the five), the founder did not write
 * it, and the founder has not approved it anyway. Rewriting it, picking
 * another or approving it releases the send; redrafting the letter does not.
 */
export function offerHoldsSend(offer: unknown): boolean {
  if (!isProspectOffer(offer)) return false;
  return offer.relevance === "weak" && offer.editedBy !== "founder" && !offerWeakApproved(offer);
}

/**
 * Under `prefer-product`, the ranked offers with the product-anchored ones
 * that would go out moved to the front. Stable: the order inside each group
 * is the model's, so the best return still leads within it, and an offer the
 * judge did not pass never overtakes one it did. Under `either` the list
 * comes back untouched, which is every workspace that has not set the
 * preference.
 *
 * `anchor` absent reads as unknown, not as `firm`, so a set written before
 * the writer emitted the field keeps its order exactly. An offer the judge
 * gave no verdict on is unknown too: `judgeAndReplace` keeps it (a missing
 * judgement is not a failure), but it was never assessed, so it holds its
 * place rather than overtaking one that passed.
 */
export function preferProductAnchor<
  T extends Pick<ProspectOffer, "offer" | "steps" | "anchor" | "relevance">,
>(offers: readonly T[], anchor: OfferAnchor): T[] {
  if (anchor !== "prefer-product") return [...offers];
  // `relevance` set means the judge assessed it; `!offerHoldsSend` then means
  // it may go out, which keeps the founder's approval of a weak offer working.
  const leads = (o: T): boolean =>
    o.anchor === "product" && o.relevance !== undefined && !offerHoldsSend(o);
  return [...offers.filter(leads), ...offers.filter((o) => !leads(o))];
}

/** True when a queue row of this play is held for its active offer (`offerHoldsSend`). */
export function weakOfferHold(playName: string, payload: unknown): boolean {
  if (!playMakesOffer(playName)) return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return offerHoldsSend((payload as JsonRecord)["offer"]);
}

/**
 * The payload patch that makes `offer` a row's active offer. The ledger
 * applies it as a JSON merge patch, which merges nested objects key by key, so
 * every key of the previous offer the new one lacks is named with null (which
 * deletes it). Otherwise the old offer's approval, judge label or fit would
 * carry over onto the new one. A writer skip the row kept is deleted too:
 * the row has an offer now.
 */
export function activeOfferPatch(
  previous: unknown,
  offer: ProspectOffer,
  candidates: ProspectOffer[],
): { offer: Record<string, unknown>; offerCandidates: ProspectOffer[]; offerSkip: null } {
  const next: Record<string, unknown> = { ...offer };
  if (previous && typeof previous === "object" && !Array.isArray(previous)) {
    for (const key of Object.keys(previous)) if (next[key] === undefined) next[key] = null;
  }
  return { offer: next, offerCandidates: candidates, offerSkip: null };
}

/**
 * True when an intro of this play must not go out for want of an offer: the
 * play makes one, the workspace has a product brief to write it from, and
 * none could be written. Without a brief no play makes offers, so nothing
 * is held.
 */
export function offerMissingHoldsSend(
  playName: string,
  offer: unknown,
  cfg: Pick<AppConfig, "productBrief">,
): boolean {
  return playMakesOffer(playName) && !isProspectOffer(offer) && !!cfg.productBrief?.trim();
}

/** The offer a queue payload carries, when it has one. */
export function offerOf(payload: Record<string, unknown>): ProspectOffer | null {
  const o = payload["offer"];
  return isProspectOffer(o) ? o : null;
}
