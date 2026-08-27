import { xAmplifyMetadata } from "./_metadata.ts";
import { type EmailPlayDef, type Prepared, runEmailPlay } from "./_run-play.ts";

/**
 * Amplifier-lane prospect from the x-reposters finder: a dev/AI account that
 * reposted a watched tweet and whose email the research pass found. The ask is
 * exactly one thing — a look, and a repost on launch day if it's their kind of
 * thing. NEVER a product pitch: the lane gate is the qualification, and
 * pitching adoption at an amplifier burns both asks.
 *
 * One touch, no cadence — cadence offsets are relative to the send date and
 * can't express "near launch day", and a breakup sequence on a favor-ask reads
 * as pressure.
 */
export interface XAmplifyTarget {
  name: string;
  email?: string | null;
  /** Pre-researched dossier from deepResearchPerson. Grounding only. */
  dossier?: string;
  /** X handle, without the @. */
  handle: string;
  twitterUrl: string;
  /** Numeric X user id, for DM deep-links elsewhere. */
  xUserId?: string;
  /** The watched account they reposted. */
  seedHandle: string;
  tweetUrl: string;
  tweetText: string;
  mode: "retweet" | "quote";
  /** Their own words when they quoted — the best hook when present. */
  quote?: string | null;
  followers?: number;
  score?: number;
  why?: string;
  /** ISO launch date — the ONLY timing fact the draft may state. */
  launchDate?: string | null;
  dmOpen?: boolean;
  engine?: string;
}

export interface XAmplifyRunOptions {
  dryRun: boolean;
  targets: XAmplifyTarget[];
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
}

interface XAmplifyDraft {
  target: XAmplifyTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const PLAY_NAME = "x-amplify";

const xAmplifyDef: EmailPlayDef<XAmplifyTarget> = {
  playName: PLAY_NAME,
  promptName: "x-amplify-email",
  maxBodyWords: 90,
  enrollCadence: false,
  toEmail: (t) => t.email ?? "",
  // The finder already researched the person for the email hunt — the dossier
  // rides along. No re-pay, no fallback enrichment: the repost is the hook.
  prepare: (t, _dryRun): Promise<Prepared> =>
    Promise.resolve({ receiptIds: [], dossier: t.dossier ?? "" }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name} (@${t.handle} on X)`,
      `SEED: @${t.seedHandle}`,
      `THEY_REPOSTED: ${t.tweetText} (${t.tweetUrl})`,
      `MODE: ${t.mode}`,
      ...(t.quote ? [`THEIR_QUOTE: ${t.quote}`] : []),
      ...(t.launchDate ? [`LAUNCH_DATE: ${t.launchDate}`] : []),
      `DOSSIER:\n${prep.dossier || "(no dossier; ground in the repost only)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email ?? null,
    company: null,
    linkedin_url: t.twitterUrl,
    source: "x-reposters",
    source_profile_url: t.twitterUrl,
  }),
  metadata: xAmplifyMetadata,
};

export function runXAmplify(opts: XAmplifyRunOptions): Promise<{ drafted: XAmplifyDraft[] }> {
  return runEmailPlay(xAmplifyDef, opts);
}
