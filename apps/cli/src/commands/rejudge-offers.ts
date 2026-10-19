import {
  getLedger,
  loadConfig,
  parallelMap,
  safeParseJsonRecord,
  type QueueRow,
} from "@oneshot-gtm/core";
import { resolveQueueTarget } from "@oneshot-gtm/find";
import {
  activeOfferPatch,
  judgementFields,
  judgeOffers,
  offerCandidatesOf,
  offerHoldsSend,
  offerOf,
  offerResearchText,
  playMakesOffer,
  type OfferJudgement,
  type ProspectOffer,
} from "@oneshot-gtm/plays";
import { c, header, note, ok, warn } from "../output.ts";

/**
 * Re-judge the offers stored on unsent queue rows with the workspace's
 * `offerJudge`, without writing any new offer. For a judge rule that changed
 * after the offers were written: the rows keep their offers and only the
 * verdicts move.
 *
 * Each candidate gets its new `relevance`, score, why and classifier, in the
 * stored order. The active offer stays active when it now passes (a hold on
 * it lifts, since the hold is read from `relevance`). When it still does not
 * pass but another candidate does, the first passing one becomes active,
 * with its angles if it has them, and the row is reported for a redraft: its
 * letter was written around the old offer. A founder-edited offer is never
 * judged or replaced.
 *
 * Writes go through `patchLiveQueuePayload`, bound to the active offer read
 * here, so a row that was sent, or whose offer changed while it was judged,
 * is skipped.
 */

export interface RejudgeOffersOpts {
  dryRun: boolean;
  limit?: number;
  concurrency?: number;
}

export type RejudgeOutcome = "lifted" | "passing" | "switched" | "weak";

export interface RejudgeOffersSummary {
  /** Unsent rows carrying offer candidates. */
  eligible: number;
  /** Rows the judge gave a verdict on. */
  judged: number;
  /** Held for a weak active offer, which now passes. */
  lifted: number[];
  /** Active offer passed before and still does. */
  passing: number[];
  /** Another candidate became active: the letter needs a redraft. */
  switched: number[];
  /** Nothing passes: the active offer is (or stays) held as weak. */
  weak: number[];
  /** Of `weak`, rows that were not held before this run. */
  newlyHeld: number[];
  /** Founder-edited, active offer not among the candidates, no verdict on it, or changed meanwhile. */
  skipped: number;
  errors: number;
}

const RELEVANCE_KEYS = [
  "relevance",
  "relevanceScore",
  "relevanceWhy",
  "relevanceClassifier",
] as const;

/** The offer with its stored verdict replaced by this one. */
function rejudged(offer: ProspectOffer, j: OfferJudgement): ProspectOffer {
  const next: Record<string, unknown> = { ...offer };
  for (const key of RELEVANCE_KEYS) delete next[key];
  return { ...(next as unknown as ProspectOffer), ...judgementFields(j) };
}

/** A bad `--limit` never widens a run: NaN collapses to 0. */
function resolveCap(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor(limit));
}

interface Eligible {
  row: QueueRow;
  payload: Record<string, unknown>;
  active: ProspectOffer;
  candidates: ProspectOffer[];
}

/** Unsent rows whose offers can be re-judged; founder-edited ones count as skipped. */
export function selectRejudgeRows(rows: readonly QueueRow[]): {
  eligible: Eligible[];
  founderEdited: number;
} {
  const eligible: Eligible[] = [];
  let founderEdited = 0;
  for (const row of rows) {
    if (row.sent_at != null || row.send_started_at != null) continue;
    if (!playMakesOffer(row.play_name)) continue;
    const payload = safeParseJsonRecord(row.payload_json);
    if (!payload) continue;
    const candidates = offerCandidatesOf(payload);
    const active = offerOf(payload);
    if (candidates.length === 0 || !active) continue;
    if (active.editedBy === "founder") {
      founderEdited++;
      continue;
    }
    eligible.push({ row, payload, active, candidates });
  }
  return { eligible, founderEdited };
}

function edgeTarget(row: QueueRow, payload: Record<string, unknown>): Record<string, unknown> {
  try {
    const t = resolveQueueTarget(row, { offerAngles: false });
    return t && typeof t === "object" && !Array.isArray(t)
      ? (t as Record<string, unknown>)
      : payload;
  } catch {
    return payload;
  }
}

function short(text: string): string {
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

export async function commandRejudgeOffers(opts: RejudgeOffersOpts): Promise<RejudgeOffersSummary> {
  header(`rejudge-offers ${opts.dryRun ? c.dim("(dry run)") : ""}`);
  const ledger = getLedger();
  const cfg = loadConfig();
  const rows = (["pending", "approved"] as const).flatMap((status) =>
    ledger.listQueue({ status, limit: 100_000 }),
  );
  const { eligible, founderEdited } = selectRejudgeRows(rows);
  const cap = resolveCap(opts.limit);
  const work = cap === undefined ? eligible : eligible.slice(0, cap);
  const summary: RejudgeOffersSummary = {
    eligible: eligible.length + founderEdited,
    judged: 0,
    lifted: [],
    passing: [],
    switched: [],
    weak: [],
    newlyHeld: [],
    skipped: founderEdited,
    errors: 0,
  };
  process.stdout.write(
    `${c.dim("engine:")} ${cfg.offerJudge?.engine ?? "llm"}  ${c.dim("rows with offers:")} ${summary.eligible}` +
      `  ${c.dim("founder-edited:")} ${founderEdited}  ${c.dim("to judge:")} ${work.length}\n`,
  );
  if (work.length === 0) {
    note("Nothing to judge.");
    return summary;
  }

  await parallelMap(work, opts.concurrency ?? 3, async ({ row, payload, active, candidates }) => {
    const activeIndex = candidates.findIndex((o) => o.offer === active.offer);
    if (activeIndex < 0) {
      summary.skipped++;
      return;
    }
    let verdicts: Array<OfferJudgement | null> | null;
    try {
      // The research the writer judged against: the row with the trigger's
      // current edge, as `ensureQueueRowOffer` gives `deriveOffers` (and,
      // like it, the bare payload when the trigger cannot be read).
      const target = edgeTarget(row, payload);
      verdicts = await judgeOffers(candidates, offerResearchText(target), target, cfg);
    } catch (err) {
      summary.errors++;
      warn(`#${row.id}: ${((err as Error).message ?? "").slice(0, 120)}`);
      return;
    }
    if (!verdicts) {
      summary.errors++;
      warn(`#${row.id}: no judge engine gave a verdict`);
      return;
    }
    const verdict = verdicts[activeIndex] ?? null;
    if (!verdict) {
      summary.skipped++;
      return;
    }
    summary.judged++;
    const next = candidates.map((o, i) => {
      const j = verdicts[i] ?? null;
      return j ? rejudged(o, j) : o;
    });
    const wasHeld = offerHoldsSend(active);
    let offer: ProspectOffer;
    let outcome: RejudgeOutcome;
    if (verdict.pass) {
      // Built from the stored active offer, so its own angles stay.
      offer = rejudged(active, verdict);
      outcome = wasHeld ? "lifted" : "passing";
    } else {
      // A weak offer the founder approved stays theirs: it is not swapped out.
      const approved = typeof active.weakApprovedAt === "string" && !!active.weakApprovedAt.trim();
      const first = approved ? -1 : next.findIndex((_, i) => verdicts[i]?.pass === true);
      if (first >= 0) {
        // Its angles if it has them; none leaves the key unset and drafting
        // writes them. An approval belongs to the offer it was given on.
        const { weakApprovedAt: _approval, ...picked } = next[first]!;
        offer = picked;
        outcome = "switched";
      } else {
        offer = rejudged(active, verdict);
        outcome = "weak";
      }
    }
    const line = `  #${row.id} ${outcome.padEnd(8)} ${short(offer.offer)}`;
    if (opts.dryRun) {
      process.stdout.write(`${line}\n`);
    } else {
      const text = (key: keyof ProspectOffer): string | null => {
        const v = active[key];
        return typeof v === "string" ? v : null;
      };
      const written = ledger.patchLiveQueuePayload({
        id: row.id,
        patch: activeOfferPatch(active, offer, next),
        expect: [
          { path: "$.offer.offer", value: active.offer },
          { path: "$.offer.derivedAt", value: text("derivedAt") },
          { path: "$.offer.inputHash", value: text("inputHash") },
          { path: "$.offer.relevance", value: text("relevance") },
          { path: "$.offer.editedBy", value: null },
        ],
      });
      if (!written) {
        // Sent, sending, or its offer changed since it was read.
        summary.judged--;
        summary.skipped++;
        return;
      }
      process.stdout.write(`${line}\n`);
    }
    summary[outcome].push(row.id);
    if (outcome === "weak" && !wasHeld && offerHoldsSend(offer)) summary.newlyHeld.push(row.id);
  });

  for (const list of [summary.lifted, summary.passing, summary.switched, summary.weak]) {
    list.sort((a, b) => a - b);
  }
  summary.newlyHeld.sort((a, b) => a - b);
  ok(
    `judged ${summary.judged} · holds lifted ${summary.lifted.length} · still passing ${summary.passing.length}` +
      ` · active switched ${summary.switched.length} · still weak ${summary.weak.length}` +
      ` (newly held ${summary.newlyHeld.length}) · skipped ${summary.skipped} · errors ${summary.errors}` +
      (opts.dryRun ? " · dry run — nothing written." : ""),
  );
  if (summary.switched.length > 0) {
    note(
      `${opts.dryRun ? "would need" : "need"} a redraft (active offer switched): ${summary.switched
        .map((id) => `#${id}`)
        .join(", ")}`,
    );
  }
  return summary;
}
