import { deepResearch, getLedger, loadConfig } from "@oneshot-gtm/core";
import {
  draftEmailFromPrompt,
  errorDraft,
  lintEmail,
  safeEnrich,
  sendDraftedEmail,
  socialProofBlock,
  type SendDraftedOpts,
} from "./_lib.ts";
import { enrollInCadence } from "./_cadence.ts";

type AppConfig = ReturnType<typeof loadConfig>;

/**
 * What a play's per-target `prepare` step hands back to the executor: the
 * receipts it billed, the dossier string it assembled (may be empty), and an
 * optional `extra` bag of play-specific fields that get merged onto the
 * drafted row verbatim (e.g. competitor-switch's `scrapedEvidence`,
 * hiring-signal's `jobPostHook`). `X` defaults to no extra fields.
 */
export interface Prepared<X = Record<string, never>> {
  receiptIds: number[];
  dossier: string;
  extra?: X;
}

/** Drafted row every email play returns: the standard six fields plus `X`. */
export type PlayDraft<T, X = Record<string, never>> = {
  target: T;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
} & X;

/**
 * Declarative definition of an email play. The shared executor (`runEmailPlay`)
 * walks the targets, runs `prepare` → draft → lint → send → optional cadence
 * enroll, and wraps each per-target body in the same try/catch error envelope.
 * Everything that varies between plays is a field or a closure here.
 */
export interface EmailPlayDef<T, X = Record<string, never>> {
  playName: string;
  promptName: string;
  /** Per-play word budget passed to `lintEmail`. */
  maxBodyWords: number;
  toEmail: (t: T) => string;
  /**
   * Enrichment / research / scrape phase. Owns all SDK calls that build
   * context for the draft. Use `standardEnrich` for the safeEnrich(+deepResearch)
   * shape; plays with browser/websearch context supply their own.
   */
  prepare: (t: T, dryRun: boolean) => Promise<Prepared<X>>;
  buildInputBlock: (t: T, prep: Prepared<X>, cfg: AppConfig) => string;
  prospectMeta: (t: T) => SendDraftedOpts["prospectMeta"];
  metadata?: (t: T) => Record<string, unknown>;
  /** Enroll the prospect in this play's cadence after a real send. */
  enrollCadence?: boolean;
  /** Extra fields merged onto the row when a target throws (e.g. jobPostHook). */
  errorExtra?: X;
}

/**
 * Run an email play over its targets. Behavior-preserving extraction of the
 * per-target loop that every email play used to hand-roll: enrich/research →
 * draft → lint → send → (optional) cadence enroll, with a per-target try/catch
 * so one bad target can't kill the batch.
 */
export async function runEmailPlay<T, X = Record<string, never>>(
  def: EmailPlayDef<T, X>,
  opts: { dryRun: boolean; targets: T[] },
): Promise<{ drafted: Array<PlayDraft<T, X>> }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: Array<PlayDraft<T, X>> = [];

  for (const target of opts.targets) {
    try {
      const prep = await def.prepare(target, opts.dryRun);

      // Append SOCIAL PROOF block when any of the three optional fields is
      // set. Prompts treat it as conditional input — present only when set,
      // and the prompt picks ONE beat per email (never stacks).
      const proof = socialProofBlock();
      const inputBlock = proof
        ? `${def.buildInputBlock(target, prep, cfg)}\n\n${proof}`
        : def.buildInputBlock(target, prep, cfg);
      const draft = await draftEmailFromPrompt({
        promptName: def.promptName,
        inputBlock,
      });

      const flags = lintEmail(draft.subject, draft.body, def.maxBodyWords);

      const send = await sendDraftedEmail({
        playName: def.playName,
        to: def.toEmail(target),
        draft,
        flags,
        prospectMeta: def.prospectMeta(target),
        ...(def.metadata ? { metadata: def.metadata(target) } : {}),
        dryRun: opts.dryRun,
      });

      if (send.sent && def.enrollCadence) {
        const prospect = getLedger().findProspectByEmail(def.toEmail(target));
        if (prospect) enrollInCadence({ prospectId: prospect.id, playName: def.playName });
      }

      drafted.push({
        target,
        subject: draft.subject,
        body: draft.body,
        receiptIds: [...prep.receiptIds, ...send.receiptIds],
        sent: send.sent,
        flags,
        ...(prep.extra ?? ({} as X)),
      } as PlayDraft<T, X>);
    } catch (err) {
      drafted.push({
        target,
        ...errorDraft((err as Error)?.message),
        ...(def.errorExtra ?? ({} as X)),
      } as PlayDraft<T, X>);
    }
  }

  return { drafted };
}

/**
 * The common `prepare` body for plays that personalize via `safeEnrich` (cached
 * by email, never throws) and, on real sends only, a `deepResearch` dossier.
 * Pass `research` only when you want the research call to fire — callers gate it
 * on `!dryRun` (and, for accelerator-batch, on a launch URL being present).
 */
export async function standardEnrich(opts: {
  playName: string;
  enrichInput: Parameters<typeof safeEnrich>[0];
  enrichSlice: number;
  research?: { topic: string; slice?: number };
}): Promise<Prepared> {
  const receiptIds: number[] = [];

  const enr = await safeEnrich(opts.enrichInput, { playName: opts.playName });
  if (enr.receiptId) receiptIds.push(enr.receiptId);
  let dossier = JSON.stringify(enr.result, null, 2).slice(0, opts.enrichSlice);

  if (opts.research) {
    const research = await deepResearch(
      { topic: opts.research.topic, depth: "quick" },
      { playName: opts.playName },
    );
    receiptIds.push(research.receiptId);
    dossier +=
      "\n\n---\n\n" + JSON.stringify(research.result, null, 2).slice(0, opts.research.slice ?? 4000);
  }

  return { receiptIds, dossier };
}
