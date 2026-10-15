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
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { describeTargetForAngle } from "./_angles.ts";
import { recentPosts } from "./_recent-posts.ts";

type AppConfig = ReturnType<typeof loadConfig>;
type JsonRecord = Record<string, unknown>;

/** Bump when the prompt or the lint changes: unedited offers re-derive. */
export const OFFER_PROMPT_VERSION = "offer-v1";

export const OFFER_MAX = { offer: 140, steps: 260, evidence: 200 } as const;

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
  version: string;
  /** Hash of the inputs it was written from. */
  inputHash: string;
  /** Set when the founder wrote or edited it. Never re-derived. */
  editedBy?: "founder";
  derivedAt: string;
}

export function isProspectOffer(value: unknown): value is ProspectOffer {
  if (!value || typeof value !== "object") return false;
  const o = value as Partial<ProspectOffer>;
  return typeof o.offer === "string" && o.offer.trim().length > 0 && typeof o.steps === "string";
}

/**
 * Plays whose message is not an offer: a learning interview, a survey, a
 * customer's onboarding call, a missed demo, a launch repost, a public reply.
 * They get no prospect offer and no OFFER block.
 */
export const NO_OFFER_PLAYS: ReadonlySet<string> = new Set([
  "discovery-interview",
  "pmf-survey",
  "concierge",
  "demo-no-show",
  "x-amplify",
  "x-amplify-dm",
  "community-reply",
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
];

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Three-word phrases of a text, lowercased, for the echo check. */
function trigrams(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/**
 * Lint flags for a written offer, keyed on the output alone. An offer that
 * fails gets one repair round, then is dropped.
 */
export function lintOffer(
  parts: { offer: string; steps: string; evidence: string[]; level: ProspectOffer["level"] },
  research: string,
  product = "",
): string[] {
  const flags: string[] = [];
  const offer = parts.offer.trim();
  const steps = parts.steps.trim();
  if (!offer || !steps) return ["empty"];
  if (offer.length > OFFER_MAX.offer) flags.push("offer-too-long");
  if (steps.length > OFFER_MAX.steps) flags.push("steps-too-long");
  const both = `${offer} ${steps}`;
  for (const [flag, pattern] of BANNED) if (pattern.test(both)) flags.push(flag);
  const haystack = normalizeForMatch(research);
  for (const n of both.match(/\d[\d,.]*/g) ?? []) {
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
  // The offer is their outcome, not the product's mechanism: a three-word
  // phrase shared with the product's own description means it leaked in.
  const productPhrases = trigrams(product);
  const echoed = [...trigrams(offer)].filter((g) => productPhrases.has(g) && !haystack.includes(g));
  if (echoed.length > 0) flags.push(`offer-echoes-product:${echoed[0]}`);
  return flags;
}

interface RawOffer {
  offer?: unknown;
  steps?: unknown;
  evidence?: unknown;
  stage?: unknown;
  level?: unknown;
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
  return {
    offer,
    steps,
    evidence,
    stage: typeof raw.stage === "string" ? raw.stage.trim().slice(0, 60) : "",
    level: raw.level === "role" ? "role" : "researched",
  };
}

export interface DeriveOfferInput {
  target: object;
  /** Extra research the caller holds (a play's enrichment dossier). */
  dossier?: string | null;
  playName: string;
  cfg?: AppConfig;
}

/**
 * Write the prospect offer. Null when there is no product brief to ground it
 * in, the model skips (nothing at all is known), or both rounds fail lint;
 * the writer then drafts without an OFFER block, as before.
 */
export async function deriveOffer(input: DeriveOfferInput): Promise<ProspectOffer | null> {
  if (!playMakesOffer(input.playName)) return null;
  const cfg = input.cfg ?? loadConfig();
  // The steps may claim only what the product brief says the product does.
  // With no brief there is nothing to ground them in.
  if (!cfg.productBrief?.trim()) return null;
  const t = input.target as JsonRecord;
  const research = offerResearchText(t, input.dossier);
  const inputHash = offerInputHash(research, cfg);
  const user = [
    `PRODUCT: ${cfg.productOneLiner ?? ""}`,
    `PRODUCT BRIEF:\n${clip(cfg.productBrief.trim(), BRIEF_MAX)}`,
    ...(cfg.pilotOffer?.trim() ? [`OFFER TERMS: ${cfg.pilotOffer.trim()}`] : []),
    `PLAY: ${input.playName}`,
    `PROSPECT: ${firstString(t, ["name", "founderName", "guestName", "hostName"])}`,
    `TITLE: ${firstString(t, ["title", "newTitle", "jobTitle"])}`,
    `COMPANY: ${firstString(t, ["company", "newCompany", "guestCompany", "businessName", "municipality"])}`,
    `RESEARCH:\n${research || "(none)"}`,
  ].join("\n\n");
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: loadPrompt("prospect-offer") },
    { role: "user", content: user },
  ];
  const product = `${cfg.productOneLiner ?? ""}\n${cfg.productBrief}`;
  try {
    for (let round = 0; round < 2; round++) {
      const res = await complete({ messages, temperature: 0.3, maxTokens: 900 });
      const parsed = readRaw(tryParseJsonObject<RawOffer>(res.content, {}));
      if (!parsed) {
        logEvent("prospect_offer.skipped", { play: input.playName, round });
        return null;
      }
      const flags = lintOffer(parsed, research, product);
      if (flags.length === 0) {
        logEvent("prospect_offer.derived", {
          play: input.playName,
          level: parsed.level,
          offer_120: parsed.offer.slice(0, 120),
        });
        return {
          ...parsed,
          version: OFFER_PROMPT_VERSION,
          inputHash,
          derivedAt: new Date().toISOString(),
        };
      }
      logEvent("prospect_offer.lint_failed", {
        play: input.playName,
        round,
        flags_200: flags.join(",").slice(0, 200),
      });
      messages.push(
        { role: "assistant", content: res.content },
        {
          role: "user",
          content:
            `That offer cannot be used: ${flags.join(", ")}. Rewrite it within every rule, ` +
            `or return {"skip": true, "why": "..."} if nothing supports one. JSON only.`,
        },
      );
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
  return null;
}

/**
 * The offer a queue row should carry: the stored one when current (or the
 * founder's), else a fresh one. The caller persists a fresh one.
 */
export async function ensureOffer(input: DeriveOfferInput): Promise<ProspectOffer | null> {
  if (!playMakesOffer(input.playName)) return null;
  const cfg = input.cfg ?? loadConfig();
  const stored = (input.target as JsonRecord)["offer"];
  const research = offerResearchText(input.target, input.dossier);
  if (offerIsCurrent(stored, offerInputHash(research, cfg))) return stored;
  return deriveOffer({ ...input, cfg });
}

/**
 * The offer a draft is written around. A stored offer of the current version
 * is used as it stands, even though the play's enrichment adds research it
 * never saw: re-deriving on every draft would change the offer under the
 * founder's feet. Only a missing or outdated one is written here.
 */
export async function offerForDraft(input: DeriveOfferInput): Promise<ProspectOffer | null> {
  if (!playMakesOffer(input.playName)) return null;
  const stored = (input.target as JsonRecord)["offer"];
  if (
    isProspectOffer(stored) &&
    (stored.editedBy === "founder" || stored.version === OFFER_PROMPT_VERSION)
  ) {
    return stored;
  }
  return deriveOffer(input);
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
  offer: Pick<ProspectOffer, "offer" | "steps"> | null,
  cfg: Pick<AppConfig, "pilotOffer" | "productBrief">,
  playName: string,
  opts: { brief?: boolean } = {},
): string | null {
  if (!playMakesOffer(playName)) return null;
  const lines: string[] = [];
  if (offer) {
    lines.push(`OFFER (what you offer to do for them; the message opens with it): ${offer.offer}`);
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
