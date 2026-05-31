import { deepResearch, loadConfig } from "@oneshot-gtm/core";
import {
  draftEmailFromPrompt,
  errorDraft,
  lintEmail,
  safeEnrich,
  sendDraftedEmail,
} from "./_lib.ts";
export { receiptUrls } from "./_lib.ts";

export interface ShowHnTarget {
  postTitle: string;
  postUrl: string;
  founderName: string;
  founderEmail: string;
  hookSummary: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface ShowHnRunOptions {
  dryRun: boolean;
  targets: ShowHnTarget[];
}

export interface ShowHnRunResult {
  drafted: Array<{
    target: ShowHnTarget;
    subject: string;
    body: string;
    receiptIds: number[];
    sent: boolean;
    flags: string[];
  }>;
}

const PLAY_NAME = "show-hn";

export async function runShowHn(opts: ShowHnRunOptions): Promise<ShowHnRunResult> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: ShowHnRunResult["drafted"] = [];

  for (const target of opts.targets) {
   try {
    const receiptIds: number[] = [];

    // Enrich on both preview and real send (cached by email) so the reviewed
    // draft is personalized; the heavier deepResearch stays real-send only.
    const enr = await safeEnrich(
      { email: target.founderEmail, name: target.founderName },
      { playName: PLAY_NAME },
    );
    if (enr.receiptId) receiptIds.push(enr.receiptId);
    let dossier = JSON.stringify(enr.result, null, 2).slice(0, 3500);

    if (!opts.dryRun) {
      const research = await deepResearch(
        {
          topic: `Recent public work and engineering decisions by ${target.founderName} on ${target.postTitle}`,
          depth: "quick",
        },
        { playName: PLAY_NAME },
      );
      receiptIds.push(research.receiptId);
      dossier += "\n\n---\n\n" + JSON.stringify(research.result, null, 2).slice(0, 4000);
    }

    const draft = await draftEmailFromPrompt({
      promptName: "show-hn-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `SHOW HN: ${target.postTitle}`,
        `URL: ${target.postUrl}`,
        `HOOK: ${target.hookSummary}`,
        `DOSSIER:\n${dossier || "(dry-run; rely on the hook only)"}`,
      ].join("\n"),
    });

    const flags = lintEmail(draft.subject, draft.body, 90);

    const send = await sendDraftedEmail({
      playName: PLAY_NAME,
      to: target.founderEmail,
      draft,
      flags,
      prospectMeta: {
        name: target.founderName,
        email: target.founderEmail,
        company: extractCompany(target.postTitle),
        linkedin_url: target.linkedinUrl ?? null,
        phone: target.phone ?? null,
        source: "show-hn",
      },
      metadata: { postUrl: target.postUrl, postTitle: target.postTitle },
      dryRun: opts.dryRun,
    });

    drafted.push({
      target,
      subject: draft.subject,
      body: draft.body,
      receiptIds: [...receiptIds, ...send.receiptIds],
      sent: send.sent,
      flags,
    });
   } catch (err) {
    drafted.push({ target, ...errorDraft((err as Error)?.message) });
   }
  }

  return { drafted };
}

function extractCompany(title: string): string | null {
  const m = title.match(/Show HN:\s*([^\s—–:|-]+)/i);
  return m ? (m[1] ?? null) : null;
}
