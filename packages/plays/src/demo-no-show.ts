import { getLedger, loadConfig, sendSms } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { draftEmailFromPrompt, lintEmail, sendDraftedEmail } from "./_lib.ts";
import { buildFollowUpEmail, enrollInCadence, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "demo-no-show";

export interface DemoNoShowTarget {
  name: string;
  email: string;
  phone?: string;
  company: string;
  missedAt: string;
  rescheduleLink: string;
  whatTheyWanted?: string;
  linkedinUrl?: string;
}

export interface DemoNoShowRunOptions {
  dryRun: boolean;
  targets: DemoNoShowTarget[];
  /** Skip the SMS step (default: send if phone is present). */
  skipSms?: boolean;
}

export interface DemoNoShowResult {
  outcomes: Array<{
    target: DemoNoShowTarget;
    sms: { message: string; sent: boolean } | null;
    email: { subject: string; body: string; sent: boolean; flags: string[] };
    receiptIds: number[];
  }>;
}

export async function runDemoNoShow(opts: DemoNoShowRunOptions): Promise<DemoNoShowResult> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const outcomes: DemoNoShowResult["outcomes"] = [];

  for (const t of opts.targets) {
    const receiptIds: number[] = [];

    // SMS first (same-day)
    let smsResult: DemoNoShowResult["outcomes"][number]["sms"] = null;
    if (!opts.skipSms && t.phone) {
      const sms = await draftSmsBody(cfg.founderName, cfg.productOneLiner, t);
      let sent = false;
      if (!opts.dryRun && sms.length > 0 && sms.length <= 320) {
        const r = await sendSms({ to: t.phone, message: sms }, { playName: PLAY_NAME });
        receiptIds.push(r.receiptId);
        sent = true;
      }
      smsResult = { message: sms, sent };
    }

    // Same-day email
    const draft = await draftEmailFromPrompt({
      promptName: "demo-no-show-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `MISSED AT: ${t.missedAt}`,
        `RESCHEDULE LINK: ${t.rescheduleLink}`,
        `WHAT THEY WANTED: ${t.whatTheyWanted ?? "(not captured at booking)"}`,
      ].join("\n"),
    });
    const flags = lintEmail(draft.subject, draft.body, 100);

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
        source: "demo-no-show",
      },
      metadata: { missedAt: t.missedAt, rescheduleLink: t.rescheduleLink },
      dryRun: opts.dryRun,
    });
    receiptIds.push(...send.receiptIds);

    if (send.sent) {
      const ledger = getLedger();
      const prospect = ledger.findProspectByEmail(t.email);
      if (prospect) {
        enrollInCadence({ prospectId: prospect.id, playName: PLAY_NAME });
      }
    }

    outcomes.push({
      target: t,
      sms: smsResult,
      email: {
        subject: draft.subject,
        body: draft.body,
        sent: send.sent,
        flags,
      },
      receiptIds,
    });
  }

  return { outcomes };
}

async function draftSmsBody(
  founderName: string,
  productOneLiner: string,
  target: DemoNoShowTarget,
): Promise<string> {
  const system = loadPrompt("demo-no-show-sms");
  const user = [
    `FOUNDER: ${founderName.split(/\s+/)[0]}`,
    `PRODUCT: ${productOneLiner}`,
    `PROSPECT: ${target.name.split(/\s+/)[0]}`,
    `MISSED AT: ${target.missedAt}`,
  ].join("\n");
  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.5,
    maxTokens: 200,
  });
  const parsed = tryParseJsonObject<{ message?: string }>(res.content, {});
  return (parsed.message ?? "").trim();
}

registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 3,
      channel: "email",
      breakOnReply: true,
      label: "day-3 follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "demo-no-show-followup",
        contextLines: [`PLAY: demo-no-show day-3 follow-up. After this, drop the lead.`],
      }),
    },
  ],
});
