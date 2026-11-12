import { getLedger, loadConfig, parallelMap, type CadenceWithProspect } from "@oneshot-gtm/core";
import {
  effectiveSequence,
  ensureCloseOffer,
  isProspectOffer,
  offerProductHash,
  pickCloseOffer,
  playMakesOffer,
  sequenceOfferOf,
  sequenceThread,
  type OfferThreadEmail,
  type SequenceOfferRecord,
} from "@oneshot-gtm/plays";
import { c, header, ok, resolveCap, warn } from "../output.ts";

/**
 * `find close-offers`: give every active emailed sequence whose LinkedIn
 * close is still ahead the offer that close makes (`ensureCloseOffer`), so
 * the /cadences view shows the text that goes. A stored offer the judge
 * passed is picked for free; a sequence with none gets one written around
 * every offer already made (one writer and one judge call). The active offer
 * is never changed. A sequence already settled (its stored close still
 * stands, or the writer's none under today's brief) is counted and left, so
 * `--limit` runs move on. `--dry-run` writes nothing and calls no model: it
 * counts the sequences that would pick and the ones that would get an offer
 * written.
 */
export interface CloseOffersOpts {
  dryRun: boolean;
  limit?: number;
  concurrency?: number;
}

export interface CloseOffersSummary {
  /** Active emailed sequences of offer-making plays with a LinkedIn close ahead. */
  eligible: number;
  /** Of those, already settled: their stored close stands, or the writer found none. */
  settled: number;
  /** A stored offer was (or would be) made the close. */
  picked: string[];
  /** A close offer was written (dry run: would be). */
  written: string[];
  /** No close offer: the writer found none, or none passed. */
  none: string[];
  errors: number;
  costUsd: number;
}

const CLOSE_STEP_ID = "linkedin:2";

/** Whether this cadence still has its LinkedIn close ahead and has sent an email. */
function closeAhead(cad: CadenceWithProspect): boolean {
  const steps = effectiveSequence(cad.play_name, cad.prospect_id)?.steps ?? [];
  const at = steps.findIndex((s) => s.id === CLOSE_STEP_ID);
  if (at < 0 || cad.current_step > at) return false;
  return getLedger()
    .listSequenceEventsForProspectPlay(cad.prospect_id, cad.play_name)
    .some(
      (e) =>
        e.channel === "email" &&
        (e.status === "sent" || e.status === "delivered" || e.status === "replied"),
    );
}

function short(text: string): string {
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

export async function commandCloseOffers(opts: CloseOffersOpts): Promise<CloseOffersSummary> {
  header(`close-offers${opts.dryRun ? " --dry-run" : ""}`);
  const cfg = loadConfig();
  const summary: CloseOffersSummary = {
    eligible: 0,
    settled: 0,
    picked: [],
    written: [],
    none: [],
    errors: 0,
    costUsd: 0,
  };
  const hash = offerProductHash(cfg);
  const hasBrief = !!cfg.productBrief?.trim();
  const sequences: Array<{
    cad: CadenceWithProspect;
    record: SequenceOfferRecord;
    picked: ReturnType<typeof pickCloseOffer>;
  }> = getLedger()
    .listActiveCadences()
    .filter((cad) => playMakesOffer(cad.play_name, cfg))
    .map((cad) => ({ cad, record: sequenceOfferOf(cad) }))
    .filter(({ cad, record }) => isProspectOffer(record.offer) && closeAhead(cad))
    .map(({ cad, record }) => {
      const thread: OfferThreadEmail[] = sequenceThread(cad.prospect_id, cad.play_name);
      return { cad, record, picked: pickCloseOffer(record, cfg, thread) };
    });
  summary.eligible = sequences.length;
  // Settled: the stored close is still the one picked, or the writer's none stands.
  const open = sequences.filter(({ record, picked }) =>
    picked ? picked !== record.closeOffer : hasBrief && record.closeSkip?.productHash !== hash,
  );
  summary.settled = sequences.length - open.length;
  const cap = resolveCap(opts.limit);
  const work = cap === undefined ? open : open.slice(0, cap);
  process.stdout.write(
    `${c.dim("emailed sequences with a LinkedIn close ahead:")} ${summary.eligible}  ${c.dim("settled:")} ${summary.settled}  ${c.dim("to do:")} ${work.length}\n`,
  );
  await parallelMap(work, opts.concurrency ?? 3, async ({ cad, picked }) => {
    const key = `sequence ${cad.prospect_id}/${cad.play_name}`;
    if (opts.dryRun) {
      (picked ? summary.picked : summary.written).push(key);
      process.stdout.write(
        `  ${key} ${picked ? short(picked.offer) : c.dim("(would write one)")}\n`,
      );
      return;
    }
    try {
      const out = await ensureCloseOffer({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        cfg,
        onCost: (usd) => {
          summary.costUsd += usd;
        },
      });
      if (out.status === "none") {
        if (out.reason === "error") summary.errors++;
        else summary.none.push(key);
        process.stdout.write(`  ${key} ${c.dim(`(none: ${out.reason})`)}\n`);
        return;
      }
      (out.status === "picked" ? summary.picked : summary.written).push(key);
      process.stdout.write(`  ${key} ${short(out.offer.offer)}\n`);
    } catch (err) {
      summary.errors++;
      warn(`${key}: ${((err as Error).message ?? "").slice(0, 120)}`);
    }
  });
  for (const list of [summary.picked, summary.written, summary.none]) list.sort();
  ok(
    `settled ${summary.settled} · ${opts.dryRun ? "would pick" : "picked"} ${summary.picked.length} · ${opts.dryRun ? "would write" : "written"} ${summary.written.length} · none ${summary.none.length} · errors ${summary.errors}` +
      (opts.dryRun ? " · nothing written" : ` · $${summary.costUsd.toFixed(2)}`),
  );
  return summary;
}
