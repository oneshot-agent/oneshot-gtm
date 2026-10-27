import {
  getLedger,
  loadConfig,
  offerAnchorOf,
  offerExclusionsOf,
  parallelMap,
  safeParseJsonRecord,
  type QueueRow,
} from "@oneshot-gtm/core";
import { resolveQueueTarget } from "@oneshot-gtm/find";
import {
  activeOfferPatch,
  deriveOfferSet,
  deriveSequenceOffer,
  isOfferSkipped,
  isProspectOffer,
  judgementFields,
  judgeOffers,
  offerCandidatesOf,
  offerHoldsSend,
  offerOf,
  offerResearchText,
  playMakesOffer,
  prospectOfferInput,
  sequenceOfferOf,
  type OfferJudgement,
  type ProspectOffer,
} from "@oneshot-gtm/plays";
import { c, header, note, ok, resolveCap, warn } from "../output.ts";

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
 * The judge reads the workspace's `offerExclusions`, so an offer of a kind
 * the founder never offers is judged `irrelevant` (stored `weak`, so it holds
 * the send) and is replaced like any other failing offer. The founder's
 * approval of a weak offer (`weakApprovedAt`) does not keep an excluded one:
 * it is switched when another candidate passes, and loses the approval
 * when none does, so it is held and `--rewrite-all-weak` rewrites it.
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
  /** Rows whose active offer was judged of a kind in `offerExclusions` (switched or now held). */
  excluded: number[];
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
    excluded: [],
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
      // A weak offer the founder approved stays theirs: it is not swapped
      // out. An approval never keeps an offer of a kind the founder never offers.
      const approved =
        typeof active.weakApprovedAt === "string" &&
        !!active.weakApprovedAt.trim() &&
        verdict.excluded !== true;
      // Under `prefer-product` a passing product-anchored candidate is taken
      // ahead of an earlier passing firm-anchored one. Candidates written
      // before the writer emitted `anchor` carry none, so those rows fall
      // back to the first passing one exactly as before.
      const passing = next.map((_, i) => i).filter((i) => verdicts[i]?.pass === true);
      const preferred =
        offerAnchorOf(cfg) === "prefer-product"
          ? passing.find((i) => next[i]!.anchor === "product")
          : undefined;
      const first = approved ? -1 : (preferred ?? passing[0] ?? -1);
      if (first >= 0) {
        // Its angles if it has them; none leaves the key unset and drafting
        // writes them. An approval belongs to the offer it was given on.
        const { weakApprovedAt: _approval, ...picked } = next[first]!;
        offer = picked;
        outcome = "switched";
      } else if (verdict.excluded === true) {
        // Held, and open to `--rewrite-all-weak`: the approval was not given on this verdict.
        const { weakApprovedAt: _approval, ...held } = rejudged(active, verdict);
        offer = held;
        outcome = "weak";
      } else {
        offer = rejudged(active, verdict);
        outcome = "weak";
      }
    }
    const tag = verdict.excluded === true ? ` ${c.dim("(excluded)")}` : "";
    const line = `  #${row.id} ${outcome.padEnd(8)} ${short(offer.offer)}${tag}`;
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
        // Any concurrent edit (new angles, candidates) skips the row.
        expectPayloadJson: row.payload_json,
        // A draft written for the replaced offer must not go out.
        discardDraft: outcome === "switched",
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
    if (verdict.excluded === true) summary.excluded.push(row.id);
  });

  for (const list of [
    summary.lifted,
    summary.passing,
    summary.switched,
    summary.weak,
    summary.newlyHeld,
    summary.excluded,
  ]) {
    list.sort((a, b) => a - b);
  }
  ok(
    `judged ${summary.judged} · holds lifted ${summary.lifted.length} · still passing ${summary.passing.length}` +
      ` · active switched ${summary.switched.length} · still weak ${summary.weak.length}` +
      ` (newly held ${summary.newlyHeld.length}) · excluded ${summary.excluded.length}` +
      ` · skipped ${summary.skipped} · errors ${summary.errors}` +
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

/**
 * `--rewrite-all-weak`: write new offers for every live set the judge passed
 * none of, the way a fresh set is written (`deriveOfferSet`, with the rescue
 * round and the company research it reads). Queue rows: unsent, every
 * candidate weak, the active offer neither the founder's own nor approved
 * anyway. Active sequences the same, except an offer the first email
 * carried (it is fixed). The new set replaces the old whole
 * (`activeOfferPatch`), guarded on the active offer read here, and the
 * letter written around the old one is dropped. A dry run makes no model or
 * research call: it lists what would be rewritten.
 */
export interface RewriteWeakSummary {
  /** Queue rows and sequences whose every offer is weak. */
  eligible: number;
  /** Of `eligible`, the ones without complete company research: the rewrite reads it first. */
  unresearched: number;
  /** Rewritten, and the new active offer passes. */
  passing: string[];
  /** Rewritten, still weak: held as before. */
  weak: string[];
  /** Nothing written: the writer declined, wrote nothing, or the row or sequence moved on. */
  unchanged: string[];
  errors: number;
  /** What the model calls and research reads cost, in USD. */
  costUsd: number;
}

type WeakItem =
  | {
      kind: "row";
      key: string;
      row: QueueRow;
      payload: Record<string, unknown>;
      active: ProspectOffer;
      candidates: ProspectOffer[];
    }
  | {
      kind: "sequence";
      key: string;
      prospectId: number;
      playName: string;
      candidates: ProspectOffer[];
      researched: boolean;
    };

/** A label no send may go out on unreviewed: `weak`, or `irrelevant`. */
function failing(o: Pick<ProspectOffer, "relevance">): boolean {
  return o.relevance === "weak" || o.relevance === "irrelevant";
}

/** Every offer is weak or irrelevant, and the active one is no founder's text or approval. */
function allWeak(active: ProspectOffer | null, candidates: readonly ProspectOffer[]): boolean {
  if (!active || candidates.length === 0) return false;
  if (active.editedBy === "founder") return false;
  if (typeof active.weakApprovedAt === "string" && active.weakApprovedAt.trim()) return false;
  return failing(active) && candidates.every(failing);
}

function completeResearch(payload: Record<string, unknown> | null | undefined): boolean {
  const firm = payload?.["productResearch"];
  return (
    !!firm && typeof firm === "object" && (firm as Record<string, unknown>)["status"] === "complete"
  );
}

/** Live queue rows whose every offer is weak. */
export function selectAllWeakRows(rows: readonly QueueRow[]): WeakItem[] {
  const out: WeakItem[] = [];
  for (const { row, payload, active, candidates } of selectRejudgeRows(rows).eligible) {
    if (!allWeak(active, candidates)) continue;
    out.push({ kind: "row", key: `#${row.id}`, row, payload, active, candidates });
  }
  return out;
}

/** Active sequences whose every offer is weak; never one whose offer the first email carried. */
export function selectAllWeakSequences(
  cadences: ReadonlyArray<Parameters<typeof sequenceOfferOf>[0] & { status?: string }>,
  queuePayload: (prospectId: number, playName: string) => Record<string, unknown> | null,
): WeakItem[] {
  const out: WeakItem[] = [];
  for (const cadence of cadences) {
    if (cadence.status !== undefined && cadence.status !== "active") continue;
    if (!playMakesOffer(cadence.play_name)) continue;
    const record = sequenceOfferOf(cadence);
    if (record.introCarriedOffer || !isProspectOffer(record.offer)) continue;
    if (!allWeak(record.offer, record.offerCandidates)) continue;
    out.push({
      kind: "sequence",
      key: `sequence ${cadence.prospect_id}/${cadence.play_name}`,
      prospectId: cadence.prospect_id,
      playName: cadence.play_name,
      candidates: record.offerCandidates,
      researched: completeResearch(queuePayload(cadence.prospect_id, cadence.play_name)),
    });
  }
  return out;
}

export async function commandRewriteWeakOffers(
  opts: RejudgeOffersOpts,
): Promise<RewriteWeakSummary> {
  header(`rejudge-offers --rewrite-all-weak ${opts.dryRun ? c.dim("(dry run)") : ""}`);
  const ledger = getLedger();
  const cfg = loadConfig();
  const rows = (["pending", "approved"] as const).flatMap((status) =>
    ledger.listQueue({ status, limit: 100_000 }),
  );
  const items = [
    ...selectAllWeakRows(rows),
    ...selectAllWeakSequences(ledger.listActiveCadences(), (prospectId, playName) => {
      try {
        return ledger.cadenceQueueRow(prospectId, playName)?.payload ?? null;
      } catch {
        return null;
      }
    }),
  ];
  const cap = resolveCap(opts.limit);
  const work = cap === undefined ? items : items.slice(0, cap);
  const summary: RewriteWeakSummary = {
    eligible: items.length,
    unresearched: items.filter((i) =>
      i.kind === "row" ? !completeResearch(i.payload) : !i.researched,
    ).length,
    passing: [],
    weak: [],
    unchanged: [],
    errors: 0,
    costUsd: 0,
  };
  process.stdout.write(
    `${c.dim("all weak:")} ${summary.eligible}  ${c.dim("without complete company research:")} ` +
      `${summary.unresearched}  ${c.dim("to rewrite:")} ${work.length}\n`,
  );
  if (opts.dryRun) {
    for (const item of work) {
      const active = item.kind === "row" ? item.active.offer : (item.candidates[0]?.offer ?? "");
      process.stdout.write(`  ${item.key} ${short(active)}\n`);
    }
    ok(`${work.length} to rewrite · dry run — no model or research call made, nothing written.`);
    return summary;
  }
  const onCost = (usd: number): void => {
    summary.costUsd += usd;
  };
  await parallelMap(work, opts.concurrency ?? 3, async (item) => {
    const avoid = item.candidates.map((o) => o.offer);
    let outcome: "passing" | "weak" | "unchanged" = "unchanged";
    let text = "";
    try {
      if (item.kind === "row") {
        const set = await deriveOfferSet({
          target: edgeTarget(item.row, item.payload),
          playName: item.row.play_name,
          avoid,
          research: { queueRowId: item.row.id, source: item.row.source },
          onCost,
          cfg,
        });
        if (set && !isOfferSkipped(set)) {
          const prior = (key: keyof ProspectOffer): string | null => {
            const v = item.active[key];
            return typeof v === "string" ? v : null;
          };
          const written = ledger.patchLiveQueuePayload({
            id: item.row.id,
            patch: activeOfferPatch(item.active, set.offer, set.candidates),
            // The letter was written around the old offer.
            discardDraft: true,
            // Not the whole payload: the rewrite may have saved company research on it.
            expect: [
              { path: "$.offer.offer", value: item.active.offer },
              { path: "$.offer.derivedAt", value: prior("derivedAt") },
              { path: "$.offer.inputHash", value: prior("inputHash") },
              { path: "$.offer.relevance", value: prior("relevance") },
              { path: "$.offer.editedBy", value: null },
              { path: "$.offer.weakApprovedAt", value: null },
            ],
          });
          if (written) {
            outcome = offerHoldsSend(set.offer) ? "weak" : "passing";
            text = set.offer.offer;
          }
        }
      } else {
        const out = await deriveSequenceOffer({
          prospectId: item.prospectId,
          playName: item.playName,
          force: true,
          avoid,
          onCost,
          cfg,
        });
        if (out.status === "stored") {
          // The stored preview restates the old offer.
          ledger.discardCadenceDraft({
            prospectId: item.prospectId,
            playName: item.playName,
            reason: "regenerate",
          });
          outcome = offerHoldsSend(out.offer) ? "weak" : "passing";
          text = out.offer.offer;
        }
      }
    } catch (err) {
      summary.errors++;
      warn(`${item.key}: ${((err as Error).message ?? "").slice(0, 120)}`);
      return;
    }
    summary[outcome].push(item.key);
    process.stdout.write(
      `  ${item.key} ${outcome.padEnd(9)} ${short(text)}  ${c.dim(`$${summary.costUsd.toFixed(3)} so far`)}\n`,
    );
  });
  ok(
    `rewritten ${summary.passing.length + summary.weak.length} · now passing ${summary.passing.length}` +
      ` · still weak ${summary.weak.length} · unchanged ${summary.unchanged.length}` +
      ` · errors ${summary.errors} · cost $${summary.costUsd.toFixed(3)}`,
  );
  if (summary.passing.length + summary.weak.length > 0) {
    note("Rewritten rows' letters were dropped: they are drafted again around the new offer.");
  }
  return summary;
}

/**
 * `--list-excluded`: the active sequences whose offer the judge now rates of
 * a kind in `offerExclusions`. A sequence keeps the offer it is carrying, so
 * this lists and changes nothing: the founder decides on each one. Each
 * sequence's active offer is judged once, against the queue row it started
 * from (else the prospect), which costs one judge call per sequence.
 */
export interface ListExcludedSummary {
  /** Active sequences carrying an offer. */
  eligible: number;
  judged: number;
  /** `sequence <prospectId>/<play>` keys whose offer is of an excluded kind. */
  excluded: string[];
  errors: number;
}

export async function commandListExcludedOffers(
  opts: Pick<RejudgeOffersOpts, "limit" | "concurrency">,
): Promise<ListExcludedSummary> {
  header("rejudge-offers --list-excluded");
  const ledger = getLedger();
  const cfg = loadConfig();
  const summary: ListExcludedSummary = { eligible: 0, judged: 0, excluded: [], errors: 0 };
  if (offerExclusionsOf(cfg).length === 0) {
    note("No offerExclusions in this workspace's config: nothing is excluded.");
    return summary;
  }
  const sequences = ledger
    .listActiveCadences()
    .filter((cad) => playMakesOffer(cad.play_name))
    .map((cad) => ({ cad, record: sequenceOfferOf(cad) }))
    .filter(({ record }) => isProspectOffer(record.offer));
  summary.eligible = sequences.length;
  const cap = resolveCap(opts.limit);
  const work = cap === undefined ? sequences : sequences.slice(0, cap);
  process.stdout.write(
    `${c.dim("active sequences with an offer:")} ${summary.eligible}  ${c.dim("to judge:")} ${work.length}\n`,
  );
  await parallelMap(work, opts.concurrency ?? 3, async ({ cad, record }) => {
    const key = `sequence ${cad.prospect_id}/${cad.play_name}`;
    const offer = record.offer as ProspectOffer;
    try {
      let target: Record<string, unknown>;
      let dossier: string | null = null;
      const queued = ledger.cadenceQueueRow(cad.prospect_id, cad.play_name);
      if (queued) {
        target = queued.payload;
      } else {
        const input = prospectOfferInput(ledger.getProspectById(cad.prospect_id));
        target = input.target;
        dossier = input.dossier;
      }
      const verdicts = await judgeOffers([offer], offerResearchText(target, dossier), target, cfg);
      const v = verdicts?.[0] ?? null;
      if (!v) {
        summary.errors++;
        warn(`${key}: no judge engine gave a verdict`);
        return;
      }
      summary.judged++;
      if (v.excluded === true) {
        summary.excluded.push(key);
        const sent = record.introCarriedOffer ? " (sent in the first email)" : "";
        process.stdout.write(`  ${key} ${short(offer.offer)}${c.dim(sent)}\n`);
      }
    } catch (err) {
      summary.errors++;
      warn(`${key}: ${((err as Error).message ?? "").slice(0, 120)}`);
    }
  });
  summary.excluded.sort();
  ok(
    `judged ${summary.judged} · excluded ${summary.excluded.length} · errors ${summary.errors}` +
      " · nothing written: each sequence keeps its offer.",
  );
  return summary;
}
