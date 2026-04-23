import { getLedger, loadConfig } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, lintEmail, sendDraftedEmail } from "./_lib.ts";

const PLAY_NAME = "breakup-revive";

export interface BreakupReviveOptions {
  dryRun: boolean;
  /** Min days since last activity to consider cold. Default 60. */
  minDays?: number;
  /** Max days since last activity to consider revivable. Default 90. */
  maxDays?: number;
  /** Hard cap on prospects to revive in one run. Default 25. */
  limit?: number;
  /** Optional value drop to lead with (a new feature, a benchmark, a case study you can offer). */
  valueDrop?: string;
}

export interface BreakupReviveDraft {
  prospectEmail: string | null;
  prospectName: string | null;
  daysCold: number;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

export async function runBreakupRevive(
  opts: BreakupReviveOptions,
): Promise<{ drafted: BreakupReviveDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const ledger = getLedger();
  const cold = ledger.listColdProspects({
    minDaysSinceLastEvent: opts.minDays ?? 60,
    maxDaysSinceLastEvent: opts.maxDays ?? 90,
    ...(opts.limit ? { limit: opts.limit } : {}),
  });

  const drafted: BreakupReviveDraft[] = [];

  for (const p of cold) {
    if (!p.email) continue;
    const daysCold = p.last_event_at
      ? Math.floor((Date.now() - new Date(p.last_event_at).getTime()) / (24 * 3600 * 1000))
      : 0;

    const draft = await draftEmailFromPrompt({
      promptName: "breakup-revive-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${p.name ?? "(unknown)"} at ${p.company ?? "(unknown)"}`,
        `DAYS SINCE LAST ACTIVITY: ${daysCold}`,
        `OPTIONAL VALUE DROP: ${opts.valueDrop ?? "(none — go with a probe question instead)"}`,
      ].join("\n"),
    });

    const flags = lintEmail(draft.subject, draft.body, 80);

    const send = await sendDraftedEmail({
      playName: PLAY_NAME,
      to: p.email,
      draft,
      flags,
      prospectMeta: {
        name: p.name,
        email: p.email,
        company: p.company,
        source: "breakup-revive",
      },
      metadata: { daysCold, lastEventAt: p.last_event_at },
      dryRun: opts.dryRun,
    });

    drafted.push({
      prospectEmail: p.email,
      prospectName: p.name,
      daysCold,
      subject: draft.subject,
      body: draft.body,
      receiptIds: send.receiptIds,
      sent: send.sent,
      flags,
    });
  }

  return { drafted };
}
