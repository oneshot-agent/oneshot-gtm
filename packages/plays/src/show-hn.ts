import { deepResearch, enrichProfile, loadConfig } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, lintEmail, sendDraftedEmail } from "./_lib.ts";
export { receiptUrls } from "./_lib.ts";

export interface ShowHnTarget {
  postTitle: string;
  postUrl: string;
  founderName: string;
  founderEmail: string;
  hookSummary: string;
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
    const receiptIds: number[] = [];
    let dossier = "";

    if (!opts.dryRun) {
      const enr = await enrichProfile(
        { email: target.founderEmail, name: target.founderName },
        { playName: PLAY_NAME },
      );
      receiptIds.push(enr.receiptId);
      dossier = JSON.stringify(enr.result, null, 2).slice(0, 3500);

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
  }

  return { drafted };
}

function extractCompany(title: string): string | null {
  const m = title.match(/Show HN:\s*([^\s—–:|-]+)/i);
  return m ? (m[1] ?? null) : null;
}
