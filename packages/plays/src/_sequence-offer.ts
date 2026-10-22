/**
 * The offer a cadence carries: every follow-up restates it, so a sequence
 * without one has nothing to say but the founder's general terms.
 *
 * The sequence owns it: `cadence_state.offer_json` (`{ offer, candidates,
 * origin }`), stamped at enrollment from the offer the first message made
 * (`enrollInCadence`) and changed afterwards only on the cadence
 * (`writeSequenceOffer` → `setCadenceOffer`), never on a queue row. Origin
 * `intro`: the first email carried it, and what was sent is fixed. Origin
 * `derived`: written or chosen for the sequence later. The cadence also
 * links the queue row it started from (`queue_id`), which is research
 * input for a written offer, never where the offer is kept.
 *
 * A sequence with no offer (one that started before prospect offers
 * existed, or a LinkedIn touch whose row had none) gets one written when its
 * next follow-up is drafted (`deriveSequenceOffer`), from the same research
 * and the same writer and judge an intro's offer comes from, plus the thread
 * already sent.
 */
import {
  getLedger,
  isPersonResearchDossier,
  loadConfig,
  logEvent,
  readPersonHalf,
  resolveTriggerOverlay,
  type CadenceWithProspect,
  type ProspectRecord,
} from "@oneshot-gtm/core";
import { tryParseJsonObject } from "@oneshot-gtm/intel";
import {
  ensureOfferSet,
  isProspectOffer,
  playMakesOffer,
  type OfferThreadEmail,
  type ProspectOffer,
} from "./_prospect-offer.ts";

type AppConfig = ReturnType<typeof loadConfig>;
type JsonRecord = Record<string, unknown>;

/**
 * An offer as a sequence holds it: the whole stored offer, or only its text
 * and steps when the intro's send record was all there was.
 */
export type SequenceOfferValue = Pick<ProspectOffer, "offer" | "steps"> & Partial<ProspectOffer>;

export interface SequenceOfferRecord {
  prospectId: number;
  playName: string;
  /** The queue row the sequence started from (`cadence_state.queue_id`); null when none is known. */
  queueRowId: number | null;
  /** The active offer, or null when the sequence has none. */
  offer: SequenceOfferValue | null;
  /** The ranked offers it came from (empty when only the intro's text is known). */
  offerCandidates: ProspectOffer[];
  /** True when the first email carried the offer (origin `intro`). */
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

/** The cadence's stored offer, read from its row: no ledger call. Never throws. */
export function sequenceOfferOf(
  cadence: Pick<CadenceWithProspect, "prospect_id" | "play_name" | "offer_json" | "queue_id">,
): SequenceOfferRecord {
  const stored = tryParseJsonObject<{ offer?: unknown; candidates?: unknown; origin?: unknown }>(
    cadence.offer_json ?? "",
    {},
  );
  const offer = stored.offer as SequenceOfferValue | undefined;
  const has =
    !!offer && typeof offer === "object" && !!text(offer.offer) && typeof offer.steps === "string";
  return {
    prospectId: cadence.prospect_id,
    playName: cadence.play_name,
    queueRowId: typeof cadence.queue_id === "number" ? cadence.queue_id : null,
    offer: has ? offer : null,
    offerCandidates:
      has && Array.isArray(stored.candidates) ? stored.candidates.filter(isProspectOffer) : [],
    introCarriedOffer: has && stored.origin === "intro",
  };
}

/**
 * The offer this cadence carries and the queue row it started from, read
 * from the cadence (`offer_json`, `queue_id`). Pass `cadence` when the
 * caller already holds the row (saves a read). Never throws: a ledger that
 * can't answer reads as a sequence with no offer.
 */
export function sequenceOfferRecord(input: {
  prospectId: number;
  playName: string;
  cadence?: Pick<CadenceWithProspect, "offer_json" | "queue_id"> | null;
}): SequenceOfferRecord {
  const { prospectId, playName } = input;
  let cadence = input.cadence ?? null;
  if (!cadence) {
    try {
      cadence = getLedger().getCadence(prospectId, playName);
    } catch {
      cadence = null;
    }
  }
  return sequenceOfferOf({
    prospect_id: prospectId,
    play_name: playName,
    offer_json: cadence?.offer_json ?? null,
    queue_id: cadence?.queue_id ?? null,
  });
}

/**
 * Make `offer` the sequence's active offer, on the cadence. Replaces the
 * stored offer whole, so an approval or judge label the old one carried does
 * not survive; with `merge`, patches the stored offer key by key instead (an
 * approval stamp). `expect` guards the write on fields of the offer as
 * stored (offer key → scalar, null: absent), e.g. an approval bound to the
 * offer the founder read. `offerCandidates` absent keeps the stored list.
 * Lands only while the cadence is active and holds no send, checked in the
 * same statement. False when nothing was written: a guard failed, the
 * cadence ended, or a send held it.
 */
export function writeSequenceOffer(input: {
  record: SequenceOfferRecord;
  offer: ProspectOffer | Record<string, unknown>;
  offerCandidates?: ProspectOffer[];
  merge?: boolean;
  expect?: Record<string, string | null>;
}): boolean {
  const { record } = input;
  try {
    return getLedger().setCadenceOffer({
      prospectId: record.prospectId,
      playName: record.playName,
      offer: input.offer as Record<string, unknown>,
      ...(input.offerCandidates ? { candidates: input.offerCandidates } : {}),
      ...(input.merge ? { merge: true } : { origin: "derived" as const }),
      ...(input.expect ? { expect: input.expect } : {}),
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
 * Reads the firm's own pages for a sequence's offer, when the queue row it
 * started from has a company domain and no page text yet. Registered by
 * `@oneshot-gtm/find` (sequence-offer-research.ts), which owns company
 * research and its per-row spend cap; absent, or for a sequence with no
 * row, offers are written from what is stored.
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

/**
 * What an offer for a sequence with no queue row is written from: the
 * prospect as the ledger knows them.
 */
function prospectTarget(prospect: ProspectRecord | null): JsonRecord {
  if (!prospect) return {};
  const out: JsonRecord = {};
  if (prospect.name) out["name"] = prospect.name;
  if (prospect.email) out["email"] = prospect.email;
  if (prospect.company) out["company"] = prospect.company;
  if (prospect.title) out["title"] = prospect.title;
  if (prospect.linkedin_url) out["linkedinUrl"] = prospect.linkedin_url;
  return out;
}

/**
 * What an offer for a sequence with no queue row is written from, the way
 * `deriveSequenceOffer` writes one: the prospect as the ledger knows them,
 * with their dossier's person half (on the target as `personResearch`, or as
 * the writer's ENRICHMENT text). No ledger read: pass the prospect row.
 */
export function prospectOfferInput(prospect: ProspectRecord | null): {
  target: JsonRecord;
  dossier: string | null;
} {
  return withPersonResearch(prospectTarget(prospect), prospect);
}

export type DeriveSequenceOfferResult =
  | {
      /** `existing`: the sequence had one. `stored`: written now, on the cadence. */
      status: "existing" | "stored";
      record: SequenceOfferRecord;
      offer: SequenceOfferValue;
    }
  | {
      status: "none";
      record: SequenceOfferRecord;
      reason: "no-play-offer" | "no-brief" | "nothing-derived" | "not-stored" | "error";
    };

/**
 * The sequence's offer, written now when it has none (or always, with
 * `force`, except over the intro's own). The research target is the queue
 * row the sequence started from, its firm's pages read first when it has
 * none (the registered research, within find's per-row cap), else the
 * prospect; the prospect's dossier tops either up. Writes and judges the
 * offers the way an intro's are (`ensureOfferSet`), told the thread already
 * sent, and stores them on the cadence (`writeSequenceOffer`), which a send
 * holding the cadence refuses (`not-stored`). An offer that could not be
 * stored is not returned: the next touch would not see it. Never throws.
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
  const record = sequenceOfferRecord(input);
  if (record.offer && (!input.force || record.introCarriedOffer)) {
    return { status: "existing", record, offer: record.offer };
  }
  if (!playMakesOffer(input.playName)) return { status: "none", record, reason: "no-play-offer" };
  try {
    const cfg = input.cfg ?? loadConfig();
    if (!cfg.productBrief?.trim()) return { status: "none", record, reason: "no-brief" };
    const prospect = prospectOf(input.prospectId);
    const ledger = getLedger();
    const queued = ledger.cadenceQueueRow(input.prospectId, input.playName);
    let target: JsonRecord = queued ? { ...queued.payload } : prospectTarget(prospect);
    // Written fresh: never the stored offer re-used under a new name.
    delete target["offer"];
    delete target["offerCandidates"];
    if (queued) {
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
        target = resolveTriggerOverlay(target, queued.source, (name) => ledger.getTrigger(name));
      } catch {
        // The stored edge stands.
      }
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
      queue_id: queued?.id ?? null,
      stored,
      relevance: set.offer.relevance ?? null,
      offer_120: set.offer.offer.slice(0, 120),
    });
    if (!stored) return { status: "none", record, reason: "not-stored" };
    return {
      status: "stored",
      record: {
        ...record,
        offer: set.offer,
        offerCandidates: set.candidates,
        introCarriedOffer: false,
      },
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
