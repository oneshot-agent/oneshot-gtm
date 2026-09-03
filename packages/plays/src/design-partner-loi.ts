import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { designPartnerLoiMetadata } from "./_metadata.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "design-partner-loi";

/**
 * Buyer-type strings this play must NEVER draft for. The finders that feed
 * this play route by config (gov-solicitation, a future local-business pack),
 * so a misconfigured trigger — or a future pack pointing the wrong lane at
 * it — could hand this play an owner-operator target. Convention (the
 * TypeScript field being typed as a union) is not a guard: `buyerType`
 * arrives as a plain string off a finder payload, so the check must be a
 * runtime one, not just a type. Checked BEFORE any paid call.
 */
const BLOCKED_BUYER_TYPES = new Set([
  "owner-operator",
  "owner operator",
  "main-street",
  "main street",
]);

/**
 * Throws when `buyerType` names an owner-operator counterpart — the "design
 * partner" / "non-binding LOI" register is real language for enterprise,
 * government and hardware buyers and exactly the wrong language for an
 * independent restaurateur or a two-truck plumber (see #457's free-pilot /
 * discovery-interview instead). Exported so a test can assert the guard
 * directly, not just observe its effect on a drafted row.
 */
export function assertNotOwnerOperatorBuyer(buyerType: string): void {
  if (BLOCKED_BUYER_TYPES.has(buyerType.trim().toLowerCase())) {
    throw new Error(
      `design-partner-loi: refusing to draft for buyerType "${buyerType}" — this play is for ` +
        `enterprise/government/hardware counterparties only, never an owner-operator. Route this ` +
        `target to free-pilot or discovery-interview instead.`,
    );
  }
}

export interface DesignPartnerLoiTarget {
  name: string;
  email: string;
  company: string;
  /**
   * Who is being emailed — deliberately a plain string (not a union) so the
   * runtime guard above is what enforces the rule, not the type system: a
   * finder payload arrives untyped off JSON. Expected values: "enterprise",
   * "government", "hardware". "owner-operator" (or any main-street label)
   * throws in `prepare` before any paid call.
   */
  buyerType: string;
  /** One fact about how your product fits this buyer's evaluation criteria. */
  yourEdge: string;
  linkedinUrl?: string;
  phone?: string;
  /** Job title from the person-level ICP gate — persisted to prospects.title. */
  title?: string;
}

export interface DesignPartnerLoiRunOptions {
  dryRun: boolean;
  targets: DesignPartnerLoiTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
}

export interface DesignPartnerLoiDraft {
  target: DesignPartnerLoiTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const designPartnerLoiDef: EmailPlayDef<DesignPartnerLoiTarget> = {
  playName: PLAY_NAME,
  promptName: "design-partner-loi-email",
  maxBodyWords: 150,
  // Ask-ladder cadence: conversation (day 0) -> scoped pilot (day ~6) -> LOI (day ~14).
  enrollCadence: true,
  toEmail: (t) => t.email,
  prepare: (t) => {
    assertNotOwnerOperatorBuyer(t.buyerType);
    return standardEnrich({
      playName: PLAY_NAME,
      enrichInput: {
        ...(t.email ? { email: t.email } : {}),
        ...(t.linkedinUrl ? { linkedinUrl: t.linkedinUrl } : {}),
        name: t.name,
        companyDomain: emailDomain(t.email),
      },
      enrichSlice: 3500,
    });
  },
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name} at ${t.company}`,
      `BUYER TYPE: ${t.buyerType}`,
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "design-partner-loi",
  }),
  metadata: designPartnerLoiMetadata,
};

export function runDesignPartnerLoi(
  opts: DesignPartnerLoiRunOptions,
): Promise<{ drafted: DesignPartnerLoiDraft[] }> {
  return runEmailPlay(designPartnerLoiDef, opts);
}

// Ask ladder: day-0 asks for the conversation; day-6 steps up to a scoped
// pilot slot; day-14 steps up again to the non-binding LOI itself. Each rung
// is a bigger ask than the last, which is the whole point of the ladder —
// never re-ask the same thing twice.
registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 6,
      channel: "email",
      breakOnReply: true,
      label: "scoped pilot ask",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "design-partner-loi-pilot-followup",
        contextLines: [
          `PLAY: design-partner-loi. Step 2 of the ask ladder: no reply to the conversation ask, ` +
            `so step up to proposing a scoped design-partner pilot slot instead.`,
        ],
      }),
    },
    {
      dayOffset: 8, // ~14 days from enrollment
      channel: "email",
      breakOnReply: true,
      label: "loi ask",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "design-partner-loi-loi-followup",
        contextLines: [
          `PLAY: design-partner-loi. Final rung of the ask ladder: propose the non-binding LOI ` +
            `directly, framed as the lowest-commitment way to lock in early access.`,
        ],
      }),
    },
  ],
});
