import type { DraftAngle } from "@oneshot-gtm/shared-types";
import {
  effectiveMemberOffer,
  getLedger,
  loadConfig,
  throwIfCancelled,
  webSearch,
} from "@oneshot-gtm/core";
import { type EmailPlayDef, type Prepared, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { multiplierMetadata, multiplierProspectFields } from "./_metadata.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";
import { humanizeText, quotesSpan } from "./_lib.ts";
import { enrolledMemberOffer } from "./_member-offer.ts";

/** The kinds of organization that serve many of a founder's buyers at once. */
export type MultiplierOrgType = "accelerator" | "association" | "agency" | "community" | "other";

export interface MultiplierTarget {
  /** The organization that serves the founder's buyers. */
  organization: string;
  orgType: MultiplierOrgType;
  /** The partnerships or programme contact. */
  name: string;
  email: string;
  role: string;
  /** Who the organization's members are. */
  memberDescription: string;
  /** One sentence: why its members are the founder's buyers. */
  whyFit: string;
  /** How many members the row states; a form may hand it over as a numeric string. */
  memberCount?: number | string;
  orgUrl?: string;
  linkedinUrl?: string;
  /** Who made a warm introduction. The draft names them only when this is set. */
  introducedBy?: string;
  phone?: string;
}

export interface MultiplierRunOptions {
  dryRun: boolean;
  targets: MultiplierTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Abort signal for the run: see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
  /** Explicit draft argument chosen by the user; bypasses automatic angle selection. */
  draftAngle?: string;
  /** `source` of the queue row being sent: picks the trigger whose `memberOffer` applies. */
  queueSource?: string | null;
  /**
   * Per target, the `source` of the queue row it was drawn from (a /run batch
   * loaded from the queue), null for a row from no queue; see `runEmailPlay`.
   * Each row pitches its own trigger's `memberOffer`.
   */
  queueSources?: ReadonlyArray<string | null | undefined>;
}

interface MultiplierDraft {
  target: MultiplierTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
  angle?: DraftAngle;
}

const PLAY_NAME = "multiplier";

/** Dossier slice kept from the search of the organization's site. */
const ORG_SEARCH_SLICE = 2500;

/** The host of the organization's site, for a scoped search; undefined when the URL is unusable. */
function orgHost(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    return undefined;
  }
}

/** Held: the draft does not quote the member offer whole and verbatim. */
export const OFFER_MISSING_FLAG = "multiplier:offer-missing";
/** Held: the row names a warm introducer and the draft does not name them. */
export const INTRODUCER_MISSING_FLAG = "multiplier:introducer-missing";

/** `text` with runs of whitespace folded to one space, so a line the model re-wrapped still compares. */
const folded = (text: string): string => text.trim().split(/\s+/).join(" ");

/** The refusal made before any paid call when the member offer is empty. */
export const EMPTY_OFFER_MESSAGE =
  "multiplier: memberOffer is empty — set it in config (or on the trigger) before drafting";

/**
 * The deterministic checks on a multiplier draft, besides the hard bans. The
 * member offer is founder truth the prompt quotes whole: a body that omits it,
 * shortens it, paraphrases it, changes a figure in it or extends one (`$1500`
 * for `$150`) is held rather than sent, and nothing rewrites the offer into
 * the draft in its place. The offer is matched the way the hard-ban span is
 * (`quotesSpan`): verbatim, in the founder's own punctuation and case (the
 * draft pipeline keeps it so; see `humanizeDraft`), across the model's own
 * line wrapping, and only whole. With `introducedBy` set, the draft must name
 * the introducer. Without it, there is no name to check: the prompt forbids
 * implying an introduction.
 */
export function multiplierDraftFlags(
  body: string,
  memberOffer: string,
  introducedBy?: string,
): string[] {
  const flags: string[] = [];
  if (!quotesSpan(body, memberOffer)) flags.push(OFFER_MISSING_FLAG);
  const introducer = folded(humanizeText(introducedBy ?? "")).toLowerCase();
  if (introducer && !folded(humanizeText(body)).toLowerCase().includes(introducer))
    flags.push(INTRODUCER_MISSING_FLAG);
  return flags;
}

/**
 * The play's refusal, for the /run route to make before its own paid step
 * (public-route email verification bills before the play runs): throws when
 * any target's member offer (its queue row's trigger's, else the workspace's)
 * is empty, so a run without an offer bills nothing at all.
 */
export function multiplierPreflight(
  targets: readonly unknown[],
  queueSources?: ReadonlyArray<string | null | undefined>,
): void {
  const cfg = loadConfig();
  const getTrigger = (name: string) => getLedger().getTrigger(name);
  for (let i = 0; i < targets.length; i++) {
    if (!effectiveMemberOffer(cfg, queueSources?.[i], getTrigger)) {
      throw new Error(EMPTY_OFFER_MESSAGE);
    }
  }
}

/** The row's member count as a positive integer, or null when it states none. */
function memberCountOf(t: MultiplierTarget): number | null {
  const n = typeof t.memberCount === "string" ? Number(t.memberCount.trim()) : t.memberCount;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

export function runMultiplier(opts: MultiplierRunOptions): Promise<{ drafted: MultiplierDraft[] }> {
  // The member offer is founder truth: read from config (the trigger's own
  // when it sets one), quoted verbatim, never written by the model. Resolved
  // per row: a batch drawn from the queue carries each row's source
  // (`queueSources`), so rows from two triggers pitch their own offers and a
  // row from no queue row pitches the workspace's; a single redraft carries
  // its row's source (`queueSource`). The row is known by its index in
  // `targets`, which `runEmailPlay` hands every hook: the target object is
  // not a key, since the executor drafts from a copy of it once angle
  // selection has picked one `yourEdge` angle, and the prompt, the allowed
  // span and the verbatim check must all read the same row's offer.
  const cfg = loadConfig();
  const getTrigger = (name: string) => getLedger().getTrigger(name);
  const offers = opts.targets.map((_t, i) =>
    effectiveMemberOffer(cfg, opts.queueSources?.[i] ?? opts.queueSource, getTrigger),
  );
  const memberOfferOf = (index: number | undefined): string =>
    (index !== undefined ? offers[index] : undefined) ??
    effectiveMemberOffer(cfg, opts.queueSource, getTrigger);
  const def: EmailPlayDef<MultiplierTarget> = {
    playName: PLAY_NAME,
    promptName: "multiplier-email",
    maxBodyWords: 150,
    // Links, prices and discounts are banned everywhere except inside the
    // quoted member offer (`hardBanAllow`), which may name credits or a trial.
    hardBans: true,
    hardBanAllow: (_t, _cfg, index) => (memberOfferOf(index) ? [memberOfferOf(index)] : []),
    // A draft without the offer verbatim (or the named introducer) is held;
    // `prepare` threw before the draft when the offer was empty.
    draftFlags: (draft, t, _cfg, index) =>
      multiplierDraftFlags(draft.body, memberOfferOf(index), t.introducedBy),
    enrollCadence: true,
    requiredFields: [
      "organization",
      "orgType",
      "name",
      "email",
      "role",
      "memberDescription",
      "whyFit",
    ],
    toEmail: (t) => t.email,
    prepare: async (t, dryRun, signal, index): Promise<Prepared> => {
      // Refuse before any paid call: a pitch without the offer has nothing to
      // propose, and the model must not be left to make one up. (The /run
      // route makes the same refusal before its own paid verification.)
      if (!memberOfferOf(index)) throw new Error(EMPTY_OFFER_MESSAGE);
      const prep = await standardEnrich({
        playName: PLAY_NAME,
        enrichInput: {
          email: t.email,
          ...(t.linkedinUrl ? { linkedinUrl: t.linkedinUrl } : {}),
          name: t.name,
        },
        enrichSlice: 3500,
        ...(signal ? { signal } : {}),
      });
      if (dryRun) return prep;
      // One web search of the organization's site for its programme or perks
      // page, real send only: the second paid call of the phase.
      throwIfCancelled(signal, `${PLAY_NAME} search`);
      const host = orgHost(t.orgUrl);
      const search = await webSearch(
        {
          query: `${host ? `site:${host} ` : `${t.organization} `}program perks partners members`,
          maxResults: 5,
        },
        { playName: PLAY_NAME },
      );
      return {
        ...prep,
        receiptIds: [...prep.receiptIds, search.receiptId],
        dossier:
          prep.dossier +
          "\n\n---\n\nORGANIZATION SITE SEARCH:\n" +
          JSON.stringify(search.result.results, null, 2).slice(0, ORG_SEARCH_SLICE),
      };
    },
    buildInputBlock: (t, prep, cfg, index) =>
      [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `MEMBER OFFER: ${memberOfferOf(index)}`,
        `ORGANIZATION: ${t.organization} (${t.orgType})`,
        `CONTACT: ${t.name}, ${t.role}`,
        `MEMBERS: ${t.memberDescription}`,
        `WHY FIT: ${t.whyFit}`,
        // Only what the row states: the prompt may not add a member number.
        ...(memberCountOf(t) ? [`MEMBER COUNT: ${memberCountOf(t)}`] : []),
        ...(t.orgUrl?.trim() ? [`ORGANIZATION URL: ${t.orgUrl.trim()}`] : []),
        // Emitted ONLY for a real warm introduction; a placeholder would invite one.
        ...(t.introducedBy?.trim() ? [`INTRODUCED BY: ${t.introducedBy.trim()}`] : []),
        `DOSSIER:\n${prep.dossier || "(dry-run; rely on the organization row only)"}`,
      ].join("\n"),
    // The organization is the prospect's company and `multiplier-<orgType>`
    // its source, by the same map the reviewed /queue send uses.
    prospectMeta: (t) => ({
      name: t.name,
      email: t.email,
      linkedin_url: t.linkedinUrl ?? null,
      phone: t.phone ?? null,
      ...multiplierProspectFields(t),
    }),
    metadata: (t) => multiplierMetadata(t),
  };

  return runEmailPlay(def, opts);
}

registerSequence({
  playName: PLAY_NAME,
  // Programme leads live on LinkedIn: the email-to-LinkedIn continuation is
  // on unless the workspace or the trigger sets `linkedinContinuation: false`.
  linkedinContinuationDefault: true,
  steps: [
    {
      dayOffset: 10,
      channel: "email",
      breakOnReply: true,
      label: "slow follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "breakup-email",
        contextLines: [
          `PLAY: multiplier. This is a partnership ask to an organization that serves many of the sender's buyers, not a sale to the reader; keep it short and put no pressure on them. One line restating that the sender's offer for their members stands, and one easy question.`,
        ],
        // The intro's holds carry to the follow-up, on the preview and the
        // send: a link, or a price or discount outside the member offer the
        // originating send made, holds it.
        hardBans: true,
        hardBanAllow: (ctx) => {
          const offer = enrolledMemberOffer(ctx.prospect.id, ctx.cfg);
          return offer ? [offer] : [];
        },
      }),
    },
  ],
});
