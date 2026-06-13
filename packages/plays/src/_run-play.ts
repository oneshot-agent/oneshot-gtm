import { deepResearch, getLedger, isSendDeferred, loadConfig, parallelMap } from "@oneshot-gtm/core";
import {
  draftEmailFromPrompt,
  errorDraft,
  firstNameFrom,
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
  /**
   * The enrichment SDK call failed (live or negative-cached) — the draft was
   * built from payload context only. Travels to the persisted draft envelope
   * so /queue can surface it; deliberately NOT a lint flag (flags block
   * sending, and a payload-only draft is still sendable).
   */
  enrichmentFailed?: boolean;
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
  /** See Prepared.enrichmentFailed. */
  enrichmentFailed?: boolean;
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
  opts: {
    dryRun: boolean;
    targets: T[];
    /**
     * Optional per-target progress callback. Fires once per target after the
     * full prepare → draft → lint → send chain resolves (or throws + lands as
     * an errorDraft). The /api/run SSE handler uses this to emit `draft` +
     * `send` events live so the UI's progress counters tick as each target
     * finishes, instead of jumping from 0/N to N/N at the very end.
     *
     * Order: fires in completion order across the worker pool, not input
     * order. Consumers that need stable indexing read the `index` arg.
     */
    onProgress?: (index: number, draft: PlayDraft<T, X>) => void;
  },
): Promise<{ drafted: Array<PlayDraft<T, X>> }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }

  // Process targets in parallel (each is an LLM draft + send, ~5-90s). Drop to
  // serial when the batch has duplicate emails: sendDraftedEmail's per-(prospect,
  // play) step-0 dedupe is read-then-write, and only the serial order guarantees
  // a duplicate doesn't slip a second send through the window. Finder-drained
  // batches are already unique, so they get the full concurrency.
  //
  // Concurrency 6 (was 3): the per-target chain is mostly I/O bound on the
  // OneShot SDK + LLM provider, both of which handle parallel calls fine. With
  // the find→cache→/run cache-hit path warm, the residual draft+send time is
  // small enough that 6 workers comfortably halve wall-clock without tripping
  // SDK rate limits in observed runs.
  const emails = opts.targets.map((t) => def.toEmail(t).trim().toLowerCase());
  const hasDupeEmails = new Set(emails).size !== emails.length;
  const concurrency = hasDupeEmails ? 1 : 6;

  const drafted = await parallelMap(
    opts.targets,
    concurrency,
    async (target) => {
    try {
      const prep = await def.prepare(target, opts.dryRun);

      // Append SOCIAL PROOF block when any of the three optional fields is
      // set. Prompts treat it as conditional input — present only when set,
      // and the prompt picks ONE beat per email (never stacks).
      const proof = socialProofBlock();
      let inputBlock = proof
        ? `${def.buildInputBlock(target, prep, cfg)}\n\n${proof}`
        : def.buildInputBlock(target, prep, cfg);
      // Surface a real first name when extractable so the prompt can
      // occasionally open with "Hey {firstName},". Absent → prompt rule
      // says never invent a greeting; LLM dives into the Hook.
      const firstName = firstNameFrom(def.prospectMeta(target).name ?? null);
      if (firstName) {
        inputBlock = `${inputBlock}\n\nPROSPECT_FIRST_NAME: ${firstName}`;
      }
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

      return {
        target,
        subject: draft.subject,
        body: draft.body,
        receiptIds: [...prep.receiptIds, ...send.receiptIds],
        sent: send.sent,
        flags,
        ...(prep.enrichmentFailed ? { enrichmentFailed: true } : {}),
        ...(prep.extra ?? ({} as X)),
      } as PlayDraft<T, X>;
    } catch (err) {
      // Daily-cap deferral is not a per-target failure — propagate so the
      // caller (drain / SSE run) leaves remaining targets queued.
      if (isSendDeferred(err)) throw err;
      return {
        target,
        ...errorDraft((err as Error)?.message),
        ...(def.errorExtra ?? ({} as X)),
      } as PlayDraft<T, X>;
    }
    },
    // parallelMap's per-completion hook — forward through if the caller wired
    // a progress sink. Stays in completion order (not index order); the SSE
    // consumer keys by the `index` arg.
    opts.onProgress
      ? (_target, result, index) => opts.onProgress?.(index, result)
      : undefined,
  );

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
  const enrichmentFailed = (enr.result as { status?: string }).status === "failed";
  let dossier = JSON.stringify(enr.result, null, 2).slice(0, opts.enrichSlice);

  if (opts.research) {
    const research = await deepResearch(
      { topic: opts.research.topic, depth: "quick" },
      { playName: opts.playName },
    );
    receiptIds.push(research.receiptId);
    dossier +=
      "\n\n---\n\n" +
      JSON.stringify(research.result, null, 2).slice(0, opts.research.slice ?? 4000);
  }

  return { receiptIds, dossier, ...(enrichmentFailed ? { enrichmentFailed: true } : {}) };
}
