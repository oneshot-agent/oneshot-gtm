/**
 * The config a stored draft was written under, as one short key.
 *
 * A queue draft (`target_queue.last_draft_json`) and a follow-up preview
 * (`cadence_state.next_step_draft_json`) are sent word for word, so a draft
 * written before the workspace changed its setup would go out under the old
 * one. Each draft is stamped with `draftConfigKey` when it is written, and a
 * draft whose key differs from today's (or that has none, written before the
 * key existed) reads as stale: the views say so, a batch send skips it and a
 * single send asks the founder to confirm.
 *
 * The key hashes whatever the config holds; it never reads what the values
 * say. Saving setup needs no hook: the next comparison sees the new key.
 */
import {
  founderGreetingOf,
  getLedger,
  linkedinWriterOf,
  loadConfig,
  offerExclusionsOf,
  productBriefText,
  subjectCaseOf,
  type Ledger,
} from "@oneshot-gtm/core";
import { createHash } from "node:crypto";
import { voiceKey } from "./_lib.ts";
import { OFFER_PROMPT_VERSION, playMakesOffer } from "./_prospect-offer.ts";

type AppConfig = ReturnType<typeof loadConfig>;

/**
 * Bump when a drafting prompt or template changes in a way that should
 * re-draft every stored draft. Offer prompt changes bump
 * `OFFER_PROMPT_VERSION`, which the key also carries.
 */
export const DRAFT_PROMPT_VERSION = "draft-v1";

/** Where a draft goes out: its channel and whether it opens the thread or follows up. */
export interface DraftSurface {
  channel: "email" | "linkedin" | "x";
  stage: "first_touch" | "follow_up";
}

/** The reason a batch send gives for a stale draft it skipped. */
export const STALE_DRAFT_REASON = "draft written under an older setup; re-preview";

/** The flag a view shows on a stale draft, and the error a single send answers with. */
export const STALE_DRAFT_FLAG = "stale-config";

/**
 * The approved learned guidance a draft on this surface reads (ids and text),
 * as one string. A templated LinkedIn note or message reads none (its text is
 * the workspace's copy), so a guidance change never stales it.
 */
function guidanceOf(surface: DraftSurface, cfg: AppConfig, ledger: Ledger | null): string {
  if (surface.channel === "x" || !ledger?.learning) return "";
  if (surface.channel === "linkedin" && linkedinWriterOf(cfg) === "template") return "";
  try {
    const g = ledger.learning.guidance({ channel: surface.channel, stage: surface.stage });
    return g.instructions.map((i) => `${i.id}\u0001${i.instruction}`).join("\u0002");
  } catch {
    return "";
  }
}

/**
 * The greeting and subject case as the key carries them: empty for `Hey` and
 * lowercase, which every draft was written under before the two settings had
 * neutral defaults, so a workspace that sets them keeps its stored drafts.
 */
function voiceSettingsKey(cfg: AppConfig): string {
  const greeting = founderGreetingOf(cfg);
  const subjectCase = subjectCaseOf(cfg);
  return [
    greeting === "Hey" ? "" : `greeting:${greeting}`,
    subjectCase === "lowercase" ? "" : `subject:${subjectCase}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Short hash of the config a draft on `surface` for `playName` is written
 * under: the drafting and offer prompt versions, the voice card and its
 * overrides, the approved guidance for the surface (none for templated
 * LinkedIn copy), the founder's
 * admission, credentials, portfolio, partners and cohort, the product
 * one-liner, brief (with approved code answers) and terms, the offer
 * exclusions, whether the play makes an offer, the member offer for the
 * play that quotes it, the signature settings, and on LinkedIn the
 * workspace's writer and templates. Pure apart from the guidance and
 * code-answer reads (pass `ledger: null` to skip both).
 */
export function draftConfigKey(
  cfg: AppConfig,
  input: { surface: DraftSurface; playName: string },
  ledger: Ledger | null = safeLedger(),
): string {
  const { surface, playName } = input;
  const card = text(cfg.founderVoice);
  const parts = [
    DRAFT_PROMPT_VERSION,
    OFFER_PROMPT_VERSION,
    `${surface.channel}:${surface.stage}`,
    card ? voiceKey(card) : "",
    voiceSettingsKey(cfg),
    guidanceOf(surface, cfg, ledger),
    text(cfg.founderAdmission),
    text(cfg.founderCredentials),
    text(cfg.productPortfolio),
    text(cfg.partners),
    text(cfg.founderCohort),
    text(cfg.productOneLiner),
    productBriefText(cfg, ledger) ?? "",
    text(cfg.pilotOffer),
    offerExclusionsOf(cfg).join("\n"),
    playMakesOffer(playName, cfg) ? "offer" : "no-offer",
    // The member-offer play quotes the workspace's member offer verbatim.
    playName === "multiplier" ? text(cfg.memberOffer) : "",
    text(cfg.founderName),
    text(cfg.productDomain),
    cfg.mobileSignature === true ? "mobile" : "",
    surface.channel === "linkedin"
      ? JSON.stringify([cfg.linkedin?.writer ?? null, cfg.linkedin?.templates ?? null])
      : "",
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
}

function safeLedger(): Ledger | null {
  try {
    return getLedger();
  } catch {
    return null;
  }
}

/**
 * `draftConfigKey` for many drafts read under one config (a page of rows):
 * each surface and play is hashed once.
 */
export function draftConfigKeyer(
  cfg: AppConfig = loadConfig(),
  ledger: Ledger | null = safeLedger(),
): (surface: DraftSurface, playName: string) => string {
  const memo = new Map<string, string>();
  return (surface, playName) => {
    const k = `${surface.channel}|${surface.stage}|${playName}`;
    let key = memo.get(k);
    if (key === undefined) {
      key = draftConfigKey(cfg, { surface, playName }, ledger);
      memo.set(k, key);
    }
    return key;
  };
}

/** The surface a queue row's first touch goes out on, from its channel. */
export function queueDraftSurface(channel: string | null | undefined): DraftSurface {
  const c = (channel ?? "email").trim().toLowerCase();
  return {
    channel: c === "linkedin" ? "linkedin" : c === "x" ? "x" : "email",
    stage: "first_touch",
  };
}

/**
 * The surface a stored follow-up preview goes out on, from its payload's
 * kind. Null for a step whose stored preview is not sent as written (a
 * reviewed mailpiece, a known connection that sends nothing): those are
 * never stale.
 */
export function cadenceDraftSurface(payload: unknown): DraftSurface | null {
  const kind =
    payload && typeof payload === "object" ? (payload as { kind?: unknown }).kind : undefined;
  switch (kind) {
    case "email":
    case "sms":
    case "voice":
      return { channel: "email", stage: "follow_up" };
    case "linkedin_message":
    case "linkedin_invite":
      return { channel: "linkedin", stage: "follow_up" };
    default:
      return null;
  }
}

/** The key a stored draft carries; null when it has none (written before the key existed). */
export function storedConfigKey(draft: unknown): string | null {
  if (!draft || typeof draft !== "object") return null;
  const k = (draft as { configKey?: unknown }).configKey;
  return typeof k === "string" && k ? k : null;
}

/**
 * True when a stored draft was written under another config than today's:
 * its key differs, or it has none. `current` is today's key for its surface.
 */
export function draftIsStale(draft: unknown, current: string): boolean {
  return storedConfigKey(draft) !== current;
}

/**
 * True when a stored follow-up preview (`getCadenceDraft`) is stale for its
 * play under `keyOf` (today's config by default). A preview with no surface
 * of its own (`cadenceDraftSurface`) never is.
 */
export function cadenceDraftIsStale(
  draft: { payload?: unknown; configKey?: unknown } | null | undefined,
  playName: string,
  keyOf: (surface: DraftSurface, playName: string) => string = draftConfigKeyer(),
): boolean {
  if (!draft) return false;
  const surface = cadenceDraftSurface(draft.payload);
  if (!surface) return false;
  return draftIsStale(draft, keyOf(surface, playName));
}

/**
 * Today's keys for a play's queue drafts, one per first-touch channel: read
 * before a batch drafts, so a setup saved while it drafts leaves its drafts
 * stale, never current. Look one up with `queueDraftSurface(channel).channel`.
 */
export function queueDraftConfigKeys(
  playName: string,
  cfg: AppConfig = loadConfig(),
): ReadonlyMap<DraftSurface["channel"], string> {
  const keyOf = draftConfigKeyer(cfg);
  const channels: Array<DraftSurface["channel"]> = ["email", "linkedin", "x"];
  return new Map(
    channels.map((channel) => [channel, keyOf({ channel, stage: "first_touch" }, playName)]),
  );
}

/** Today's key for a queue row's draft, from its play and channel. */
export function queueDraftConfigKey(
  playName: string,
  channel: string | null | undefined,
  cfg: AppConfig = loadConfig(),
): string {
  return draftConfigKey(cfg, { surface: queueDraftSurface(channel), playName });
}
