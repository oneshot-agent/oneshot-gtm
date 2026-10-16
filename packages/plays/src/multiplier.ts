import type { DraftAngle } from "@oneshot-gtm/shared-types";
import { effectiveMemberOffer, loadConfig, throwIfCancelled, webSearch } from "@oneshot-gtm/core";
import { type EmailPlayDef, type Prepared, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { multiplierMetadata } from "./_metadata.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

/** The kinds of organization that serve many of a founder's buyers at once. */
export type MultiplierOrgType = "accelerator" | "association" | "agency" | "community" | "other";

export const MULTIPLIER_ORG_TYPES: readonly MultiplierOrgType[] = [
  "accelerator",
  "association",
  "agency",
  "community",
  "other",
];

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

/** The row's member count as a positive integer, or null when it states none. */
function memberCountOf(t: MultiplierTarget): number | null {
  const n = typeof t.memberCount === "string" ? Number(t.memberCount.trim()) : t.memberCount;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

export function runMultiplier(opts: MultiplierRunOptions): Promise<{ drafted: MultiplierDraft[] }> {
  // The member offer is founder truth: read from config (the trigger's own
  // when it sets one), quoted verbatim, never written by the model. Resolved
  // once per run so every row of the batch pitches the same offer.
  const memberOffer = effectiveMemberOffer(loadConfig(), opts.queueSource);
  const def: EmailPlayDef<MultiplierTarget> = {
    playName: PLAY_NAME,
    promptName: "multiplier-email",
    maxBodyWords: 150,
    // Links, prices and discounts are banned everywhere except inside the
    // quoted member offer (`hardBanAllow`), which may name credits or a trial.
    hardBans: true,
    hardBanAllow: () => (memberOffer ? [memberOffer] : []),
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
    prepare: async (t, dryRun, signal): Promise<Prepared> => {
      // Refuse before any paid call: a pitch without the offer has nothing to
      // propose, and the model must not be left to make one up.
      if (!memberOffer) {
        throw new Error(
          "multiplier: memberOffer is empty — set it in config (or on the trigger) before drafting",
        );
      }
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
    buildInputBlock: (t, prep, cfg) =>
      [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `MEMBER OFFER: ${memberOffer}`,
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
    prospectMeta: (t) => ({
      name: t.name,
      email: t.email,
      company: t.organization,
      linkedin_url: t.linkedinUrl ?? null,
      phone: t.phone ?? null,
      source: `multiplier-${t.orgType}`,
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
      }),
    },
  ],
});
