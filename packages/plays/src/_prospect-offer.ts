/**
 * The prospect offer: the founder's offer made specific to one prospect's
 * firm. It is the outcome the founder's product would deliver there, written
 * from everything known about the person and the firm. Every outreach
 * message opens with it.
 *
 * Product facts come only from config: `productOneLiner`, `productBrief`, and
 * `pilotOffer` (the general terms: a pilot, a trial, a partnership). Nothing
 * here names a product or assumes what kind of offer a founder makes.
 *
 * It is stored on the queue row (`payload.offer`) and on the first send's
 * step-0 metadata, so every later touch carries the same one. An offer the
 * founder edited is never re-derived.
 */
import { createHash } from "node:crypto";
import { isPersonResearchDossier, loadConfig, logEvent } from "@oneshot-gtm/core";
import {
  callDecisions,
  complete,
  loadPrompt,
  topDecisionLabels,
  tryParseJsonObject,
  type DecisionsChoiceQuestion,
} from "@oneshot-gtm/intel";
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
export const OFFER_PROMPT_VERSION = "offer-v4";

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
  derivedAt: string;
}

export type OfferRelevance = "relevant" | "weak" | "irrelevant";

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

/**
 * Everything known about the person and the firm, as one text the offer is
 * written from and its evidence and numbers are checked against.
 */
export function offerResearchText(target: object, dossier?: string | null): string {
  const t = target as JsonRecord;
  const parts: string[] = [];
  const row = describeTargetForAngle(t, null).trim();
  if (row) parts.push(`HOW THEY WERE FOUND AND WHAT THE ROW SAYS:\n${row}`);
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
): string {
  return createHash("sha256")
    .update(
      [
        OFFER_PROMPT_VERSION,
        research,
        cfg.productOneLiner ?? "",
        cfg.productBrief ?? "",
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
      [cfg.productOneLiner ?? "", cfg.productBrief ?? "", cfg.pilotOffer ?? ""].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 16);
}

/** True when the stored offer still answers to today's inputs, or the founder wrote it. */
export function offerIsCurrent(stored: unknown, inputHash: string): stored is ProspectOffer {
  if (!isProspectOffer(stored)) return false;
  if (stored.editedBy === "founder") return true;
  return stored.version === OFFER_PROMPT_VERSION && stored.inputHash === inputHash;
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
  return {
    offer,
    steps,
    evidence,
    stage: typeof raw.stage === "string" ? raw.stage.trim().slice(0, 60) : "",
    level: raw.level === "role" ? "role" : "researched",
    ...(ret ? { return: ret } : {}),
    ...(fit ? { fit } : {}),
  };
}

/** The offers in a model reply: `{offers: [...]}`, or a lone offer object. */
function readRawList(content: string): RawOffer[] | "skip" {
  const parsed = tryParseJsonObject<{ offers?: unknown; skip?: unknown } & RawOffer>(content, {});
  if (parsed.skip === true) return "skip";
  if (Array.isArray(parsed.offers)) {
    return parsed.offers.filter(
      (o): o is RawOffer => !!o && typeof o === "object" && !Array.isArray(o),
    );
  }
  return typeof parsed.offer === "string" ? [parsed] : [];
}

export interface DeriveOfferInput {
  target: object;
  /** Extra research the caller holds (a play's enrichment dossier). */
  dossier?: string | null;
  playName: string;
  cfg?: AppConfig;
}

/** A row's offers: the active one (with its angles) and the ranked list it came from. */
export interface OfferSet {
  offer: ProspectOffer;
  candidates: ProspectOffer[];
}

function offerUserMessage(input: DeriveOfferInput, cfg: AppConfig, research: string): string {
  const t = input.target as JsonRecord;
  return [
    `PRODUCT: ${cfg.productOneLiner ?? ""}`,
    `PRODUCT BRIEF:\n${clip((cfg.productBrief ?? "").trim(), BRIEF_MAX)}`,
    ...(cfg.pilotOffer?.trim() ? [`OFFER TERMS: ${cfg.pilotOffer.trim()}`] : []),
    `PLAY: ${input.playName}`,
    `PROSPECT: ${firstString(t, ["name", "founderName", "guestName", "hostName"])}`,
    `TITLE: ${firstString(t, TITLE_KEYS)}`,
    `COMPANY: ${firstString(t, COMPANY_KEYS)}`,
    `RESEARCH:\n${research || "(none)"}`,
  ].join("\n\n");
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
  /** `relevant` with at least the configured confidence. */
  pass: boolean;
}

const OFFER_RELEVANCE_LABELS: readonly OfferRelevance[] = ["relevant", "weak", "irrelevant"];
const DEFAULT_JUDGE_MIN_CONFIDENCE = 0.5;
const JUDGE_RESEARCH_MAX = 6_000;
const JUDGE_WHY_MAX = 140;

/** The decisions-engine criteria for one offer's relevance. */
export function offerRelevanceCriteria(): Record<OfferRelevance, string> {
  return {
    relevant:
      "A real job for this firm at its stage, owned by or close to this person's role, resting on a specific fact about them: what their own product does for its customers, or work their own firm visibly has.",
    weak: "Plausible, but generic (it would fit most firms of this kind unchanged) or resting on an industry, sector or customer word rather than a fact about this firm.",
    irrelevant:
      "A job this firm does not have: work for a department a firm of its size and stage does not have, a process in a market it only sells into, or work far from this person's role.",
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
): string {
  return [
    `COMPANY: ${who.company}`,
    `TITLE: ${who.title}`,
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
  fetchImpl: typeof fetch | undefined,
): Promise<OfferJudgement[]> {
  const criteria = offerRelevanceCriteria();
  const questions: Record<string, DecisionsChoiceQuestion> = {};
  offers.forEach((o, i) => {
    questions[`offer_${i + 1}`] = {
      type: "choice",
      instructions:
        `A founder wants to offer this prospect's firm a job their product would carry to completion. ` +
        `Judge offer ${i + 1} in the state on its own: is it a real job for this firm and this person? ` +
        `A market the firm sells into is not a need of the firm.\nOffer ${i + 1}:\n${describeOffer(o)}`,
      criteria,
    };
  });
  const res = await callDecisions({
    model,
    key,
    questions,
    state,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const classifier = `decisions:${res.model}`;
  logEvent("prospect_offer.judged", {
    engine: "decisions",
    count: offers.length,
    cost_micros: res.costUsd == null ? null : Math.round(res.costUsd * 1_000_000),
  });
  return offers.map((_, i) => {
    const a = res.answers[`offer_${i + 1}`]!;
    const label = a.choice as OfferRelevance;
    const p = a.probabilities?.["relevant"];
    const score =
      typeof p === "number"
        ? p
        : label === "relevant" && a.confidence != null
          ? a.confidence
          : null;
    return {
      label,
      score,
      why: topDecisionLabels(a.probabilities) || label,
      classifier,
      pass: label === "relevant" && (a.confidence ?? score ?? 0) >= min,
    };
  });
}

async function judgeWithLlm(
  offers: ReadonlyArray<Pick<ProspectOffer, "offer" | "return" | "fit">>,
  state: string,
  cfg: AppConfig,
): Promise<Array<OfferJudgement | null>> {
  const res = await complete({
    messages: [
      { role: "system", content: loadPrompt("prospect-offer-judge") },
      { role: "user", content: state },
    ],
    temperature: 0,
    maxTokens: 1500,
  });
  const parsed = tryParseJsonObject<{ judgements?: unknown }>(res.content, {});
  const list = Array.isArray(parsed.judgements) ? parsed.judgements : [];
  const classifier = `llm:${cfg.llmModel ?? res.model}`;
  const byIndex = new Map<number, { label: OfferRelevance; why: string }>();
  list.forEach((raw, position) => {
    if (!raw || typeof raw !== "object") return;
    const j = raw as { offer?: unknown; label?: unknown; why?: unknown };
    if (!isOfferRelevance(j.label)) return;
    const n = typeof j.offer === "number" && Number.isInteger(j.offer) ? j.offer - 1 : position;
    if (n < 0 || n >= offers.length || byIndex.has(n)) return;
    const why = typeof j.why === "string" ? clip(j.why.trim(), JUDGE_WHY_MAX) : "";
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
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Array<OfferJudgement | null> | null> {
  if (offers.length === 0) return [];
  const t = row as JsonRecord;
  const state = judgeState(offers, research, {
    company: firstString(t, COMPANY_KEYS),
    title: firstString(t, TITLE_KEYS),
  });
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
          opts.fetchImpl,
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
    return await judgeWithLlm(offers, state, cfg);
  } catch (err) {
    logEvent(
      "error.swallowed",
      { kind: "prospect-offer-judge", message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

function withJudgement(o: DraftOffer, j: OfferJudgement | null): DraftOffer {
  if (!j) return o;
  return {
    ...o,
    relevance: j.label,
    ...(j.score != null ? { relevanceScore: Math.round(j.score * 1000) / 1000 } : {}),
    relevanceWhy: j.why,
    relevanceClassifier: j.classifier,
  };
}

/**
 * Lint each offer in a reply, dropping failures and repeats. The ones that
 * pass come back in the model's order; `failed` names what was wrong.
 */
function lintReply(
  content: string,
  research: string,
  product: string,
  oneLiner: string,
  seen: Set<string>,
): { kept: DraftOffer[]; failed: string[]; skip: boolean } {
  const raws = readRawList(content);
  if (raws === "skip") return { kept: [], failed: [], skip: true };
  const kept: DraftOffer[] = [];
  const failed: string[] = [];
  raws.forEach((raw, i) => {
    const parsed = readRaw(raw);
    if (!parsed) return;
    const flags = lintOffer(parsed, research, product, oneLiner);
    const key = angleTextKey(parsed.offer);
    if (flags.length > 0) {
      failed.push(`offer ${i + 1}: ${flags.join(", ")}`);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    kept.push(parsed);
  });
  return { kept, failed, skip: false };
}

/**
 * Write OFFER_COUNT offers, ranked by return, in one call. Each is linted on
 * its own; the ones that fail get one repair round together. The ones that
 * pass are judged for relevance (`judgeOffers`): those the judge does not
 * pass are dropped, and one replacement round asks for as many new ones,
 * told why the dropped ones failed. Passing offers keep the model's order.
 * When still short of five, the best-scored `weak` ones fill the places,
 * tagged weak; an `irrelevant` or lint-failing offer never does. Empty when
 * there is no brief, the model skips (nothing at all is known), or nothing
 * passes.
 */
export async function deriveOffers(
  input: DeriveOfferInput & { fetchImpl?: typeof fetch },
): Promise<ProspectOffer[]> {
  if (!playMakesOffer(input.playName)) return [];
  const cfg = input.cfg ?? loadConfig();
  // The steps may claim only what the product brief says the product does.
  // With no brief there is nothing to ground them in.
  if (!cfg.productBrief?.trim()) return [];
  const research = offerResearchText(input.target as JsonRecord, input.dossier);
  const inputHash = offerInputHash(research, cfg);
  const messages: ChatMessage[] = [
    { role: "system", content: loadPrompt("prospect-offer") },
    { role: "user", content: offerUserMessage(input, cfg, research) },
  ];
  const product = `${cfg.productOneLiner ?? ""}\n${cfg.productBrief}`;
  const oneLiner = cfg.productOneLiner ?? "";
  let kept: DraftOffer[] = [];
  const seen = new Set<string>();
  let lastReply = "";
  try {
    for (let round = 0; round < 2; round++) {
      const res = await complete({ messages, temperature: 0.4, maxTokens: 3000 });
      lastReply = res.content;
      const out = lintReply(res.content, research, product, oneLiner, seen);
      if (out.skip) {
        logEvent("prospect_offer.skipped", { play: input.playName, round });
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
            `These offers cannot be used: ${out.failed.join("; ")}. Return all five again, best return ` +
            `first, each within every rule, or {"skip": true, "why": "..."} if nothing supports ` +
            `one. JSON only.`,
        },
      );
    }
    kept = kept.slice(0, OFFER_COUNT);
    if (kept.length > 0) {
      kept = await judgeAndReplace(kept, {
        input,
        cfg,
        research,
        product,
        oneLiner,
        seen,
        messages,
        lastReply,
      });
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
  return offers;
}

/**
 * The judge's pass over the linted offers, and the one replacement round.
 * Offers the judge gave no verdict are kept as they are: a judge outage
 * never empties a row.
 */
async function judgeAndReplace(
  kept: DraftOffer[],
  ctx: {
    input: DeriveOfferInput & { fetchImpl?: typeof fetch };
    cfg: AppConfig;
    research: string;
    product: string;
    oneLiner: string;
    seen: Set<string>;
    messages: ChatMessage[];
    lastReply: string;
  },
): Promise<DraftOffer[]> {
  const { input, cfg, research } = ctx;
  const judgeOpts = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {};
  const verdicts = await judgeOffers(kept, research, input.target, cfg, judgeOpts);
  if (!verdicts) return kept;
  const passing: DraftOffer[] = [];
  const fill: Array<{ offer: DraftOffer; score: number | null }> = [];
  const dropped: string[] = [];
  kept.forEach((o, i) => {
    const j = verdicts[i] ?? null;
    const judged = withJudgement(o, j);
    if (!j || j.pass) {
      passing.push(judged);
      return;
    }
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
          `never on an industry word alone, and within every rule. ` +
          `Return {"offers": [...]} with the same fields. JSON only.`,
      },
    );
    try {
      const res = await complete({ messages: ctx.messages, temperature: 0.4, maxTokens: 3000 });
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
          if (!j || j.pass) passing.push(judged);
          else if (j.label !== "irrelevant") fill.push({ offer: judged, score: j.score });
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
  if (passing.length >= OFFER_COUNT) return passing.slice(0, OFFER_COUNT);
  // Fill with the best-scored weak ones; equal (or no) scores keep the order written.
  const fillers = fill
    .toSorted((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, OFFER_COUNT - passing.length)
    // Each is already a copy (withJudgement), so tagging it in place is safe.
    .map(({ offer }) => Object.assign(offer, { relevance: "weak" as const }));
  return [...passing, ...fillers];
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
  const product = `${cfg.productOneLiner ?? ""}\n${cfg.productBrief}`;
  const user = [
    `OFFER: ${input.offer.offer}`,
    ...(input.offer.return?.trim() ? [`RETURN: ${input.offer.return.trim()}`] : []),
    ...(input.offer.steps.trim() ? [`HOW: ${input.offer.steps.trim()}`] : []),
    `PRODUCT: ${cfg.productOneLiner ?? ""}`,
    `PRODUCT BRIEF:\n${clip(cfg.productBrief.trim(), BRIEF_MAX)}`,
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
 * Five ranked offers and the first one's angles. Null when no offer can be
 * written: no brief, nothing known, or nothing passes lint.
 */
export async function deriveOfferSet(input: DeriveOfferInput): Promise<OfferSet | null> {
  const cfg = input.cfg ?? loadConfig();
  const offers = await deriveOffers({ ...input, cfg });
  if (offers.length === 0) return null;
  const offer = await withOfferAngles(offers[0]!, { ...input, cfg });
  return { offer, candidates: [offer, ...offers.slice(1)] };
}

/** One offer, the best of a fresh set: for callers that keep only the active one. */
export async function deriveOffer(input: DeriveOfferInput): Promise<ProspectOffer | null> {
  return (await deriveOfferSet(input))?.offer ?? null;
}

/** The ranked offers a queue payload carries, when it has any. */
export function offerCandidatesOf(payload: Record<string, unknown>): ProspectOffer[] {
  const list = payload["offerCandidates"];
  return Array.isArray(list) ? list.filter(isProspectOffer) : [];
}

/**
 * The offers a queue row should carry: the stored set when its active offer
 * is current (or the founder's), with angles written if they are missing,
 * else a fresh set. `changed` says whether the caller has anything to persist.
 */
export async function ensureOfferSet(
  input: DeriveOfferInput,
): Promise<(OfferSet & { changed: boolean }) | null> {
  if (!playMakesOffer(input.playName)) return null;
  const cfg = input.cfg ?? loadConfig();
  const t = input.target as JsonRecord;
  const stored = t["offer"];
  const research = offerResearchText(t, input.dossier);
  if (offerIsCurrent(stored, offerInputHash(research, cfg))) {
    const candidates = offerCandidatesOf(t);
    if (offerAnglesWritten(stored) || !cfg.productBrief?.trim()) {
      return { offer: stored, candidates, changed: false };
    }
    const offer = await withOfferAngles(stored, { ...input, cfg });
    return { offer, candidates, changed: offer !== stored };
  }
  const fresh = await deriveOfferSet({ ...input, cfg });
  return fresh ? { ...fresh, changed: true } : null;
}

/**
 * The offer a queue row should carry: the stored one when current (or the
 * founder's), else a fresh one. The caller persists a fresh one.
 */
export async function ensureOffer(input: DeriveOfferInput): Promise<ProspectOffer | null> {
  return (await ensureOfferSet(input))?.offer ?? null;
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
  if (!playMakesOffer(input.playName)) return null;
  const cfg = input.cfg ?? loadConfig();
  const stored = (input.target as JsonRecord)["offer"];
  if (isProspectOffer(stored) && stored.editedBy === "founder") return stored;
  if (!cfg.productBrief?.trim()) return null;
  if (
    isProspectOffer(stored) &&
    stored.version === OFFER_PROMPT_VERSION &&
    stored.productHash === offerProductHash(cfg)
  ) {
    return stored;
  }
  return (await deriveOfferSet({ ...input, cfg }))?.offer ?? null;
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
      `PRODUCT BRIEF (the only source of product claims):\n${clip(cfg.productBrief.trim(), BRIEF_MAX)}`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** The offer a queue payload carries, when it has one. */
export function offerOf(payload: Record<string, unknown>): ProspectOffer | null {
  const o = payload["offer"];
  return isProspectOffer(o) ? o : null;
}
