/**
 * The offer a cadence carries: every follow-up restates it, so a sequence
 * without one has nothing to say but the founder's general terms.
 *
 * Where it lives, in the order it is read:
 * 1. The intro's step-0 sequence event (`offer`, `offerSteps`), when the
 *    first email carried an offer. That one always wins.
 * 2. The SENT queue row the intro went out from (`payload.offer` with its
 *    `offerCandidates`): the row's own offer, or one written for the
 *    sequence later (`patchSentQueueOffer`).
 *
 * A sequence that started before prospect offers existed gets one written
 * when its next follow-up is drafted (`deriveSequenceOffer`), from the same
 * research and the same writer and judge an intro's offer comes from, plus
 * the thread already sent, and it is stored on that sent row so every later
 * touch reads it back. A sequence with no sent queue row has nowhere to keep
 * one and gets none.
 */
import {
  getLedger,
  isPersonResearchDossier,
  loadConfig,
  logEvent,
  readPersonHalf,
  resolveTriggerOverlay,
  type ProspectRecord,
} from "@oneshot-gtm/core";
import { tryParseJsonObject } from "@oneshot-gtm/intel";
import { angleTextKey } from "./_angles.ts";
import {
  activeOfferPatch,
  ensureOfferSet,
  isProspectOffer,
  offerCandidatesOf,
  playMakesOffer,
  type OfferThreadEmail,
  type ProspectOffer,
} from "./_prospect-offer.ts";

type AppConfig = ReturnType<typeof loadConfig>;
type JsonRecord = Record<string, unknown>;

/**
 * An offer as a sequence holds it: the whole stored offer, or only its text
 * and steps when the intro's send record is all there is.
 */
export type SequenceOfferValue = Pick<ProspectOffer, "offer" | "steps"> & Partial<ProspectOffer>;

export interface SequenceOfferRecord {
  prospectId: number;
  playName: string;
  /** The sent queue row the intro went out from, where a written offer is stored; null when there is none. */
  queueRowId: number | null;
  /** The active offer, or null when the sequence has none. */
  offer: SequenceOfferValue | null;
  /** The ranked offers it came from (empty when only the intro's text is known). */
  offerCandidates: ProspectOffer[];
  /** True when the first email carried the offer (its step-0 send record names it). */
  introCarriedOffer: boolean;
}

interface SequenceRow {
  step_index: number;
  status?: string;
  metadata_json: string | null;
}

function sequenceRows(prospectId: number, playName: string): SequenceRow[] {
  try {
    return getLedger().listSequenceEventsForProspectPlay(prospectId, playName) as SequenceRow[];
  } catch {
    return [];
  }
}

function sentQueueRow(
  playName: string,
  email: string | null,
): { id: number | null; payload: JsonRecord; source: string } | null {
  const address = email?.trim();
  if (!address) return null;
  try {
    const ledger = getLedger() as ReturnType<typeof getLedger> & {
      latestSentQueueRow?: (
        p: string,
        e: string,
      ) => { id?: number; payload: JsonRecord; source: string } | null;
    };
    if (typeof ledger.latestSentQueueRow === "function") {
      const row = ledger.latestSentQueueRow(playName, address);
      return row ? { ...row, id: typeof row.id === "number" ? row.id : null } : null;
    }
    const payload = ledger.latestSentQueuePayload(playName, address);
    return payload ? { id: null, payload, source: "" } : null;
  } catch {
    return null;
  }
}

function prospectOf(prospectId: number): ProspectRecord | null {
  try {
    return getLedger().getProspectById(prospectId);
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The offer this cadence carries and the sent queue row that holds it. Never
 * throws: a ledger that can't answer reads as a sequence with no offer.
 */
export function sequenceOfferRecord(input: {
  prospectId: number;
  playName: string;
  /** The prospect row, when the caller holds it (saves a read). */
  prospect?: Pick<ProspectRecord, "id" | "email"> | null;
}): SequenceOfferRecord {
  const { prospectId, playName } = input;
  const prospect = input.prospect ?? prospectOf(prospectId);
  const step0 = sequenceRows(prospectId, playName).find((r) => r.step_index === 0);
  const meta = step0 ? tryParseJsonObject<JsonRecord>(step0.metadata_json ?? "", {}) : null;
  const queued = sentQueueRow(playName, prospect?.email ?? null);
  const queuedOffer = queued ? queued.payload["offer"] : null;
  const base = { prospectId, playName, queueRowId: queued?.id ?? null };

  const introText = text(meta?.["offer"]);
  if (introText) {
    // The intro's own offer. The sent row holds the whole of it (angles,
    // judge label) when it is the same one.
    const same =
      isProspectOffer(queuedOffer) && angleTextKey(queuedOffer.offer) === angleTextKey(introText);
    return {
      ...base,
      offer: same ? queuedOffer : { offer: introText, steps: text(meta?.["offerSteps"]) ?? "" },
      offerCandidates: same && queued ? offerCandidatesOf(queued.payload) : [],
      introCarriedOffer: true,
    };
  }
  if (isProspectOffer(queuedOffer) && queued) {
    return {
      ...base,
      offer: queuedOffer,
      offerCandidates: offerCandidatesOf(queued.payload),
      introCarriedOffer: false,
    };
  }
  return { ...base, offer: null, offerCandidates: [], introCarriedOffer: false };
}

/**
 * Make `offer` the sequence's active offer on its sent queue row. Replaces
 * the previous offer whole (`activeOfferPatch`), so an approval or judge
 * label the old one carried does not survive; with `merge`, patches the
 * stored offer key by key instead (an approval stamp). `expect` guards the
 * write on fields of the offer as stored (offer key → scalar, null: absent),
 * e.g. an approval bound to the offer the founder read. `offerCandidates`
 * absent keeps the stored list. False when nothing was written: no sent row,
 * the row changed, or a guard failed.
 */
export function writeSequenceOffer(input: {
  record: SequenceOfferRecord;
  offer: ProspectOffer | Record<string, unknown>;
  offerCandidates?: ProspectOffer[];
  merge?: boolean;
  expect?: Record<string, string | null>;
}): boolean {
  const { record } = input;
  if (record.queueRowId == null) return false;
  const offer = input.merge
    ? (input.offer as Record<string, unknown>)
    : activeOfferPatch(record.offer, input.offer as ProspectOffer, input.offerCandidates ?? [])
        .offer;
  const expect = Object.entries(input.expect ?? {}).map(([key, value]) => ({
    path: `$.offer.${key}`,
    value,
  }));
  try {
    return getLedger().patchSentQueueOffer({
      id: record.queueRowId,
      offer,
      ...(input.offerCandidates ? { offerCandidates: input.offerCandidates } : {}),
      ...(expect.length > 0 ? { expect } : {}),
    });
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "sequence-offer-write",
        play: record.playName,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return false;
  }
}

/**
 * Reads the firm's own pages for a sequence's offer, when the row has a
 * company domain and no page text yet. Registered by `@oneshot-gtm/find`
 * (queue-offer.ts), which owns company research and its spend cap; absent,
 * offers are written from what the row stores.
 */
export type SequenceOfferResearch = (input: {
  target: JsonRecord;
  playName: string;
  queueRowId: number;
  source: string;
}) => Promise<JsonRecord>;

let sequenceOfferResearch: SequenceOfferResearch | null = null;

export function registerSequenceOfferResearch(fn: SequenceOfferResearch | null): void {
  sequenceOfferResearch = fn;
}

/** The emails this sequence already sent, oldest first: the THREAD SO FAR an offer continues. */
export function sequenceThread(
  prospectId: number,
  playName: string,
  beforeStep?: number | null,
): OfferThreadEmail[] {
  const out: OfferThreadEmail[] = [];
  for (const row of sequenceRows(prospectId, playName)) {
    if (row.status === "skipped") continue;
    if (beforeStep != null && row.step_index >= beforeStep) continue;
    const meta = tryParseJsonObject<{ subject?: unknown; body?: unknown }>(
      row.metadata_json ?? "",
      {},
    );
    const body = text(meta.body);
    if (!body) continue;
    out.push({ subject: text(meta.subject) ?? "", body });
  }
  return out;
}

/**
 * The person half of the prospect's dossier: on the target as
 * `personResearch` when it is a research dossier the row lacks, else as the
 * writer's ENRICHMENT text.
 */
function withPersonResearch(
  target: JsonRecord,
  prospect: ProspectRecord | null,
): { target: JsonRecord; dossier: string | null } {
  const half = readPersonHalf(prospect?.dossier_json);
  if (!half) return { target, dossier: null };
  if (isPersonResearchDossier(half)) {
    return isPersonResearchDossier(target["personResearch"])
      ? { target, dossier: null }
      : { target: { ...target, personResearch: half }, dossier: null };
  }
  const raw = typeof half === "string" ? half : JSON.stringify(half);
  return { target, dossier: raw.trim() ? raw.slice(0, 4_000) : null };
}

export type DeriveSequenceOfferResult =
  | {
      /** `existing`: the sequence had one. `stored`: written now, on the sent row. */
      status: "existing" | "stored";
      record: SequenceOfferRecord;
      offer: SequenceOfferValue;
    }
  | {
      status: "none";
      record: SequenceOfferRecord;
      reason:
        | "no-play-offer"
        | "no-brief"
        | "no-queue-row"
        | "nothing-derived"
        | "not-stored"
        | "error";
    };

/**
 * The sequence's offer, written now when it has none (or always, with
 * `force`, except over the intro's own). Reads the firm's pages first when
 * the sent row has none (the registered research, within find's per-row
 * cap), then writes and judges the offers the way an intro's are
 * (`ensureOfferSet`), told the thread already sent, and stores them on the
 * sent row (`writeSequenceOffer`). An offer that could not be stored is not
 * returned: the next touch would not see it. Never throws.
 */
export async function deriveSequenceOffer(input: {
  prospectId: number;
  playName: string;
  /** Re-write it even when the sequence has one (never the intro's own). */
  force?: boolean;
  /** The step about to be drafted: the thread is every email before it. */
  stepIndex?: number | null;
  cfg?: AppConfig;
}): Promise<DeriveSequenceOfferResult> {
  const prospect = prospectOf(input.prospectId);
  const record = sequenceOfferRecord({ ...input, prospect });
  if (record.offer && (!input.force || record.introCarriedOffer)) {
    return { status: "existing", record, offer: record.offer };
  }
  if (!playMakesOffer(input.playName)) return { status: "none", record, reason: "no-play-offer" };
  const queued =
    record.queueRowId != null ? sentQueueRow(input.playName, prospect?.email ?? null) : null;
  if (!queued || queued.id == null) return { status: "none", record, reason: "no-queue-row" };
  try {
    const cfg = input.cfg ?? loadConfig();
    if (!cfg.productBrief?.trim()) return { status: "none", record, reason: "no-brief" };
    let target: JsonRecord = { ...queued.payload };
    // Written fresh: never the stored offer re-used under a new name.
    delete target["offer"];
    delete target["offerCandidates"];
    if (sequenceOfferResearch) {
      target = await sequenceOfferResearch({
        target,
        playName: input.playName,
        queueRowId: queued.id,
        source: queued.source,
      });
    }
    // The trigger's current edge, as an intro's offer is written with.
    try {
      target = resolveTriggerOverlay(target, queued.source, (name) => getLedger().getTrigger(name));
    } catch {
      // The stored edge stands.
    }
    const person = withPersonResearch(target, prospect);
    const thread = sequenceThread(input.prospectId, input.playName, input.stepIndex);
    const set = await ensureOfferSet({
      target: person.target,
      dossier: person.dossier,
      playName: input.playName,
      cfg,
      ...(thread.length > 0 ? { thread } : {}),
    });
    if (!set) {
      logEvent("sequence_offer.none", { play: input.playName, prospect_id: input.prospectId });
      return { status: "none", record, reason: "nothing-derived" };
    }
    const stored = writeSequenceOffer({
      record,
      offer: set.offer,
      offerCandidates: set.candidates,
    });
    logEvent("sequence_offer.derived", {
      play: input.playName,
      prospect_id: input.prospectId,
      queue_id: queued.id,
      stored,
      relevance: set.offer.relevance ?? null,
      offer_120: set.offer.offer.slice(0, 120),
    });
    if (!stored) return { status: "none", record, reason: "not-stored" };
    return {
      status: "stored",
      record: { ...record, offer: set.offer, offerCandidates: set.candidates },
      offer: set.offer,
    };
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "sequence-offer",
        play: input.playName,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return { status: "none", record, reason: "error" };
  }
}
