import {
  deepResearch,
  getLedger,
  hasDossierSignal,
  isRunCancelled,
  isSendDeferred,
  loadConfig,
  parallelMap,
  throwIfCancelled,
  CONTACTED_ELSEWHERE_FLAG,
  recentTouchElsewhere,
} from "@oneshot-gtm/core";
import {
  draftEmailFromPrompt,
  errorDraft,
  firstNameFrom,
  lintEmail,
  logTargetError,
  safeEnrich,
  sendDraftedEmail,
  admissionBlock,
  socialProofBlock,
  type SendDraftedOpts,
} from "./_lib.ts";
import { enrollInCadence } from "./_cadence.ts";

type AppConfig = ReturnType<typeof loadConfig>;

/** Cap on the dossier persisted onto a prospect — matches the slice the
 *  finders already apply to a queued dossier (x-reposters, add-prospect). */
const DOSSIER_SLICE = 6000;

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
   *
   * `signal` is the run's cancellation signal. The executor already guards the
   * boundary before `prepare` is entered, so a def that ignores the arg is
   * still safe — forward it (or `throwIfCancelled` on it) when `prepare` makes
   * more than one paid call, so the second one doesn't fire after an abort.
   */
  prepare: (t: T, dryRun: boolean, signal?: AbortSignal) => Promise<Prepared<X>>;
  buildInputBlock: (t: T, prep: Prepared<X>, cfg: AppConfig) => string;
  prospectMeta: (t: T) => SendDraftedOpts["prospectMeta"];
  metadata?: (t: T) => Record<string, unknown>;
  /**
   * Play-specific flags merged with the lint flags. Any non-empty flag set
   * holds the draft (sendDraftedEmail won't send when flags are present), so
   * this is how a play marks a target as draft-but-don't-auto-send for review
   * (e.g. luma-events flags `stale-event` for long-passed events).
   */
  extraFlags?: (t: T) => string[];
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
    /**
     * Cancellation signal for the whole run, owned by the /api/run SSE handler
     * (it aborts on client disconnect and on POST /api/run/:runId/cancel).
     * Checked at every paid-call boundary below, so an abort stops the spend
     * within one in-flight SDK call per worker instead of at the end of the
     * batch. Absent (CLI, drain) → the run is uncancellable, as before.
     */
    signal?: AbortSignal;
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
        // Guard #1 — the whole target. Workers pull from a shared cursor, so
        // every target still queued behind the abort dies here having billed
        // nothing at all.
        throwIfCancelled(opts.signal, `${def.playName} prepare`);
        const prep = await def.prepare(target, opts.dryRun, opts.signal);

        // Append SOCIAL PROOF block when any of the three optional fields is
        // set. Prompts treat it as conditional input — present only when set,
        // and the prompt picks ONE beat per email (never stacks).
        const proof = socialProofBlock();
        let inputBlock = proof
          ? `${def.buildInputBlock(target, prep, cfg)}\n\n${proof}`
          : def.buildInputBlock(target, prep, cfg);
        // Same conditional shape for the damaging-admission beat: present only
        // when the founder wrote one AND this prospect drew the ~1-in-3 slot,
        // so the prompt has real material or none (and never a frequency to
        // keep, which it can't).
        const admission = admissionBlock(def.toEmail(target));
        if (admission) inputBlock = `${inputBlock}\n\n${admission}`;
        // Surface a real first name when extractable so the prompt can
        // occasionally open with "Hey {firstName},". Absent → prompt rule
        // says never invent a greeting; LLM dives into the Hook.
        const firstName = firstNameFrom(def.prospectMeta(target).name ?? null);
        if (firstName) {
          inputBlock = `${inputBlock}\n\nPROSPECT_FIRST_NAME: ${firstName}`;
        }
        // Guard #2 — the LLM draft, the paid call `prepare` was feeding.
        throwIfCancelled(opts.signal, `${def.playName} draft`);
        const draft = await draftEmailFromPrompt({
          promptName: def.promptName,
          inputBlock,
        });

        const flags = [
          ...lintEmail(draft.subject, draft.body, def.maxBodyWords),
          ...(def.extraFlags?.(target) ?? []),
        ];
        // Cross-workspace hold, applied centrally so EVERY play gets it: a
        // soft flag (overridable on manual send) that keeps drain from auto-
        // sending to someone another workspace emailed this week.
        if (recentTouchElsewhere(def.toEmail(target))) flags.push(CONTACTED_ELSEWHERE_FLAG);

        // Guard #3 — the send. The one call that both bills AND is visible to
        // the prospect, so it is the boundary that matters most: past here the
        // founder has an email in someone's inbox they asked us not to send.
        throwIfCancelled(opts.signal, `${def.playName} send`);
        const send = await sendDraftedEmail({
          playName: def.playName,
          to: def.toEmail(target),
          draft,
          flags,
          prospectMeta: {
            ...def.prospectMeta(target),
            // Read generically (mirrors the /queue route's prospectMeta): any
            // finder that stamps `title` on its target payload gets it
            // persisted without each play def naming the field.
            ...(typeof (target as { title?: unknown }).title === "string"
              ? { title: (target as { title: string }).title }
              : {}),
            // Persist the research this play just assembled. Every play returns
            // a dossier from `prepare`, and until now all of it was thrown away
            // the moment the draft was written — so the reply drafter's free
            // Tier-1 read always missed and re-bought the same research.
            // hasDossierSignal, not a bare trim: a FAILED enrich still
            // serializes to `{"status":"failed",...}`, and storing that would
            // register as a Tier-1 hit and suppress the paid research the
            // reply drafter would otherwise do.
            ...(hasDossierSignal(prep.dossier)
              ? { dossier_json: prep.dossier.slice(0, DOSSIER_SLICE) }
              : {}),
          },
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
        // Neither is a cancellation: swallowing it here would turn every
        // remaining target into an errorDraft and let the run finish 'done'.
        // Propagating instead is what makes the run row land 'cancelled'.
        if (isRunCancelled(err)) throw err;
        logTargetError({ playName: def.playName, to: def.toEmail(target), err });
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
    opts.onProgress ? (_target, result, index) => opts.onProgress?.(index, result) : undefined,
  );

  return { drafted };
}

/**
 * The common `prepare` body for plays that personalize via `safeEnrich` (cached
 * by email, never throws) and, on real sends only, a `deepResearch` dossier.
 * Pass `research` only when you want the research call to fire — callers gate it
 * on `!dryRun` (and, for accelerator-batch, on a launch URL being present).
 *
 * `signal` is forwarded by every play's `prepare`: this is the one place two
 * paid calls sit back to back, so a run cancelled during the enrich must not go
 * on to buy the dossier.
 */
export async function standardEnrich(opts: {
  playName: string;
  enrichInput: Parameters<typeof safeEnrich>[0];
  enrichSlice: number;
  research?: { topic: string; slice?: number };
  signal?: AbortSignal;
}): Promise<Prepared> {
  const receiptIds: number[] = [];

  throwIfCancelled(opts.signal, `${opts.playName} enrich`);
  const enr = await safeEnrich(opts.enrichInput, { playName: opts.playName });
  if (enr.receiptId) receiptIds.push(enr.receiptId);
  const enrichmentFailed = (enr.result as { status?: string }).status === "failed";
  let dossier = JSON.stringify(enr.result, null, 2).slice(0, opts.enrichSlice);

  if (opts.research) {
    throwIfCancelled(opts.signal, `${opts.playName} research`);
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
