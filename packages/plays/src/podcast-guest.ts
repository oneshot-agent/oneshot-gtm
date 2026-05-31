import { getLedger, loadConfig, webSearch } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, errorDraft, lintEmail, sendDraftedEmail } from "./_lib.ts";
import { enrollInCadence, registerSequence } from "./_cadence.ts";

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

export async function runPodcastGuest(
  opts: PodcastGuestRunOptions,
): Promise<{ drafted: PodcastGuestDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: PodcastGuestDraft[] = [];

  for (const t of opts.targets) {
   try {
    const receiptIds: number[] = [];
    let extra = "";

    if (!opts.dryRun) {
      if (!opts.skipSearch) {
        const s = await webSearch(
          {
            query: `${t.name} ${t.podcast} "${t.episodeTitle}" notes OR transcript`,
            maxResults: 3,
          },
          { playName: PLAY_NAME },
        );
        receiptIds.push(s.receiptId);
        extra = s.result.results
          .slice(0, 2)
          .map((r) => `- ${r.title}: ${r.description}`)
          .join("\n");
      }
    }

    const draft = await draftEmailFromPrompt({
      promptName: "podcast-guest-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `PODCAST: ${t.podcast}`,
        `EPISODE: ${t.episodeTitle}`,
        `HOOK QUOTE: ${t.hookQuote}`,
        `BRIDGE TO YOUR WORK: ${t.bridge ?? "(none — keep the email purely about their point)"}`,
        `EXTRA CONTEXT FROM SEARCH:\n${extra || "(none)"}`,
      ].join("\n"),
    });

    const flags = lintEmail(draft.subject, draft.body, 90);

    const send = await sendDraftedEmail({
      playName: PLAY_NAME,
      to: t.email,
      draft,
      flags,
      prospectMeta: {
        name: t.name,
        email: t.email,
        company: t.company,
        linkedin_url: t.linkedinUrl ?? null,
        phone: t.phone ?? null,
        source: "podcast-guest",
      },
      metadata: { podcast: t.podcast, episodeTitle: t.episodeTitle },
      dryRun: opts.dryRun,
    });

    if (send.sent) {
      const ledger = getLedger();
      const prospect = ledger.findProspectByEmail(t.email);
      if (prospect) enrollInCadence({ prospectId: prospect.id, playName: PLAY_NAME });
    }

    drafted.push({
      target: t,
      subject: draft.subject,
      body: draft.body,
      receiptIds: [...receiptIds, ...send.receiptIds],
      sent: send.sent,
      flags,
    });
   } catch (err) {
    drafted.push({ target: t, ...errorDraft((err as Error)?.message) });
   }
  }

  return { drafted };
}

registerSequence({
  playName: PLAY_NAME,
  steps: [], // Intentionally empty — podcast-guest is one-touch only.
});
