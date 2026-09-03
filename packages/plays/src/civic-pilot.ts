import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { civicPilotMetadata } from "./_metadata.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "civic-pilot";

export interface CivicPilotTarget {
  name: string;
  email: string;
  city: string;
  /** The specific agenda item's title, from the council/county agenda. */
  agendaItemTitle: string;
  /** The meeting date the item is/was heard, ISO date. */
  meetingDate: string;
  agendaUrl?: string;
  /** A cooperative purchasing vehicle the city/county can buy off (Sourcewell, NASPO ValuePoint, OMNIA) — REQUIRED so the ask is concrete, not "let's do an RFP". */
  purchasingVehicle: string;
  /** One fact about how your product fits the agenda item's stated need. */
  yourEdge: string;
  phone?: string;
  /** Job title (e.g. "City Manager", "IT Director") — persisted to prospects.title. */
  title?: string;
}

export interface CivicPilotRunOptions {
  dryRun: boolean;
  targets: CivicPilotTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
}

export interface CivicPilotDraft {
  target: CivicPilotTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const civicPilotDef: EmailPlayDef<CivicPilotTarget> = {
  playName: PLAY_NAME,
  promptName: "civic-pilot-email",
  maxBodyWords: 150,
  enrollCadence: true,
  toEmail: (t) => t.email,
  prepare: (t) =>
    standardEnrich({
      playName: PLAY_NAME,
      enrichInput: {
        ...(t.email ? { email: t.email } : {}),
        name: t.name,
        companyDomain: emailDomain(t.email),
      },
      enrichSlice: 3500,
    }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name} at ${t.city}`,
      `AGENDA ITEM: ${t.agendaItemTitle}`,
      `MEETING DATE: ${t.meetingDate}`,
      `PURCHASING VEHICLE: ${t.purchasingVehicle}`,
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.city,
    phone: t.phone ?? null,
    source: "civic-pilot",
    source_profile_url: t.agendaUrl ?? null,
  }),
  metadata: civicPilotMetadata,
};

export function runCivicPilot(opts: CivicPilotRunOptions): Promise<{ drafted: CivicPilotDraft[] }> {
  return runEmailPlay(civicPilotDef, opts);
}

// One-touch + one follow-up: a heard agenda item's budget window closes fast,
// same reasoning as sources-sought.
registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 5,
      channel: "email",
      breakOnReply: true,
      label: "follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "civic-pilot-followup",
        contextLines: [
          `PLAY: civic-pilot. Day-5 follow-up on the pilot proposal tied to the agenda item.`,
        ],
      }),
    },
  ],
});
