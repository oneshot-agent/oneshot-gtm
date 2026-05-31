import { getLedger, loadConfig } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, errorDraft, lintEmail, sendDraftedEmail } from "./_lib.ts";

const PLAY_NAME = "breakup-revive";

export interface BreakupReviveTarget {
  name: string | null;
  email: string;
  company: string | null;
  daysCold: number;
  lastEventAt: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
}

export interface BreakupReviveOptions {
  dryRun: boolean;
  /**
   * When provided, skip the ledger scan and use these prospects directly.
   * The queue-based flow (`find breakup-revive` → `find drain breakup-revive`)
   * goes through this path. When omitted, fall back to scanning the ledger.
   */
  targets?: BreakupReviveTarget[];
  /** Min days since last activity to consider cold. Default 60. (Ledger-scan mode only.) */
  minDays?: number;
  /** Max days since last activity to consider revivable. Default 90. (Ledger-scan mode only.) */
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

  const targets = opts.targets ?? ledgerScanTargets(opts);
  const drafted: BreakupReviveDraft[] = [];

  for (const t of targets) {
    if (!t.email) continue;
   try {
    const draft = await draftEmailFromPrompt({
      promptName: "breakup-revive-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name ?? "(unknown)"} at ${t.company ?? "(unknown)"}`,
        `DAYS SINCE LAST ACTIVITY: ${t.daysCold}`,
        `OPTIONAL VALUE DROP: ${opts.valueDrop ?? "(none — go with a probe question instead)"}`,
      ].join("\n"),
    });

    const flags = lintEmail(draft.subject, draft.body, 80);

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
        source: "breakup-revive",
      },
      metadata: { daysCold: t.daysCold, lastEventAt: t.lastEventAt },
      dryRun: opts.dryRun,
    });

    drafted.push({
      prospectEmail: t.email,
      prospectName: t.name,
      daysCold: t.daysCold,
      subject: draft.subject,
      body: draft.body,
      receiptIds: send.receiptIds,
      sent: send.sent,
      flags,
    });
   } catch (err) {
    const stub = errorDraft((err as Error)?.message);
    drafted.push({
      prospectEmail: t.email,
      prospectName: t.name,
      daysCold: t.daysCold,
      subject: stub.subject,
      body: stub.body,
      receiptIds: stub.receiptIds,
      sent: stub.sent,
      flags: stub.flags,
    });
   }
  }

  return { drafted };
}

function ledgerScanTargets(opts: BreakupReviveOptions): BreakupReviveTarget[] {
  const ledger = getLedger();
  const cold = ledger.listColdProspects({
    minDaysSinceLastEvent: opts.minDays ?? 60,
    maxDaysSinceLastEvent: opts.maxDays ?? 90,
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
  return cold
    .filter((p): p is typeof p & { email: string } => p.email != null)
    .map((p) => ({
      name: p.name,
      email: p.email,
      company: p.company,
      daysCold: p.last_event_at
        ? Math.floor((Date.now() - new Date(p.last_event_at).getTime()) / (24 * 3600 * 1000))
        : 0,
      lastEventAt: p.last_event_at,
      linkedinUrl: p.linkedin_url ?? null,
      phone: p.phone ?? null,
    }));
}
