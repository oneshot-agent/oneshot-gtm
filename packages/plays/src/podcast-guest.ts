import { webSearch } from "@oneshot-gtm/core";
import { type EmailPlayDef, runEmailPlay } from "./_run-play.ts";
import { registerSequence } from "./_cadence.ts";

const PLAY_NAME = "podcast-guest";

export interface PodcastGuestTarget {
  name: string;
  email: string;
  company: string;
  /** Podcast name (e.g. "Latent Space", "Lenny's Podcast"). */
  podcast: string;
  /** Episode title or descriptor. */
  episodeTitle: string;
  /** A specific quote or timestamped moment that you'll reference. Required. */
  hookQuote: string;
  /** ONE-sentence reason the moment matters to your work. */
  bridge?: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface PodcastGuestRunOptions {
  dryRun: boolean;
  targets: PodcastGuestTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Skip the optional web-search dossier enrichment. */
  skipSearch?: boolean;
}

export interface PodcastGuestDraft {
  target: PodcastGuestTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

export function runPodcastGuest(
  opts: PodcastGuestRunOptions,
): Promise<{ drafted: PodcastGuestDraft[] }> {
  const def: EmailPlayDef<PodcastGuestTarget> = {
    playName: PLAY_NAME,
    promptName: "podcast-guest-email",
    maxBodyWords: 150,
    enrollCadence: true,
    toEmail: (t) => t.email,
    prepare: async (t, dryRun) => {
      const receiptIds: number[] = [];
      let dossier = "";

      if (!dryRun && !opts.skipSearch) {
        const s = await webSearch(
          {
            query: `${t.name} ${t.podcast} "${t.episodeTitle}" notes OR transcript`,
            maxResults: 3,
          },
          { playName: PLAY_NAME },
        );
        receiptIds.push(s.receiptId);
        dossier = s.result.results
          .slice(0, 2)
          .map((r) => `- ${r.title}: ${r.description}`)
          .join("\n");
      }

      return { receiptIds, dossier };
    },
    buildInputBlock: (t, prep, cfg) =>
      [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `PODCAST: ${t.podcast}`,
        `EPISODE: ${t.episodeTitle}`,
        `HOOK QUOTE: ${t.hookQuote}`,
        `BRIDGE TO YOUR WORK: ${t.bridge ?? "(none — keep the email purely about their point)"}`,
        `EXTRA CONTEXT FROM SEARCH:\n${prep.dossier || "(none)"}`,
      ].join("\n"),
    prospectMeta: (t) => ({
      name: t.name,
      email: t.email,
      company: t.company,
      linkedin_url: t.linkedinUrl ?? null,
      phone: t.phone ?? null,
      source: "podcast-guest",
    }),
    metadata: (t) => ({ podcast: t.podcast, episodeTitle: t.episodeTitle }),
  };

  return runEmailPlay(def, opts);
}

registerSequence({
  playName: PLAY_NAME,
  steps: [], // Intentionally empty — podcast-guest is one-touch only.
});
